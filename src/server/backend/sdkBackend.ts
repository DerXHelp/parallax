/**
 * SdkBackend (WP-13 §3.2): port `AgentBackend` against the installed `claude` through the Agent SDK.
 * No normalizing, no status logic – raw SDK messages leave as `BackendEvent.message`.
 *
 * Per start: `query()` in streaming-input mode (prompt = AsyncQueue<SDKUserMessage>), options from
 * sdkOptions.ts, the spawn wrapper from spawn.ts (PID + start time, stderr always read, tree kill),
 * a pump `for await (m of q)` → `message` events. Event order: `spawned` (synchronously inside
 * query()), then `stderr`/`message`/`error` in arrival order, `exit` ALWAYS last: it is sent once
 * the child process ended AND the pump finished (at most `iteratorAfterExitMs` after the process
 * exit); without a spawn the end of the iterator counts. `expected` = close()/dispose() was called.
 *
 * close() (C.8): end the input, Query.close(), wait ≤ closeGraceMs for `exit`, else
 * `taskkill /PID <pid> /T /F` and wait ≤ killWaitMs, else synthesize `exit{code:null,
 * signal:'SIGKILL', expected:true}`. Every control call has a timeout; a rejection is an Error (the
 * manager maps it to CLAUDE_CONTROL_FAILED). History runs in a worker per config dir (history/pool.ts).
 */
// Types only: the SDK module itself is loaded by `loadAgentSdk()` (dynamic import). esbuild hoists
// a static import of an external package to the top of the one-file bundle, so `dist/server.js`
// loaded the SDK on every start, also with --backend=fake (WP-20a gap 1, WP-20c).
import type {
  CanUseTool,
  EffortLevel,
  Options,
  PermissionMode,
  Query,
  SDKUserMessage,
} from '@anthropic-ai/claude-agent-sdk';
import type { UUID } from 'node:crypto';
import path from 'node:path';
import type { Logger } from 'pino';
import { z } from 'zod';
import { messageUuidSchema } from '@shared/common';
import { toError } from '../lib/async';
import { logger } from '../lib/logger';
import { killProcessTree as killTree, spawnHidden } from '../lib/process';
import { mergeHistory, toHistoryMessages, toSessionInfo } from './history/parse';
import { createHistoryPool, type HistoryPool } from './history/pool';
import { AsyncQueue } from './lib/asyncQueue';
import { toPermissionRequest } from './permissionRequest';
import { buildQueryOptions, flagSettingsAfterStart, optionIssues } from './sdkOptions';
import { createSpawner } from './spawn';
import type {
  AgentBackend,
  AgentSession,
  BackendEvent,
  HistoryMessage,
  HistoryRequest,
  OutgoingContent,
  OutgoingPrompt,
  StartSessionRequest,
} from './types';

const log = logger.child({ module: 'backend/sdk' });

export interface SdkTimeouts {
  /** C.8: close() → wait at most this long for `exit`. */
  closeGraceMs: number;
  /** After taskkill wait this long for `exit`, then synthesize it. */
  killWaitMs: number;
  /** interrupt/setModel/setPermissionMode/applyFlagSettings/stopTask/supportedCommands. */
  controlMs: number;
  /** getContextUsage('full') (token counting; gateway models, C.1). */
  contextFullMs: number;
  /**
   * `supportedModels()` = the end of the `initialize` handshake (readiness, §2.3 Nr. 6; also before
   * the C.1 flag settings). A cold start (first start after boot, scanner on claude.exe, slow
   * plugins) can take longer than `controlMs` (R2-04).
   */
  readyMs: number;
  /** After the process exit wait at most this long for the end of the iterator. */
  iteratorAfterExitMs: number;
}

export const SDK_TIMEOUTS: Readonly<SdkTimeouts> = Object.freeze({
  closeGraceMs: 5_000,
  killWaitMs: 5_000,
  controlMs: 15_000,
  contextFullMs: 60_000,
  readyMs: 60_000,
  iteratorAfterExitMs: 2_000,
});

