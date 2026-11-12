/**
 * Step 2 of `pnpm cli-check` (WP-62): ONE small live SDK session against the installed `claude` –
 * Haiku, one mini prompt, one turn – that collects `system/init`, `initializationResult()`,
 * `supportedModels()` and `getContextUsage()` (observation.ts).
 *
 * The session is built like a real Parallax start: launch spec of the profile "Standard"
 * (`launchSpecFor`: resolveClaude, buildEnv – no variables of the calling Claude session, C.2) and
 * `buildQueryOptions` (backend/sdkOptions.ts), spawned through `createSpawner` (spawnHidden,
 * windowsHide, only the resolved .exe). Deliberately different, so the profile shows the CLI and not
 * the user's configuration: `settingSources: []` (no user/project settings, plugins, CLAUDE.md),
 * `strictMcpConfig` + `disableClaudeAiConnectors` (no MCP servers), `maxTurns: 1`, every tool denied,
 * no permission mode (the CLI default is part of the profile).
 *
 * Guards like the recorder (ADR-011): `apiKeySource` must be `none`, the model Haiku; auth/billing
 * errors, `credits_required`, a rejected rate limit, a startup failure or a cost above the budget
 * stop at once (ProbeStop, exit 2 – never retried).
 */
import {
  query,
  type CanUseTool,
  type Query,
  type SDKUserMessage,
} from '@anthropic-ai/claude-agent-sdk';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import type { LaunchSpec } from '../../src/server/claude/ports';
import { withTimeout } from '../../src/server/backend/sdkBackend';
import { buildQueryOptions } from '../../src/server/backend/sdkOptions';
import { createSpawner } from '../../src/server/backend/spawn';
import type { StartSessionRequest } from '../../src/server/backend/types';
import { sleep } from '../../src/server/lib/async';
import { killProcessTree, spawnHidden } from '../../src/server/lib/process';
import { observationFrom, type Observation } from './observation';

/** The probe's prompt: no tool, one word. */
export const PROBE_PROMPT = 'Reply with exactly: OK';

export type ProbeStopKind = 'auth' | 'guard' | 'budget' | 'failed';

/** Stops the check (exit 2); `auth` also means: do not run again before the user decided. */
export class ProbeStop extends Error {
  constructor(
    readonly kind: ProbeStopKind,
    message: string,
  ) {
    super(message);
    this.name = 'ProbeStop';
  }
}

/** assistant.error values that mean "login/billing problem" (same list as the recorder). */
export const AUTH_ERRORS: ReadonlySet<string> = new Set([
  'authentication_failed',
  'oauth_org_not_allowed',
  'account_on_hold',
  'verification_required',
  'billing_error',
  'cloud_credential_error',
]);

const guardSchema = z.looseObject({
  type: z.string(),
  subtype: z.string().optional(),
  apiKeySource: z.string().optional(),
  model: z.string().optional(),
  error: z.string().optional(),
  rate_limit_info: z.looseObject({ status: z.string().optional(), errorCode: z.string().optional() }).optional(),
  startup_failure_reason: z.string().optional(),
  total_cost_usd: z.number().optional(),
});

/** The stop a raw SDK message demands, or null (pure; tested). */
export function probeGuard(message: unknown, budgetUsd: number): ProbeStop | null {
  const parsed = guardSchema.safeParse(message);
  if (!parsed.success) return null;
  const m = parsed.data;
  if (m.type === 'system' && m.subtype === 'init') {
    if (m.apiKeySource !== 'none') {
      return new ProbeStop('auth', `system/init.apiKeySource is "${m.apiKeySource ?? '?'}" (API key in use)`);
    }
    if (!/haiku/i.test(m.model ?? '')) return new ProbeStop('guard', `the probe runs on ${m.model ?? '?'}, not Haiku`);
  } else if (m.type === 'assistant' && m.error !== undefined && AUTH_ERRORS.has(m.error)) {
    return new ProbeStop('auth', `assistant.error = ${m.error}`);
  } else if (m.type === 'rate_limit_event') {
    if (m.rate_limit_info?.errorCode === 'credits_required') return new ProbeStop('auth', 'rate_limit_event: credits_required');
    if (m.rate_limit_info?.status === 'rejected') return new ProbeStop('guard', 'rate_limit_event: rejected');
  } else if (m.type === 'result') {
    if (m.subtype !== 'success' && m.startup_failure_reason !== undefined) {
      return new ProbeStop('auth', `startup_failure_reason = ${m.startup_failure_reason}`);
    }
    if ((m.total_cost_usd ?? 0) > budgetUsd) {
      return new ProbeStop('budget', `probe cost ${(m.total_cost_usd ?? 0).toFixed(4)} USD > budget ${budgetUsd.toFixed(4)} USD`);
    }
  }
  return null;
}

