/**
 * history – reading recorded sessions back without any API call (point 15).
 * getSessionMessages / getSessionInfo / listSessions / listSubagents / getSubagentMessages on the
 * sessions of the other scenarios: which fields does the history carry (tool_use_result,
 * timestamps, parent_tool_use_id)? Does `dir` matter, incl. drive-letter case? Is
 * CLAUDE_CONFIG_DIR read per call (process.env swap) and per worker_threads env?
 */
import {
  getSessionInfo,
  getSessionMessages,
  getSubagentMessages,
  listSessions,
  listSubagents,
  type SessionMessage,
} from '@anthropic-ai/claude-agent-sdk';
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { performance } from 'node:perf_hooks';
import { Worker } from 'node:worker_threads';
import type { RunContext, SessionRecord } from '../context';
import { describeError } from '../session';
import { spikeProjectFolders, summarizeTranscript } from '../transcripts';
import type { FixtureRecorder } from '../writer';
import { newRecorder, writeFixture, type Scenario } from './common';

const DESCRIPTION =
  'No live session: getSessionMessages/getSessionInfo/listSessions/listSubagents/getSubagentMessages ' +
  'on the recorded sessions; dir and drive-letter case; CLAUDE_CONFIG_DIR per call and per worker.';

/** Scenarios whose history is stored in full (the others only as a summary). */
const FULL_HISTORY = new Set(['permissions', 'subagent', 'plan-mode', 'ask-user-question']);

function swapDriveCase(cwd: string): string {
  const first = cwd.charAt(0);
  return `${first === first.toLowerCase() ? first.toUpperCase() : first.toLowerCase()}${cwd.slice(1)}`;
}

function summarize(messages: readonly SessionMessage[]): Record<string, unknown> {
  const keys = new Set<string>();
  const messageKeys = new Set<string>();
  let withParentToolUse = 0;
  for (const message of messages) {
    for (const key of Object.keys(message)) keys.add(key);
    if (typeof message.message === 'object' && message.message !== null) {
      for (const key of Object.keys(message.message)) messageKeys.add(key);
    }
    if (message.parent_tool_use_id !== null) withParentToolUse += 1;
  }
  return {
    count: messages.length,
    types: messages.map((message) => message.type),
    keys: [...keys].sort(),
    messageKeys: [...messageKeys].sort(),
    withParentToolUse,
  };
}

async function timed<T>(
  rec: FixtureRecorder,
  fn: string,
  args: unknown[],
  body: () => Promise<T>,
  map?: (value: T) => unknown,
): Promise<T | undefined> {
  const started = performance.now();
  try {
    const result = await body();
    rec.record('call', {
      fn,
      args,
      result: map === undefined ? result : map(result),
      ms: Math.round(performance.now() - started),
    });
    return result;
  } catch (error) {
    rec.record('call', {
      fn,
      args,
      error: describeError(error),
      ms: Math.round(performance.now() - started),
    });
    return undefined;
  }
}

const WORKER_SOURCE = `
const { parentPort, workerData } = require('node:worker_threads');
(async () => {
  const out = { configDir: process.env.CLAUDE_CONFIG_DIR ?? null };
  try {
    const sdk = await import(workerData.sdkUrl);
    out.messages = (await sdk.getSessionMessages(workerData.sessionId)).length;
    out.info = (await sdk.getSessionInfo(workerData.sessionId)) !== undefined;
    out.sessionsForDir = (await sdk.listSessions({ dir: workerData.cwd })).length;
  } catch (error) {
    out.error = String((error && error.message) || error);
  }
  parentPort.postMessage(out);
})();
`;

function runWorker(env: NodeJS.ProcessEnv, data: Record<string, string>): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const worker = new Worker(WORKER_SOURCE, { eval: true, env, workerData: data });
    worker.once('message', (message: unknown) => {
      resolve(message);
      void worker.terminate();
    });
    worker.once('error', reject);
  });
}

function latestPerScenario(ctx: RunContext): SessionRecord[] {
  const latest = new Map<string, SessionRecord>();
  for (const record of ctx.state.sessions) {
    if (record.sessionIds.length > 0) latest.set(record.scenario, record);
  }
  return [...latest.values()];
}