/** Answer to the CLI when the permission handler throws (F.3). */
export const PERMISSION_FAILURE_MESSAGE = 'Parallax could not process this request.';

const STDERR_LOG_CHARS = 2_000;

type FlagSettings = Parameters<Query['applyFlagSettings']>[0];

/**
 * The part of the SDK `Query` the backend uses. The real `query()` result satisfies it; tests
 * pass a small fake without casts (WP-13 §5.3).
 */
export interface SdkQueryHandle extends AsyncIterable<unknown> {
  interrupt(): Promise<unknown>;
  setModel(model?: string): Promise<void>;
  setPermissionMode(mode: PermissionMode): Promise<void>;
  applyFlagSettings(settings: FlagSettings): Promise<void>;
  getContextUsage(opts?: { detail?: 'summary' | 'full' }): Promise<unknown>;
  supportedModels(): Promise<unknown[]>;
  supportedCommands(): Promise<unknown[]>;
  stopTask(taskId: string): Promise<void>;
  close(): void;
}

/** Signature of the SDK `query` as the backend calls it (test seam). */
export type SdkQueryFn = (params: {
  prompt: AsyncIterable<SDKUserMessage>;
  options: Options;
}) => SdkQueryHandle;

export interface SdkBackendDeps {
  /** Default: the SDK `query` (tests: a fake). */
  query?: SdkQueryFn;
  /** Default: `spawnHidden` (lib/process.ts). */
  spawn?: typeof spawnHidden;
  /** Default: `killProcessTree` (lib/process.ts, taskkill /T /F). */
  killProcessTree?: (pid: number) => Promise<void>;
  /** Default: `createHistoryPool()`; disposed by `dispose()`. */
  history?: HistoryPool;
  now?: () => Date;
  timeouts?: Partial<SdkTimeouts>;
}

// ---- helpers ----

function timeoutError(label: string, ms: number): Error {
  const error = new Error(`${label} timed out after ${ms} ms`);
  error.name = 'TimeoutError';
  return error;
}

/** Rejects after `ms`; a late settlement of `promise` is ignored (no unhandled rejection). */
export function withTimeout<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(timeoutError(label, ms));
    }, ms);
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error: unknown) => {
        clearTimeout(timer);
        reject(toError(error));
      },
    );
  });
}

/** The prompt uuid must be a UUID (`messageUuidSchema`, the contract of `user_message_uuids`). */
function isUuid(value: string): value is UUID {
  return messageUuidSchema.safeParse(value).success;
}

type UserContent = SDKUserMessage['message']['content'];
type UserBlock = Exclude<UserContent, string>[number];

function toUserBlock(content: OutgoingContent): UserBlock {
  switch (content.type) {
    case 'text':
      return { type: 'text', text: content.text };
    case 'image':
      return {
        type: 'image',
        source: { type: 'base64', media_type: content.mediaType, data: content.base64 },
      };
    case 'document':
      return {
        type: 'document',
        source: { type: 'base64', media_type: content.mediaType, data: content.base64 },
      };
  }
}

/**
 * OutgoingPrompt → SDKUserMessage (F.1, WP-01): content is a plain string for exactly one text
 * block, else content blocks (image/document as base64 source); origin human, no parent tool use.
 */
export function toSdkUserMessage(prompt: OutgoingPrompt): SDKUserMessage {
  if (!isUuid(prompt.uuid)) throw new TypeError('prompt uuid must be a UUID');
  const [first] = prompt.content;
  const content: UserContent =
    prompt.content.length === 1 && first?.type === 'text' ? first.text : prompt.content.map(toUserBlock);
  return {
    type: 'user',
    message: { role: 'user', content },
    parent_tool_use_id: null,
    uuid: prompt.uuid,
    priority: prompt.priority,
    origin: { kind: 'human' },
  };
}

const interruptReceiptSchema = z.object({ still_queued: z.array(z.unknown()) });