/** Streaming input with one prompt; `close()` ends it (EOF). */
class PromptQueue implements AsyncIterable<SDKUserMessage> {
  private readonly items: SDKUserMessage[] = [];
  private waiter: ((result: IteratorResult<SDKUserMessage, undefined>) => void) | null = null;
  private closed = false;

  push(text: string): void {
    const message: SDKUserMessage = {
      type: 'user',
      message: { role: 'user', content: text },
      parent_tool_use_id: null,
      uuid: randomUUID(),
    };
    if (this.waiter !== null) {
      const resolve = this.waiter;
      this.waiter = null;
      resolve({ value: message, done: false });
    } else {
      this.items.push(message);
    }
  }

  close(): void {
    this.closed = true;
    const resolve = this.waiter;
    this.waiter = null;
    resolve?.({ value: undefined, done: true });
  }

  [Symbol.asyncIterator](): AsyncIterator<SDKUserMessage, undefined> {
    return {
      next: () => {
        const item = this.items.shift();
        if (item !== undefined) return Promise.resolve({ value: item, done: false });
        if (this.closed) return Promise.resolve({ value: undefined, done: true });
        return new Promise((resolve) => {
          this.waiter = resolve;
        });
      },
      return: () => {
        this.close();
        return Promise.resolve({ value: undefined, done: true });
      },
    };
  }
}

const messageHeadSchema = z.looseObject({
  type: z.string(),
  subtype: z.string().optional(),
  session_id: z.string().optional(),
});

export interface ProbeOptions {
  launch: LaunchSpec;
  /** Scratch working directory (temp, own). */
  cwd: string;
  entryId: string;
  sdkVersion: string;
  budgetUsd: number;
  turnTimeoutMs?: number;
  controlTimeoutMs?: number;
  log?: (line: string) => void;
}

export interface ProbeResult {
  observation: Observation;
  costUsd: number;
  sessionIds: string[];
  apiKeySource: string;
  resultSubtype: string;
  messageTypes: Record<string, number>;
  contextDetail: 'full' | 'summary' | null;
  durationMs: number;
}

/** Partial facts of a stopped probe (cleanup needs the session ids, the report the cost). */
export interface ProbeTrace {
  sessionIds: Set<string>;
  costUsd: number;
}

const denyAll: CanUseTool = () =>
  Promise.resolve({ behavior: 'deny', message: 'cli-check probe: no tools in this session.' });

const resultSchema = z.looseObject({
  type: z.literal('result'),
  subtype: z.string(),
  total_cost_usd: z.number().catch(0),
});

/** Mutable facts of one probe run (an object: the stream pump and the waits share them). */
interface ProbeState {
  init: unknown;
  result: { subtype: string; costUsd: number } | null;
  stop: ProbeStop | null;
  pid: number | null;
  stderr: string;
  ended: boolean;
}

/**
 * Runs the probe. `trace` is filled while it runs (also when it throws). Always closes the CLI:
 * EOF + Query.close(), then `taskkill /T /F` when it did not exit within 10 s.
 */
