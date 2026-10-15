import { mkdtemp, rm } from 'node:fs/promises';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { SAMPLE_IDS } from '@shared/samples';
import type { LaunchSpec } from '../../claude/ports';
import { createHistoryPool, DEFAULT_CONFIG_DIR_KEY, defaultSdkModuleUrl, historyWorkerKey } from './pool';

/**
 * Fake SDK as a data: URL module, loaded by the REAL worker (worker_threads, eval source). Every
 * answer carries the worker's `CLAUDE_CONFIG_DIR` and `threadId`, so the tests can see env
 * isolation and worker restarts. Special session ids: `hang` never answers, `crash` ends the
 * worker thread, `boom` throws.
 */
const FAKE_SDK = `
import { threadId } from 'node:worker_threads';
const renamed = new Map();
const where = () => ({ configDir: process.env.CLAUDE_CONFIG_DIR ?? null, threadId });
export async function getSessionMessages(sessionId) {
  if (sessionId === 'hang') return new Promise(() => {});
  if (sessionId === 'crash') process.exit(3);
  if (sessionId === 'boom') throw new TypeError('boom from the sdk');
  return [{ type: 'user', uuid: 'u-' + sessionId, session_id: sessionId, message: { role: 'user', content: 'hi' },
    parent_tool_use_id: null, timestamp: '2026-10-15T08:00:00.000Z', ...where() }];
}
export async function listSubagents(sessionId) { return ['agent-1', 'agent-2']; }
export async function getSubagentMessages(sessionId, agentId) { return [{ sessionId, agentId, ...where() }]; }
export async function getSessionInfo(sessionId) {
  if (sessionId === 'missing') return undefined;
  return { sessionId, summary: renamed.get(sessionId) ?? 'AI title', customTitle: renamed.get(sessionId),
    lastModified: 1, ...where() };
}
export async function renameSession(sessionId, title) { renamed.set(sessionId, title); }
`;
const FAKE_SDK_URL = `data:text/javascript,${encodeURIComponent(FAKE_SDK)}`;

function launch(configDir: string | null, env: Record<string, string> = {}): LaunchSpec {
  return {
    profileId: SAMPLE_IDS.profile,
    executablePath: 'C:\\fake\\claude.exe',
    executableVersion: null,
    env: configDir === null ? { ...env } : { ...env, CLAUDE_CONFIG_DIR: configDir },
    configDir,
    sdkOptions: {},
    extraArgs: {},
    allowDangerouslySkipPermissions: false,
    autoCompactWindow: null,
    contextWindow: null,
  };
}

interface Where {
  configDir: string | null;
  threadId: number;
}

function whereOf(result: unknown): Where {
  const first: unknown = Array.isArray(result) ? result[0] : result;
  if (typeof first !== 'object' || first === null) throw new Error('unexpected result');
  const configDir = 'configDir' in first ? first.configDir : undefined;
  const threadId = 'threadId' in first ? first.threadId : undefined;
  if (typeof threadId !== 'number') throw new Error('threadId missing');
  return { configDir: typeof configDir === 'string' ? configDir : null, threadId };
}

const pools: { dispose(): Promise<void> }[] = [];
function pool(options: { idleMs?: number; timeoutMs?: number } = {}): ReturnType<typeof createHistoryPool> {
  const created = createHistoryPool({ sdkModuleUrl: FAKE_SDK_URL, ...options });
  pools.push(created);
  return created;
}

/**
 * The pool's timers (request timeout, idle end) run on a fake clock; worker start-up and messages
 * stay real. So no assertion depends on how fast a worker starts under load (CI, parallel agents).
 */
function useFakeClock(): void {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
}

/** Settles `promise` into a probe that can be checked without awaiting it. */
function probe(promise: Promise<unknown>): {
  readonly state: 'pending' | 'resolved' | 'rejected';
  readonly error: unknown;
} {
  const result: { state: 'pending' | 'resolved' | 'rejected'; error: unknown } = {
    state: 'pending',
    error: null,
  };
  promise.then(
    () => {
      result.state = 'resolved';
    },
    (error: unknown) => {
      result.state = 'rejected';
      result.error = error;
    },
  );
  return result;
}

/** Real workers need real time; generous limits keep the tests stable under parallel load. */
const WORKER_TEST_TIMEOUT_MS = 60_000;

afterEach(async () => {
  vi.useRealTimers();
  await Promise.all(pools.splice(0).map((p) => p.dispose()));
});