/** interrupt() answer → still queued uuids; an old CLI answers `undefined` (F.10) → []. */
export function stillQueuedOf(raw: unknown): string[] {
  const parsed = interruptReceiptSchema.safeParse(raw);
  if (!parsed.success) return [];
  return parsed.data.still_queued.filter((uuid): uuid is string => typeof uuid === 'string');
}

const agentIdsSchema = z.array(z.unknown());

// ---- session ----

interface SessionContext {
  readonly query: SdkQueryFn;
  readonly spawn: typeof spawnHidden;
  readonly killProcessTree: (pid: number) => Promise<void>;
  readonly now: () => Date;
  readonly timeouts: SdkTimeouts;
  disposed(): boolean;
  finished(session: SdkSession): void;
}

type ProcessState = 'none' | 'running' | 'exited';

class SdkSession implements AgentSession {
  readonly entryId: string;
  readonly events: AsyncIterable<BackendEvent>;

  private readonly queue = new AsyncQueue<BackendEvent>();
  private readonly input = new AsyncQueue<SDKUserMessage>();
  private readonly log: Logger;
  private readonly exited = Promise.withResolvers<undefined>();
  private q: SdkQueryHandle | null = null;
  private currentPid: number | null = null;
  private processState: ProcessState = 'none';
  private exitInfo: { code: number | null; signal: string | null } = { code: null, signal: null };
  private pumpDone = false;
  private exitSent = false;
  private expected = false;
  private spawnFailed = false;
  private afterExitTimer: NodeJS.Timeout | null = null;
  private shutdownPromise: Promise<void> | null = null;

  constructor(
    private readonly req: StartSessionRequest,
    private readonly ctx: SessionContext,
  ) {
    this.entryId = req.entryId;
    this.events = this.queue;
    this.log = log.child({ entryId: req.entryId });
  }

  get pid(): number | null {
    return this.currentPid;
  }

  // ---- start ----

  start(): void {
    const { req, ctx } = this;
    for (const issue of optionIssues(req)) this.log.warn({ issue }, 'claude option not mapped as configured');
    const spawner = createSpawner({
      spawn: ctx.spawn,
      killProcessTree: ctx.killProcessTree,
      now: ctx.now,
      expectedCommand: req.launch.executablePath,
      onSpawned: (pid, at) => {
        this.onSpawned(pid, at);
      },
      onStderr: (text) => {
        this.onStderr(text);
      },
      onExit: (code, signal) => {
        this.onProcessExit(code, signal);
      },
      onError: (error) => {
        this.onSpawnError(error);
      },
    });
    const options = buildQueryOptions(req, {
      canUseTool: this.canUseTool,
      spawn: spawner,
      stderr: (text) => {
        this.onStderr(text);
      },
    });

    let q: SdkQueryHandle;
    try {
      if (ctx.disposed()) throw new Error('backend disposed');
      q = ctx.query({ prompt: this.input, options });
    } catch (error) {
      // Synchronous failure (e.g. the spawn wrapper refused the executable).
      if (!this.spawnFailed) this.emitError('spawn', error);
      this.pumpDone = true;
      this.maybeFinalize();
      return;
    }
    this.q = q;
    void this.pump(q);
    const flags = flagSettingsAfterStart(req);
    if (flags !== null) void this.applyAfterReady(q, flags);
  }

  private async pump(q: SdkQueryHandle): Promise<void> {
    try {
      for await (const message of q) {
        if (this.exitSent) break;
        this.emit({ type: 'message', message, at: this.ctx.now() });
      }
    } catch (error) {
      if (this.spawnFailed || this.expected) {
        this.log.debug({ err: error }, 'iterator ended with an error after spawn failure/close');
      } else {
        this.emitError('iterator', error);
      }
    } finally {
      this.pumpDone = true;
      this.maybeFinalize();
    }
  }