export async function runProbe(options: ProbeOptions, trace: ProbeTrace): Promise<ProbeResult> {
  const started = Date.now();
  const log = options.log ?? (() => undefined);
  const turnMs = options.turnTimeoutMs ?? 180_000;
  const controlMs = options.controlTimeoutMs ?? 60_000;
  const messageTypes: Record<string, number> = {};
  const state: ProbeState = { init: null, result: null, stop: null, pid: null, stderr: '', ended: false };
  let exitResolve: () => void = () => undefined;
  const exited = new Promise<void>((resolve) => {
    exitResolve = resolve;
  });
  const listeners = new Set<() => void>();
  const notify = (): void => {
    for (const listener of [...listeners]) listener();
  };

  const input = new PromptQueue();
  const spawn = createSpawner({
    spawn: spawnHidden,
    killProcessTree,
    now: () => new Date(),
    expectedCommand: options.launch.executablePath,
    onSpawned: (pid) => {
      state.pid = pid;
    },
    onStderr: (text) => {
      if (state.stderr.length < 4000) state.stderr += text;
    },
    onExit: () => {
      exitResolve();
    },
    onError: (error) => {
      state.stop ??= new ProbeStop('failed', `spawn: ${error.message}`);
      exitResolve();
      notify();
    },
  });
  const request: StartSessionRequest = {
    entryId: options.entryId,
    cwd: options.cwd,
    launch: options.launch,
    resumeSessionId: null,
    model: 'haiku',
    permissionMode: null,
    effort: null,
    promptSuggestions: false,
    canUseTool: () => Promise.resolve({ behavior: 'deny', message: 'cli-check probe: no tools.' }),
  };
  const sdkOptions = buildQueryOptions(request, { canUseTool: denyAll, spawn, stderr: () => undefined });
  sdkOptions.settingSources = [];
  sdkOptions.strictMcpConfig = true;
  sdkOptions.settings = { disableClaudeAiConnectors: true };
  sdkOptions.maxTurns = 1;

  const q: Query = query({ prompt: input, options: sdkOptions });
  const onMessage = (message: unknown): void => {
    const head = messageHeadSchema.safeParse(message);
    if (head.success) {
      const { type, subtype, session_id: sessionId } = head.data;
      const key = subtype === undefined ? type : `${type}/${subtype}`;
      messageTypes[key] = (messageTypes[key] ?? 0) + 1;
      if (sessionId !== undefined && sessionId !== '') trace.sessionIds.add(sessionId);
      if (type === 'system' && subtype === 'init') state.init ??= message;
    }
    const result = resultSchema.safeParse(message);
    if (result.success) {
      state.result = { subtype: result.data.subtype, costUsd: result.data.total_cost_usd };
      trace.costUsd = Math.max(trace.costUsd, result.data.total_cost_usd);
    }
    const guard = probeGuard(message, options.budgetUsd);
    if (guard !== null && state.stop === null) {
      state.stop = guard;
      log(`cli-check: probe STOP (${guard.kind}) – ${guard.message}`);
      q.close();
    }
    notify();
  };
  const pump = (async () => {
    try {
      for await (const message of q) onMessage(message);
    } catch (error) {
      if (state.stop === null && state.result === null) {
        state.stop = new ProbeStop('failed', `stream: ${error instanceof Error ? error.message : String(error)}`);
      }
    } finally {
      state.ended = true;
      notify();
    }
  })();

  const waitFor = (done: () => boolean, label: string, ms: number): Promise<void> =>
    new Promise((resolve, reject) => {
      const finish = (action: () => void): void => {
        clearTimeout(timer);
        listeners.delete(check);
        action();
      };
      const check = (): void => {
        const stop = state.stop;
        if (stop !== null) finish(() => { reject(stop); });
        else if (done()) finish(resolve);
        else if (state.ended) finish(() => { reject(new ProbeStop('failed', `stream ended while waiting for ${label}`)); });
      };
      const timer = setTimeout(() => {
        finish(() => { reject(new ProbeStop('failed', `timeout after ${String(ms)} ms waiting for ${label}`)); });
      }, ms);
      listeners.add(check);
      check();
    });

  try {
    const initialization = await withTimeout(q.initializationResult(), controlMs, 'initializationResult');
    const models = await withTimeout(q.supportedModels(), controlMs, 'supportedModels');
    log(`cli-check: probe ready (pid ${String(state.pid ?? '?')}), one prompt on Haiku`);
    input.push(PROBE_PROMPT);
    await waitFor(() => state.result !== null, 'the result of the probe prompt', turnMs);
    let contextUsage: unknown;
    let contextDetail: 'full' | 'summary';
    try {
      contextUsage = await withTimeout(q.getContextUsage({ detail: 'full' }), controlMs, 'getContextUsage(full)');
      contextDetail = 'full';
    } catch (error) {
      log(`cli-check: getContextUsage(full) failed (${error instanceof Error ? error.message : String(error)}) – summary`);
      contextUsage = await withTimeout(q.getContextUsage({ detail: 'summary' }), controlMs, 'getContextUsage(summary)');
      contextDetail = 'summary';
    }
    if (state.stop !== null) throw state.stop;
    const observation = observationFrom(
      { init: state.init, initializationResult: initialization, supportedModels: models, contextUsage },
      options.sdkVersion,
    );
    const result = state.result ?? { subtype: '?', costUsd: 0 };
    return {
      observation,
      costUsd: result.costUsd,
      sessionIds: [...trace.sessionIds].sort(),
      apiKeySource: z.looseObject({ apiKeySource: z.string() }).safeParse(state.init).data?.apiKeySource ?? '?',
      resultSubtype: result.subtype,
      messageTypes,
      contextDetail,
      durationMs: Date.now() - started,
    };
  } catch (error) {
    if (error instanceof ProbeStop) throw error;
    const stderr = state.stderr.trim();
    throw new ProbeStop(
      'failed',
      `${error instanceof Error ? error.message : String(error)}${stderr === '' ? '' : ` (stderr: ${stderr.slice(0, 300)})`}`,
    );
  } finally {
    input.close();
    q.close();
    const exitedInTime = await Promise.race([exited.then(() => true), sleep(10_000).then(() => false)]);
    if (!exitedInTime && state.pid !== null) {
      log(`cli-check: probe process ${String(state.pid)} did not exit – taskkill /T /F`);
      await killProcessTree(state.pid).catch(() => undefined);
    }
    await Promise.race([pump, sleep(5_000)]);
  }
}