describe('historyWorkerKey', () => {
  it('uses the env CLAUDE_CONFIG_DIR, compared like Windows paths', () => {
    expect(historyWorkerKey(launch('C:\\Users\\x\\.claude-work\\'))).toBe('c:\\users\\x\\.claude-work');
    expect(historyWorkerKey(launch('c:/users/X/.claude-work'))).toBe('c:\\users\\x\\.claude-work');
    expect(historyWorkerKey(launch(null))).toBe(DEFAULT_CONFIG_DIR_KEY);
    expect(historyWorkerKey(launch(null, { claude_config_dir: 'D:\\cfg' }))).toBe('d:\\cfg');
  });
});

describe('defaultSdkModuleUrl', () => {
  it('points at the installed sdk.mjs', () => {
    expect(defaultSdkModuleUrl()).toMatch(/^file:\/\/.*claude-agent-sdk\/sdk\.mjs$/);
  });
});

describe('createHistoryPool with the installed SDK', { timeout: WORKER_TEST_TIMEOUT_MS }, () => {
  it('imports sdk.mjs in the eval worker (empty temp config dir, no claude process)', async () => {
    const home = process.env.PARALLAX_HOME;
    if (home === undefined) throw new Error('PARALLAX_HOME is set by test/setup');
    const configDir = await mkdtemp(path.join(home, 'history-config-'));
    const p = createHistoryPool();
    pools.push(p);
    const l = launch(configDir);
    expect(await p.run(l, { op: 'messages', sessionId: SAMPLE_IDS.sessionId })).toEqual([]);
    expect(await p.run(l, { op: 'info', sessionId: SAMPLE_IDS.sessionId })).toBeNull();
    await p.dispose();
    await rm(configDir, { recursive: true, force: true });
  });
});