  /**
   * C.1 (+ Phase 2 fast mode): settings file + profile autoCompactWindow / entry fast mode → flag
   * settings once the CLI is ready.
   */
  private async applyAfterReady(
    q: SdkQueryHandle,
    flags: { autoCompactWindow?: number; fastMode?: boolean },
  ): Promise<void> {
    const { controlMs, readyMs } = this.ctx.timeouts;
    try {
      await withTimeout(q.supportedModels(), readyMs, 'supportedModels');
      await withTimeout(q.applyFlagSettings(flags), controlMs, 'applyFlagSettings');
      this.log.info(flags, 'flag settings applied after the start');
    } catch (error) {
      if (this.exitSent || this.shutdownPromise !== null) return;
      this.emitError('control', error);
    }
  }

  // ---- spawn wrapper callbacks ----

  private onSpawned(pid: number, at: Date): void {
    this.currentPid = pid;
    this.processState = 'running';
    this.log.info({ pid, executable: path.win32.basename(this.req.launch.executablePath) }, 'claude spawned');
    this.emit({ type: 'spawned', pid, at });
  }

  private onStderr(text: string): void {
    // F.16: always read, always logged (the logger redacts tokens).
    this.log.info({ pid: this.currentPid, stderr: text.slice(0, STDERR_LOG_CHARS) }, 'claude stderr');
    this.emit({ type: 'stderr', data: text, at: this.ctx.now() });
  }

  private onSpawnError(error: Error): void {
    if (this.processState === 'running') {
      // An error of a running child (e.g. a failed kill()): no spawn failure, the exit follows.
      this.log.warn({ pid: this.currentPid, err: error }, 'claude process error');
      return;
    }
    this.spawnFailed = true;
    this.emitError('spawn', error);
    if (this.processState === 'none') this.onProcessExit(null, null);
  }

  private onProcessExit(code: number | null, signal: string | null): void {
    if (this.processState === 'exited') return;
    this.processState = 'exited';
    this.exitInfo = { code, signal };
    this.log.info({ pid: this.currentPid, code, signal }, 'claude process exited');
    // After a synthesized exit (close() fallback) there is nothing left to wait for.
    if (this.exitSent) return;
    if (this.pumpDone) {
      this.maybeFinalize();
      return;
    }
    this.afterExitTimer = setTimeout(() => {
      this.afterExitTimer = null;
      this.log.warn({ pid: this.currentPid }, 'iterator did not end after the process exit');
      this.finalize(this.exitInfo);
    }, this.ctx.timeouts.iteratorAfterExitMs);
  }

  // ---- event plumbing ----

  private emit(event: BackendEvent): void {
    if (this.exitSent) return;
    this.queue.push(event);
  }

  private emitError(where: 'spawn' | 'iterator' | 'control', error: unknown): void {
    const err = toError(error);
    this.log.warn({ where, err }, 'claude session error');
    this.emit({ type: 'error', where, name: err.name, message: err.message, at: this.ctx.now() });
  }

  private maybeFinalize(): void {
    if (this.exitSent || !this.pumpDone) return;
    if (this.processState === 'running') {
      // The iterator ended while the CLI still runs: end it like close() (exit stays unexpected).
      if (this.shutdownPromise === null)
        this.log.warn({ pid: this.currentPid }, 'iterator ended; closing claude');
      void this.shutdown();
      return;
    }
    this.finalize(this.exitInfo);
  }

  private finalize(info: { code: number | null; signal: string | null }): void {
    if (this.exitSent) return;
    this.exitSent = true;
    if (this.afterExitTimer !== null) clearTimeout(this.afterExitTimer);
    this.afterExitTimer = null;
    this.queue.push({
      type: 'exit',
      code: info.code,
      signal: info.signal,
      expected: this.expected,
      at: this.ctx.now(),
    });
    this.queue.end();
    if (!this.input.ended) this.input.end();
    if (!this.pumpDone) this.closeQuery();
    this.log.info({ code: info.code, signal: info.signal, expected: this.expected }, 'claude session ended');
    this.ctx.finished(this);
    this.exited.resolve(undefined);
  }

  // ---- shutdown ----

  private closeQuery(): void {
    try {
      this.q?.close();
    } catch (error) {
      this.log.warn({ err: error }, 'Query.close() failed');
    }
  }