export const history: Scenario = {
  name: 'history',
  description: DESCRIPTION,
  live: false,
  async run(ctx) {
    const rec = newRecorder(ctx, 'history', DESCRIPTION);
    const sessions = latestPerScenario(ctx);
    rec.options = {
      note: 'no live session; reads <configDir>/projects of the recorded spike sessions',
      sessions: sessions.map((record) => ({
        scenario: record.scenario,
        sessionIds: record.sessionIds,
        cwd: record.cwd,
      })),
    };

    for (const record of sessions) {
      const id = record.sessionIds[0];
      if (id === undefined) continue;
      rec.mark('session', { scenario: record.scenario, sessionId: id, allIds: record.sessionIds });
      const full = FULL_HISTORY.has(record.scenario);
      await timed(
        rec,
        'getSessionMessages',
        [id],
        () => getSessionMessages(id),
        (value) => (full ? value : summarize(value)),
      );
      if (full) {
        await timed(rec, 'getSessionMessages.summary', [id], () => getSessionMessages(id), summarize);
      }
      await timed(
        rec,
        'getSessionMessages',
        [id, { includeSystemMessages: true }],
        () => getSessionMessages(id, { includeSystemMessages: true }),
        summarize,
      );
      await timed(
        rec,
        'getSessionMessages',
        [id, { dir: record.cwd }],
        () => getSessionMessages(id, { dir: record.cwd }),
        summarize,
      );
      const swapped = swapDriveCase(record.cwd);
      await timed(
        rec,
        'getSessionMessages',
        [id, { dir: swapped }],
        () => getSessionMessages(id, { dir: swapped }),
        summarize,
      );
      await timed(rec, 'getSessionInfo', [id], () => getSessionInfo(id));
      await timed(rec, 'getSessionInfo', [id, { dir: swapped }], () => getSessionInfo(id, { dir: swapped }));
      await timed(rec, 'listSessions', [{ dir: record.cwd }], () => listSessions({ dir: record.cwd }));
      await timed(rec, 'transcript.summary', [id], () => Promise.resolve(summarizeTranscript(id) ?? null));
      for (const extra of record.sessionIds.slice(1)) {
        await timed(rec, 'transcript.summary', [extra], () =>
          Promise.resolve(summarizeTranscript(extra) ?? null),
        );
      }
      if (record.scenario === 'subagent') {
        const agents = await timed(rec, 'listSubagents', [id], () => listSubagents(id));
        for (const agentId of agents ?? []) {
          await timed(rec, 'getSubagentMessages', [id, agentId], () => getSubagentMessages(id, agentId));
        }
      }
    }

    // CLAUDE_CONFIG_DIR: process.env swap in this process, then isolated worker envs.
    const probe = sessions.find((record) => record.scenario === 'permissions') ?? sessions[0];
    const probeId = probe?.sessionIds[0];
    if (probe !== undefined && probeId !== undefined) {
      const empty = mkdtempSync(path.join(os.tmpdir(), 'parallax-spike-emptycfg-'));
      const previous = process.env.CLAUDE_CONFIG_DIR;
      rec.mark('config-dir-test', { sessionId: probeId, emptyConfigDir: empty });
      await timed(rec, 'configDir.process.default', [probeId], async () => ({
        messages: (await getSessionMessages(probeId)).length,
      }));
      process.env.CLAUDE_CONFIG_DIR = empty;
      try {
        await timed(rec, 'configDir.process.swappedToEmpty', [probeId], async () => ({
          messages: (await getSessionMessages(probeId)).length,
          info: (await getSessionInfo(probeId)) !== undefined,
          sessionsForDir: (await listSessions({ dir: probe.cwd })).length,
        }));
      } finally {
        if (previous === undefined) Reflect.deleteProperty(process.env, 'CLAUDE_CONFIG_DIR');
        else process.env.CLAUDE_CONFIG_DIR = previous;
      }
      await timed(rec, 'configDir.process.restored', [probeId], async () => ({
        messages: (await getSessionMessages(probeId)).length,
      }));
      const data = {
        sdkUrl: import.meta.resolve('@anthropic-ai/claude-agent-sdk'),
        sessionId: probeId,
        cwd: probe.cwd,
      };
      await timed(rec, 'configDir.worker.emptyEnv', [probeId], () =>
        runWorker({ ...process.env, CLAUDE_CONFIG_DIR: empty }, data),
      );
      await timed(rec, 'configDir.worker.inheritedEnv', [probeId], () => runWorker({ ...process.env }, data));
      rmSync(empty, { recursive: true, force: true });
    }

    await timed(rec, 'projects.spikeFolders', [], () => Promise.resolve(spikeProjectFolders()));
    writeFixture(ctx, rec);
  },
};