describe(
  'createHistoryPool (real worker_threads, data: URL SDK)',
  { timeout: WORKER_TEST_TIMEOUT_MS },
  () => {
    it('maps every op to the SDK call and returns the raw result', async () => {
      const p = pool();
      const l = launch('C:\\cfg\\a');
      const messages = await p.run(l, { op: 'messages', sessionId: 's1' });
      expect(messages).toEqual([
        expect.objectContaining({
          type: 'user',
          uuid: 'u-s1',
          session_id: 's1',
          timestamp: '2026-10-15T08:00:00.000Z',
        }),
      ]);
      expect(await p.run(l, { op: 'subagents', sessionId: 's1' })).toEqual(['agent-1', 'agent-2']);
      expect(await p.run(l, { op: 'subagentMessages', sessionId: 's1', agentId: 'agent-2' })).toEqual([
        expect.objectContaining({ sessionId: 's1', agentId: 'agent-2' }),
      ]);
      expect(await p.run(l, { op: 'info', sessionId: 's1' })).toEqual(
        expect.objectContaining({ sessionId: 's1', summary: 'AI title' }),
      );
      expect(await p.run(l, { op: 'info', sessionId: 'missing' })).toBeNull();
      expect(await p.run(l, { op: 'rename', sessionId: 's1', title: 'Neu' })).toBeNull();
      expect(await p.run(l, { op: 'info', sessionId: 's1' })).toEqual(
        expect.objectContaining({ summary: 'Neu', customTitle: 'Neu' }),
      );
      expect(p.size).toBe(1);
    });

    it('isolates CLAUDE_CONFIG_DIR per worker and never touches the main env', async () => {
      const before = process.env.CLAUDE_CONFIG_DIR;
      const p = pool();
      const [a, b, defaultDir] = await Promise.all([
        p.run(launch('C:\\cfg\\a'), { op: 'messages', sessionId: 's' }),
        p.run(launch('C:\\cfg\\b'), { op: 'messages', sessionId: 's' }),
        p.run(launch(null), { op: 'messages', sessionId: 's' }),
      ]);
      expect(whereOf(a).configDir).toBe('C:\\cfg\\a');
      expect(whereOf(b).configDir).toBe('C:\\cfg\\b');
      expect(whereOf(defaultDir).configDir).toBeNull();
      expect(new Set([whereOf(a).threadId, whereOf(b).threadId, whereOf(defaultDir).threadId]).size).toBe(3);
      expect(p.size).toBe(3);
      // Same dir in another spelling → the same worker.
      const again = await p.run(launch('c:/CFG/a/'), { op: 'messages', sessionId: 's' });
      expect(whereOf(again).threadId).toBe(whereOf(a).threadId);
      expect(p.size).toBe(3);
      expect(process.env.CLAUDE_CONFIG_DIR).toBe(before);
    });

    it('rejects with the SDK error name and message', async () => {
      const p = pool();
      await expect(p.run(launch(null), { op: 'messages', sessionId: 'boom' })).rejects.toMatchObject({
        name: 'TypeError',
        message: 'boom from the sdk',
      });
      // The worker survives a rejected call.
      expect(p.size).toBe(1);
      await expect(p.run(launch(null), { op: 'subagents', sessionId: 's' })).resolves.toEqual([
        'agent-1',
        'agent-2',
      ]);
    });

    it('times out, replaces the worker and serves the next request from a new one', async () => {
      useFakeClock();
      const p = pool({ timeoutMs: 400 });
      const l = launch('C:\\cfg\\t');
      // Worker start-up and answers take real time; the 400 ms only run on the fake clock.
      const first = whereOf(await p.run(l, { op: 'messages', sessionId: 's' }));
      const hanging = probe(p.run(l, { op: 'messages', sessionId: 'hang' }));
      await vi.advanceTimersByTimeAsync(399);
      expect(hanging.state).toBe('pending');
      expect(p.size).toBe(1);
      await vi.advanceTimersByTimeAsync(1);
      expect(hanging.state).toBe('rejected');
      expect(hanging.error).toBeInstanceOf(Error);
      expect(hanging.error instanceof Error ? hanging.error.message : '').toBe(
        'history messages timed out after 400 ms',
      );
      expect(p.size).toBe(0);
      const second = whereOf(await p.run(l, { op: 'messages', sessionId: 's' }));
      expect(second.threadId).not.toBe(first.threadId);
      expect(second.configDir).toBe('C:\\cfg\\t');
    });

    it('rejects pending requests when the worker dies and restarts on the next request', async () => {
      const p = pool();
      const l = launch(null);
      const first = whereOf(await p.run(l, { op: 'messages', sessionId: 's' }));
      await expect(p.run(l, { op: 'messages', sessionId: 'crash' })).rejects.toThrow(/exited \(code 3\)/);
      expect(p.size).toBe(0);
      const second = whereOf(await p.run(l, { op: 'messages', sessionId: 's' }));
      expect(second.threadId).not.toBe(first.threadId);
    });

    it('ends an idle worker', async () => {
      useFakeClock();
      const p = pool({ idleMs: 100 });
      const l = launch(null);
      const first = whereOf(await p.run(l, { op: 'messages', sessionId: 's' }));
      await vi.advanceTimersByTimeAsync(99);
      expect(p.size).toBe(1);
      await vi.advanceTimersByTimeAsync(1);
      expect(p.size).toBe(0);
      const second = whereOf(await p.run(l, { op: 'messages', sessionId: 's' }));
      expect(second.threadId).not.toBe(first.threadId);
    });

    it('keeps a busy worker past the idle time', async () => {
      useFakeClock();
      const p = pool({ idleMs: 100, timeoutMs: 5_000 });
      const l = launch(null);
      await p.run(l, { op: 'messages', sessionId: 's' });
      const hanging = probe(p.run(l, { op: 'messages', sessionId: 'hang' }));
      await vi.advanceTimersByTimeAsync(4_999);
      expect(p.size).toBe(1);
      expect(hanging.state).toBe('pending');
      await p.dispose();
      await vi.advanceTimersByTimeAsync(0);
      expect(hanging.state).toBe('rejected');
      expect(hanging.error instanceof Error ? hanging.error.message : '').toBe('history pool disposed');
    });

    it('dispose ends all workers, rejects pending and later requests', async () => {
      const p = pool();
      await Promise.all([
        p.run(launch('C:\\cfg\\a'), { op: 'messages', sessionId: 's' }),
        p.run(launch('C:\\cfg\\b'), { op: 'messages', sessionId: 's' }),
      ]);
      const pending = expect(
        p.run(launch('C:\\cfg\\a'), { op: 'messages', sessionId: 'hang' }),
      ).rejects.toThrow('history pool disposed');
      expect(p.size).toBe(2);
      await p.dispose();
      expect(p.size).toBe(0);
      await pending;
      await expect(p.run(launch(null), { op: 'messages', sessionId: 's' })).rejects.toThrow(
        'history pool disposed',
      );
    });
  },
);