  private waitExit(ms: number): Promise<boolean> {
    if (this.exitSent) return Promise.resolve(true);
    return new Promise<boolean>((resolve) => {
      const timer = setTimeout(() => {
        resolve(false);
      }, ms);
      void this.exited.promise.then(() => {
        clearTimeout(timer);
        resolve(true);
      });
    });
  }

  private shutdown(): Promise<void> {
    this.shutdownPromise ??= this.runShutdown();
    return this.shutdownPromise;
  }

  private async runShutdown(): Promise<void> {
    const { closeGraceMs, killWaitMs } = this.ctx.timeouts;
    if (!this.input.ended) this.input.end();
    this.closeQuery();
    if (await this.waitExit(closeGraceMs)) return;
    const pid = this.currentPid;
    if (pid !== null && this.processState === 'running') {
      this.log.warn({ pid, closeGraceMs }, 'claude did not exit in time; killing the process tree');
      // Not awaited: killWaitMs bounds close() even if taskkill itself hangs.
      this.ctx.killProcessTree(pid).catch((error: unknown) => {
        this.log.error({ pid, err: error }, 'killing the claude process tree failed');
      });
    }
    if (await this.waitExit(killWaitMs)) return;
    this.log.error({ pid }, 'claude did not exit after taskkill; synthesizing the exit event');
    this.finalize({ code: null, signal: 'SIGKILL' });
  }

  close(): Promise<void> {
    this.expected = true;
    return this.shutdown();
  }

  // ---- AgentSession ----

  private get closed(): boolean {
    return this.exitSent || this.shutdownPromise !== null;
  }

  send(prompt: OutgoingPrompt): void {
    if (this.closed) throw new Error('session closed');
    this.input.push(toSdkUserMessage(prompt));
  }

  private control<T>(label: string, ms: number, call: (q: SdkQueryHandle) => Promise<T>): Promise<T> {
    const q = this.q;
    if (q === null || this.closed) return Promise.reject(new Error('session closed'));
    let promise: Promise<T>;
    try {
      promise = call(q);
    } catch (error) {
      return Promise.reject(toError(error));
    }
    return withTimeout(promise, ms, label);
  }

  async interrupt(): Promise<{ stillQueued: string[] }> {
    const raw = await this.control('interrupt', this.ctx.timeouts.controlMs, (q) => q.interrupt());
    return { stillQueued: stillQueuedOf(raw) };
  }

  setModel(model: string | null): Promise<void> {
    return this.control('setModel', this.ctx.timeouts.controlMs, (q) => q.setModel(model ?? undefined));
  }

  /** Idle: no `status` message follows (F.2) – the manager applies the mode locally. */
  setPermissionMode(mode: PermissionMode): Promise<void> {
    return this.control('setPermissionMode', this.ctx.timeouts.controlMs, (q) => q.setPermissionMode(mode));
  }

  /** `null` clears the key from the flag layer. */
  applyFlagSettings(settings: {
    effortLevel?: EffortLevel | null;
    fastMode?: boolean | null;
  }): Promise<void> {
    return this.control('applyFlagSettings', this.ctx.timeouts.controlMs, (q) =>
      q.applyFlagSettings(settings),
    );
  }

  getContextUsage(detail: 'summary' | 'full'): Promise<unknown> {
    const { controlMs, contextFullMs } = this.ctx.timeouts;
    return this.control(`getContextUsage(${detail})`, detail === 'full' ? contextFullMs : controlMs, (q) =>
      q.getContextUsage({ detail }),
    );
  }

  /**
   * Waits for the initialize handshake inside the SDK – the engine's readiness signal (§2.3 Nr. 6),
   * bounded by `readyMs` (R2-04: a cold start may exceed `controlMs`).
   */
  supportedModels(): Promise<unknown[]> {
    return this.control('supportedModels', this.ctx.timeouts.readyMs, (q) => q.supportedModels());
  }

  supportedCommands(): Promise<unknown[]> {
    return this.control('supportedCommands', this.ctx.timeouts.controlMs, (q) => q.supportedCommands());
  }

  stopTask(taskId: string): Promise<void> {
    return this.control('stopTask', this.ctx.timeouts.controlMs, (q) => q.stopTask(taskId));
  }

  /** F.3: toPermissionRequest → req.canUseTool(request, signal); a throwing handler → deny. */
  private readonly canUseTool: CanUseTool = async (toolName, input, options) => {
    try {
      const request = toPermissionRequest(toolName, input, options);
      return await this.req.canUseTool(request, options.signal);
    } catch (error) {
      this.log.error({ toolName, err: error }, 'permission handler failed; denying the request');
      this.emitError('control', error);
      return { behavior: 'deny', message: PERMISSION_FAILURE_MESSAGE };
    }
  };
}

// ---- backend ----

let loadedSdkQuery: SdkQueryFn | null = null;

/**
 * Loads the Agent SDK (dynamic import, idempotent) and returns its `query`. The composition calls
 * it before `createSdkBackend()`; nothing else in the bundle loads the SDK module (only
 * `require.resolve` for paths, history/pool.ts and resolveClaude.ts).
 */
export async function loadAgentSdk(): Promise<SdkQueryFn> {
  if (loadedSdkQuery === null) {
    const sdk = await import('@anthropic-ai/claude-agent-sdk');
    loadedSdkQuery = sdk.query;
  }
  return loadedSdkQuery;
}

function defaultQuery(): SdkQueryFn {
  if (loadedSdkQuery === null) throw new Error('SdkBackend: await loadAgentSdk() before createSdkBackend()');
  return loadedSdkQuery;
}

/** Without `deps.query`, `loadAgentSdk()` must have resolved before (throws otherwise). */
export function createSdkBackend(deps: SdkBackendDeps = {}): AgentBackend & { readonly kind: 'sdk' } {
  const query = deps.query ?? defaultQuery();
  const history = deps.history ?? createHistoryPool();
  const live = new Set<SdkSession>();
  let disposed = false;
  const ctx: SessionContext = {
    query,
    spawn: deps.spawn ?? spawnHidden,
    killProcessTree: deps.killProcessTree ?? killTree,
    now: deps.now ?? (() => new Date()),
    timeouts: { ...SDK_TIMEOUTS, ...deps.timeouts },
    disposed: () => disposed,
    finished: (session) => {
      live.delete(session);
    },
  };

  const subagentIds = async (req: HistoryRequest): Promise<string[]> => {
    const raw = await history.run(req.launch, { op: 'subagents', sessionId: req.sessionId });
    const parsed = agentIdsSchema.safeParse(raw);
    if (!parsed.success) {
      log.warn({ sessionId: req.sessionId }, 'listSubagents returned no list; ignored');
      return [];
    }
    return parsed.data.filter((id): id is string => typeof id === 'string' && id !== '');
  };

  return {
    kind: 'sdk',

    start(req) {
      const session = new SdkSession(req, ctx);
      live.add(session);
      session.start();
      return session;
    },

    /** getSessionMessages + every subagent's messages, merged by time (A.3, R0-18). */
    async readHistory(req): Promise<HistoryMessage[]> {
      const main = toHistoryMessages(
        await history.run(req.launch, { op: 'messages', sessionId: req.sessionId }),
      );
      const agents = await subagentIds(req);
      const subagents = await Promise.all(
        agents.map(async (agentId) =>
          toHistoryMessages(
            await history.run(req.launch, { op: 'subagentMessages', sessionId: req.sessionId, agentId }),
          ),
        ),
      );
      return mergeHistory(main, subagents);
    },

    async getSessionInfo(req) {
      return toSessionInfo(await history.run(req.launch, { op: 'info', sessionId: req.sessionId }));
    },

    /** Only for dormant sessions – the manager guarantees it (C.6). */
    async renameSession(req) {
      await history.run(req.launch, { op: 'rename', sessionId: req.sessionId, title: req.title });
    },

    async dispose() {
      disposed = true;
      await Promise.all([...live].map((session) => session.close()));
      await history.dispose();
    },
  };
}
