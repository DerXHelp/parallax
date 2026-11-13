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
import { makeError, type ErrorPayload } from '@shared/errors';
import type { McpAction, ReloadTarget, SessionInfoSection, SessionInfoSectionName } from '@shared/model';
import { toError } from '../lib/async';
import { logger } from '../lib/logger';
import { killProcessTree as killTree, spawnHidden } from '../lib/process';
import { mergeHistory, toHistoryMessages, toSessionInfo, toSubagentSlice } from './history/parse';
import { createHistoryPool, type HistoryPool } from './history/pool';
import { AsyncQueue } from './lib/asyncQueue';
import { createLoginSession, type LoginQueryMethods } from './login';
import { outputStylesOf } from './outputStyle';
import { toPermissionRequest } from './permissionRequest';
import {
  buildLoginOptions,
  buildQueryOptions,
  flagSettingsAfterStart,
  optionIssues,
  type StartFlagSettings,
} from './sdkOptions';
import { titleOf, usageLimitsOf } from './overview';
import { remoteControlDefaultOf, remoteControlErrorOf, toRemoteControlInfo } from './remoteControl';
import { SESSION_INFO_METHODS, sessionInfoFailure, sessionInfoOf } from './sessionInfo';
import { controlRetryOf, sideAnswerOf, sideQuestionFailure, withdrawnOf } from './sideQuestion';
import { createSpawner } from './spawn';
import type {
  AgentBackend,
  AgentSession,
  BackendEvent,
  HistoryMessage,
  HistoryRequest,
  LoginRequest,
  LoginSession,
  OutgoingContent,
  OutgoingPrompt,
  OutputStyles,
  RemoteControlRequest,
  RemoteControlResult,
  SideQuestionOptions,
  SideQuestionResult,
  StartSessionRequest,
  TitleResult,
  UsageLimits,
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
  /**
   * WP-65: `generateSessionTitle` (one small model request, live ≈ 1 s) – may follow right after a
   * start, so it gets the bound of the readiness rather than `controlMs`.
   */
  titleMs: number;
  /**
   * WP-66: `askSideQuestion` (one model request from the session's prompt cache, live 1–2 s; the CLI
   * retries overloaded requests itself) – after this the request is cancelled (status failed).
   */
  sideQuestionMs: number;
  /**
   * WP-67: one "Session info" request (`getStatus`, `getMemoryDialog`, … , `exportConversation` –
   * the export renders the whole conversation as text, so it gets more than `controlMs`).
   */
  infoMs: number;
  /** WP-67: MCP reconnect/toggle and reloading skills/plugins (a server connect or plugin load). */
  infoActionMs: number;
  /** WP-70: `claudeAuthenticate` (right after the start: waits for the CLI's initialize). */
  loginStartMs: number;
  /** WP-70: `claudeOAuthCallback` with a pasted code (token exchange, profile fetch). */
  loginCodeMs: number;
  /** WP-70: `claudeOAuthWaitForCompletion` – the user signs in in the browser (the CLI's 10 min). */
  loginFlowMs: number;
}

export const SDK_TIMEOUTS: Readonly<SdkTimeouts> = Object.freeze({
  closeGraceMs: 5_000,
  killWaitMs: 5_000,
  controlMs: 15_000,
  contextFullMs: 60_000,
  readyMs: 60_000,
  iteratorAfterExitMs: 2_000,
  titleMs: 60_000,
  sideQuestionMs: 120_000,
  infoMs: 30_000,
  infoActionMs: 60_000,
  loginStartMs: 60_000,
  loginCodeMs: 60_000,
  loginFlowMs: 600_000,
});

/** Answer to the CLI when the permission handler throws (F.3). */
export const PERMISSION_FAILURE_MESSAGE = 'Parallax could not process this request.';

const STDERR_LOG_CHARS = 2_000;

type FlagSettings = Parameters<Query['applyFlagSettings']>[0];

/**
 * The part of the SDK `Query` the backend uses. The real `query()` result satisfies it; tests
 * pass a small fake without casts (WP-13 §5.3).
 */
export interface SdkQueryHandle extends AsyncIterable<unknown>, LoginQueryMethods {
  interrupt(): Promise<unknown>;
  setModel(model?: string): Promise<void>;
  setPermissionMode(mode: PermissionMode): Promise<void>;
  applyFlagSettings(settings: FlagSettings): Promise<void>;
  getContextUsage(opts?: { detail?: 'summary' | 'full' }): Promise<unknown>;
  supportedModels(): Promise<unknown[]>;
  supportedCommands(): Promise<unknown[]>;
  stopTask(taskId: string): Promise<void>;
  /**
   * WP-64: internal SDK methods (not in the public typings of 0.3.322); checked at runtime, a
   * missing method means REMOTE_CONTROL_UNAVAILABLE.
   */
  enableRemoteControl?(
    enabled: boolean,
    name?: string,
    opts?: { reattachSessionId?: string; keepSessionOnExit?: boolean },
  ): Promise<unknown>;
  getSettings?(): Promise<unknown>;
  /** WP-65: internal (not typed in 0.3.322) – a missing method means "no AI titles". */
  generateSessionTitle?(description: string, opts?: { persist?: boolean }): Promise<unknown>;
  /** WP-65: public in 0.3.322; optional so a missing method is a clean failure. */
  backgroundTasks?(toolUseId?: string): Promise<unknown>;
  /** WP-65: experimental (typed, name will change) – checked at runtime like the internal ones. */
  usage_EXPERIMENTAL_MAY_CHANGE_DO_NOT_RELY_ON_THIS_API_YET?(opts?: { skipBehaviors?: boolean }): Promise<unknown>;
  /** WP-66: internal (not typed in 0.3.322) – a missing method means "no side questions". */
  askSideQuestion?(
    question: string,
    opts?: { history?: { question: string; response: string }[]; signal?: AbortSignal },
  ): Promise<unknown>;
  /** WP-66: internal (not typed in 0.3.322) – a missing method means "cannot withdraw". */
  cancelAsyncMessage?(messageUuid: string): Promise<unknown>;
  /** WP-67: internal dialog requests (not typed in 0.3.322) – a missing method means "tab not available". */
  getStatus?(): Promise<unknown>;
  getMemoryDialog?(): Promise<unknown>;
  getSkillsDialog?(): Promise<unknown>;
  getHooksListing?(): Promise<unknown>;
  listPermissionRules?(): Promise<unknown>;
  exportConversation?(): Promise<unknown>;
  /** WP-67: public in 0.3.322; optional so a missing method is a clean failure. */
  mcpServerStatus?(): Promise<unknown>;
  reconnectMcpServer?(serverName: string): Promise<void>;
  toggleMcpServer?(serverName: string, enabled: boolean): Promise<void>;
  reloadSkills?(): Promise<unknown>;
  reloadPlugins?(): Promise<unknown>;
  /** WP-70: public in 0.3.322; optional so a missing method is a clean failure (holds `account`: never logged). */
  initializationResult?(): Promise<unknown>;
  /** WP-70: public in 0.3.322 (`localSettings` only with `outputStyle`). */
  updateSettings?(source: 'localSettings' | 'userSettings', settings: Record<string, unknown>): Promise<void>;
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
  /** Default: the server logger (tests capture the lines). */
  logger?: Logger;
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
        ...(content.title !== undefined ? { title: content.title } : {}),
      };
  }
}

/**
 * OutgoingPrompt → SDKUserMessage (F.1, WP-01): content is a plain string for exactly one text
 * block, else content blocks (image/document as base64 source); origin human, no parent tool use.
 * Phase 3 (ADR-146): pasted texts → `inline_pastes`, only when there are any; never
 * `client_composed`.
 */
export function toSdkUserMessage(prompt: OutgoingPrompt): SDKUserMessage {
  if (!isUuid(prompt.uuid)) throw new TypeError('prompt uuid must be a UUID');
  const [first] = prompt.content;
  const content: UserContent =
    prompt.content.length === 1 && first?.type === 'text' ? first.text : prompt.content.map(toUserBlock);
  const message: SDKUserMessage = {
    type: 'user',
    message: { role: 'user', content },
    parent_tool_use_id: null,
    uuid: prompt.uuid,
    priority: prompt.priority,
    origin: { kind: 'human' },
  };
  if (prompt.inlinePastes !== undefined && prompt.inlinePastes.length > 0) {
    message.inline_pastes = [...prompt.inlinePastes];
  }
  return message;
}

const interruptReceiptSchema = z.object({ still_queued: z.array(z.unknown()) });

/** interrupt() answer → still queued uuids; an old CLI answers `undefined` (F.10) → []. */
export function stillQueuedOf(raw: unknown): string[] {
  const parsed = interruptReceiptSchema.safeParse(raw);
  if (!parsed.success) return [];
  return parsed.data.still_queued.filter((uuid): uuid is string => typeof uuid === 'string');
}

const agentIdsSchema = z.array(z.unknown());

/**
 * WP61-04 (B15): only `credential_expires_at` of a `result` (ISO instant of the claude.ai login's
 * end; absent for API keys and older CLIs) – nothing else of the message reaches the log.
 */
const resultCredentialSchema = z.object({
  type: z.literal('result'),
  credential_expires_at: z.string().max(64).nullish().catch(null),
});

// ---- session ----

interface SessionContext {
  readonly query: SdkQueryFn;
  readonly spawn: typeof spawnHidden;
  readonly killProcessTree: (pid: number) => Promise<void>;
  readonly now: () => Date;
  readonly timeouts: SdkTimeouts;
  readonly log: Logger;
  disposed(): boolean;
  finished(session: SdkSession): void;
  /** WP-65: at most one warning per server process for a failing/missing usage query. */
  warnUsageOnce(fields: Record<string, unknown>, message: string): void;
  /** WP-67: one line per server process and `key` (later ones at debug) – never with answer values. */
  logInfoOnce(key: string, fields: Record<string, unknown>, message: string): void;
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
  /** WP61-04: the first `result` of this process was logged (credential expiry). */
  private firstResultSeen = false;
  /** WP-66: open side questions (a retry progress is attributed only while exactly one is open). */
  private readonly openSideQuestions = new Set<SideQuestionOptions>();
  /** WP-66: open title requests (they share the CLI's progress messages with side questions). */
  private openTitles = 0;

  /**
   * `login`: WP-70 login process of a profile (its own options: no settings sources, no MCP, no
   * transcript; stderr logged by length only – it may name the account).
   */
  constructor(
    private readonly req: StartSessionRequest,
    private readonly ctx: SessionContext,
    private readonly login: LoginRequest | null = null,
  ) {
    this.entryId = req.entryId;
    this.events = this.queue;
    this.log = login === null ? ctx.log.child({ entryId: req.entryId }) : ctx.log.child({ login: true });
  }

  get pid(): number | null {
    return this.currentPid;
  }

  // ---- start ----

  start(): void {
    const { req, ctx } = this;
    const login = this.login;
    if (login === null) {
      for (const issue of optionIssues(req)) this.log.warn({ issue }, 'claude option not mapped as configured');
    }
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
    const hooks = {
      canUseTool: this.canUseTool,
      spawn: spawner,
      stderr: (text: string) => {
        this.onStderr(text);
      },
    };
    const options = login === null ? buildQueryOptions(req, hooks) : buildLoginOptions(login, hooks);

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
    const flags = login === null ? flagSettingsAfterStart(req) : null;
    if (flags !== null) void this.applyAfterReady(q, flags);
  }

  private async pump(q: SdkQueryHandle): Promise<void> {
    try {
      for await (const message of q) {
        if (this.exitSent) break;
        if (!this.firstResultSeen) this.noteFirstResult(message);
        this.noteControlProgress(message);
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

  /** WP61-04 (B15): one debug line with the credential expiry at the first `result` of the process. */
  private noteFirstResult(message: unknown): void {
    const parsed = resultCredentialSchema.safeParse(message);
    if (!parsed.success) return;
    this.firstResultSeen = true;
    this.log.debug(
      { credentialExpiresAt: parsed.data.credential_expires_at ?? null },
      'first result: credential expiry',
    );
  }

  /**
   * C.1 (+ Phase 2 fast mode): settings file + profile autoCompactWindow / entry fast mode → flag
   * settings once the CLI is ready (WP61-02: no `todoFeatureEnabled`).
   */
  private async applyAfterReady(q: SdkQueryHandle, flags: StartFlagSettings): Promise<void> {
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

  /**
   * WP-66: `system/control_request_progress api_retry` → the open side question, but only when it is
   * the only open control request that reports progress (the CLI's request_id is unknown here).
   */
  private noteControlProgress(message: unknown): void {
    if (this.openSideQuestions.size !== 1 || this.openTitles > 0) return;
    const retry = controlRetryOf(message);
    if (retry === null) return;
    const [only] = this.openSideQuestions;
    try {
      only?.onRetry?.(retry);
    } catch (error) {
      this.log.warn({ err: error }, 'side question retry callback failed');
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
    // F.16: always read, always logged (the logger redacts tokens) – a login process by length only.
    if (this.login === null) {
      this.log.info({ pid: this.currentPid, stderr: text.slice(0, STDERR_LOG_CHARS) }, 'claude stderr');
    } else {
      this.log.info({ pid: this.currentPid, chars: text.length }, 'claude stderr (login, not logged)');
    }
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

  /** A control request with a bound (also used by the WP-70 login wrapper). */
  control<T>(label: string, ms: number, call: (q: SdkQueryHandle) => Promise<T>): Promise<T> {
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

  /**
   * WP-64: always keepSessionOnExit – a close or server restart keeps the bridge session, so the next
   * process reattaches to the same link. Never rejects (RemoteControlResult).
   */
  async setRemoteControl(enabled: boolean, req: RemoteControlRequest): Promise<RemoteControlResult> {
    if (this.q !== null && typeof this.q.enableRemoteControl !== 'function') {
      return { ok: false, error: makeError('REMOTE_CONTROL_UNAVAILABLE', { reason: 'sdk' }) };
    }
    const opts = {
      keepSessionOnExit: true,
      ...(req.reattachSessionId === null ? {} : { reattachSessionId: req.reattachSessionId }),
    };
    try {
      const raw = await this.control('enableRemoteControl', this.ctx.timeouts.controlMs, (q) => {
        if (q.enableRemoteControl === undefined) throw new Error('enableRemoteControl missing');
        return q.enableRemoteControl(enabled, req.name ?? undefined, opts);
      });
      return enabled ? toRemoteControlInfo(raw) : { ok: true, info: null };
    } catch (error) {
      const payload = remoteControlErrorOf(error);
      this.log.warn({ enabled, code: payload.code, params: payload.params }, 'remote control request failed');
      return { ok: false, error: payload };
    }
  }

  /** WP-64: Claude's own `remoteControlAtStartup` (getSettings().effective); null when unknown. */
  async readRemoteControlDefault(): Promise<boolean | null> {
    try {
      const raw = await this.control('getSettings', this.ctx.timeouts.controlMs, (q) =>
        q.getSettings === undefined ? Promise.resolve(null) : q.getSettings(),
      );
      return remoteControlDefaultOf(raw);
    } catch (error) {
      this.log.warn({ err: error }, 'reading the remote control default failed');
      return null;
    }
  }

  /** WP-65: AI title (internal method, checked at runtime); never rejects. */
  async generateTitle(description: string, opts: { persist: boolean }): Promise<TitleResult> {
    if (this.q !== null && typeof this.q.generateSessionTitle !== 'function') {
      return { ok: false, reason: 'unavailable' };
    }
    this.openTitles += 1;
    try {
      const raw = await this.control('generateSessionTitle', this.ctx.timeouts.titleMs, (q) => {
        if (q.generateSessionTitle === undefined) throw new Error('generateSessionTitle missing');
        return q.generateSessionTitle(description, { persist: opts.persist });
      });
      return { ok: true, title: titleOf(raw) };
    } catch (error) {
      this.log.warn({ err: error, persist: opts.persist }, 'generateSessionTitle failed');
      return { ok: false, reason: 'failed' };
    } finally {
      this.openTitles -= 1;
    }
  }

  /** WP-65: `backgroundTasks(toolUseId?)` (Ctrl+B); rejects when the request fails. */
  async backgroundTasks(toolUseId: string | null): Promise<boolean> {
    const raw = await this.control('backgroundTasks', this.ctx.timeouts.controlMs, (q) => {
      if (q.backgroundTasks === undefined) throw new Error('backgroundTasks missing');
      return toolUseId === null ? q.backgroundTasks() : q.backgroundTasks(toolUseId);
    });
    // `true` when at least one task went to the background; an old CLI may answer nothing.
    return raw !== false;
  }

  /** WP-65: plan limits of the experimental usage query (no transcript scan); never rejects. */
  async readUsage(): Promise<UsageLimits | null> {
    if (this.q !== null && typeof this.q.usage_EXPERIMENTAL_MAY_CHANGE_DO_NOT_RELY_ON_THIS_API_YET !== 'function') {
      this.ctx.warnUsageOnce({ reason: 'missing' }, 'usage query not available in this SDK/CLI');
      return null;
    }
    try {
      const raw = await this.control('usage', this.ctx.timeouts.controlMs, (q) => {
        if (q.usage_EXPERIMENTAL_MAY_CHANGE_DO_NOT_RELY_ON_THIS_API_YET === undefined) {
          throw new Error('usage query missing');
        }
        return q.usage_EXPERIMENTAL_MAY_CHANGE_DO_NOT_RELY_ON_THIS_API_YET({ skipBehaviors: true });
      });
      const limits = usageLimitsOf(raw);
      if (limits === null) this.log.debug('usage query: no plan limits in the answer');
      return limits;
    } catch (error) {
      this.ctx.warnUsageOnce({ err: error }, 'usage query failed');
      return null;
    }
  }

  /**
   * WP-66: side question (internal method, checked at runtime); never rejects. The caller's signal
   * cancels it (→ `cancelled`); after `sideQuestionMs` it is cancelled as `failed`.
   */
  async askSideQuestion(question: string, opts: SideQuestionOptions): Promise<SideQuestionResult> {
    if (this.q !== null && typeof this.q.askSideQuestion !== 'function') return { ok: false, reason: 'unavailable' };
    if (opts.signal.aborted) return { ok: false, reason: 'cancelled' };
    const abort = new AbortController();
    const onAbort = (): void => {
      abort.abort(new Error('Side question cancelled'));
    };
    opts.signal.addEventListener('abort', onAbort, { once: true });
    const history = opts.history.map((turn) => ({ question: turn.question, response: turn.response }));
    this.openSideQuestions.add(opts);
    try {
      const raw = await this.control('askSideQuestion', this.ctx.timeouts.sideQuestionMs, (q) => {
        if (q.askSideQuestion === undefined) throw new Error('askSideQuestion missing');
        return q.askSideQuestion(question, { ...(history.length > 0 ? { history } : {}), signal: abort.signal });
      });
      const answer = sideAnswerOf(raw);
      if (answer === 'invalid') {
        this.log.warn('askSideQuestion: unknown answer shape');
        return { ok: false, reason: 'unavailable' };
      }
      return { ok: true, answer };
    } catch (error) {
      const reason = sideQuestionFailure(error, opts.signal.aborted);
      // A timeout leaves the CLI request open: cancel it (control_cancel_request).
      if (!abort.signal.aborted) abort.abort(new Error('Side question timed out'));
      if (reason !== 'cancelled') this.log.warn({ err: error, reason }, 'askSideQuestion failed');
      return { ok: false, reason };
    } finally {
      this.openSideQuestions.delete(opts);
      opts.signal.removeEventListener('abort', onAbort);
    }
  }

  /**
   * WP-67: one "Session info" tab (internal methods checked at runtime, `mcpServerStatus` typed);
   * null when this CLI cannot answer it, rejects when the request failed. The answer is never logged
   * (status rows hold account data) – only the unknown keys and why a tab is not available, once.
   */
  async readInfo(section: SessionInfoSectionName): Promise<SessionInfoSection | null> {
    const method = INFO_METHODS[section];
    if (this.q !== null && typeof this.q[method] !== 'function') {
      this.ctx.logInfoOnce(`${section}:missing`, { section, method }, 'session info: method missing in this SDK/CLI');
      return null;
    }
    let raw: unknown;
    try {
      raw = await this.control(method, this.ctx.timeouts.infoMs, (q) => {
        const call = q[method]?.();
        if (call === undefined) throw new Error(`${method} missing`);
        return call;
      });
    } catch (error) {
      if (sessionInfoFailure(error) === 'unavailable') {
        this.ctx.logInfoOnce(`${section}:refused`, { section, err: error }, 'session info: this CLI does not answer the request');
        return null;
      }
      this.log.warn({ err: error, section }, 'session info request failed');
      throw error;
    }
    const parsed = sessionInfoOf(section, raw);
    if (parsed.unknown.length > 0) {
      this.ctx.logInfoOnce(
        `${section}:unknown:${parsed.unknown.join(',')}`,
        { section, unknown: parsed.unknown },
        'session info: unknown fields ignored',
      );
    }
    if (parsed.data === null) {
      this.ctx.logInfoOnce(`${section}:shape`, { section }, 'session info: unknown answer shape – tab not available');
      return null;
    }
    return parsed.data;
  }

  /** WP-67: `reconnectMcpServer` / `toggleMcpServer`; rejects when it fails or is missing. */
  async mcpAction(server: string, action: McpAction): Promise<void> {
    await this.control(`mcp ${action}`, this.ctx.timeouts.infoActionMs, (q) => {
      if (action === 'reconnect') {
        if (q.reconnectMcpServer === undefined) throw new Error('reconnectMcpServer missing');
        return q.reconnectMcpServer(server);
      }
      if (q.toggleMcpServer === undefined) throw new Error('toggleMcpServer missing');
      return q.toggleMcpServer(server, action === 'enable');
    });
  }

  /** WP-67: `reloadSkills` / `reloadPlugins` (applied at once); rejects when it fails or is missing. */
  async reload(what: ReloadTarget): Promise<void> {
    await this.control(`reload ${what}`, this.ctx.timeouts.infoActionMs, (q) => {
      const call = what === 'skills' ? q.reloadSkills?.() : q.reloadPlugins?.();
      if (call === undefined) throw new Error(`reload ${what} missing`);
      return call;
    });
  }

  /** WP-70: `output_style`/`available_output_styles` of `initializationResult()`; never rejects. */
  async readOutputStyles(): Promise<OutputStyles | null> {
    if (this.q !== null && typeof this.q.initializationResult !== 'function') {
      this.ctx.logInfoOnce('outputStyles:missing', {}, 'initializationResult missing in this SDK – output styles unknown');
      return null;
    }
    try {
      const raw = await this.control('initializationResult', this.ctx.timeouts.readyMs, (q) => {
        if (q.initializationResult === undefined) throw new Error('initializationResult missing');
        return q.initializationResult();
      });
      const styles = outputStylesOf(raw);
      if (styles === null) this.ctx.logInfoOnce('outputStyles:shape', {}, 'initializationResult: no output styles');
      return styles;
    } catch (error) {
      this.log.debug({ err: error }, 'reading the output styles failed');
      return null;
    }
  }

  /** WP-70: `updateSettings('localSettings', { outputStyle })`; never rejects. */
  async setOutputStyle(style: string): Promise<{ ok: true } | { ok: false; error: ErrorPayload }> {
    try {
      await this.control('updateSettings', this.ctx.timeouts.controlMs, (q) => {
        if (q.updateSettings === undefined) throw new Error('updateSettings missing');
        return q.updateSettings('localSettings', { outputStyle: style });
      });
      this.log.info({ style }, 'output style written (localSettings)');
      return { ok: true };
    } catch (error) {
      this.log.warn({ err: error }, 'updateSettings failed');
      return { ok: false, error: makeError('CLAUDE_CONTROL_FAILED', { method: 'updateSettings' }) };
    }
  }

  /** WP-66: `cancelAsyncMessage(uuid)` (internal method); rejects when it fails or is missing. */
  async withdrawQueued(messageUuid: string): Promise<boolean> {
    const raw = await this.control('cancelAsyncMessage', this.ctx.timeouts.controlMs, (q) => {
      if (q.cancelAsyncMessage === undefined) throw new Error('cancelAsyncMessage missing');
      return q.cancelAsyncMessage(messageUuid);
    });
    return withdrawnOf(raw);
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

/** WP-70: the StartSessionRequest a login process carries (only its launch and cwd are used). */
function loginStartRequest(req: LoginRequest): StartSessionRequest {
  return {
    entryId: 'login',
    cwd: req.cwd,
    launch: req.launch,
    resumeSessionId: null,
    model: null,
    permissionMode: null,
    effort: null,
    promptSuggestions: false,
    canUseTool: () => Promise.resolve({ behavior: 'deny', message: PERMISSION_FAILURE_MESSAGE }),
  };
}

/** WP-67: the SDK method behind each "Session info" tab (checked against the handle type). */
const INFO_METHODS = SESSION_INFO_METHODS satisfies Record<SessionInfoSectionName, keyof SdkQueryHandle>;

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
  let usageWarned = false;
  const infoLogged = new Set<string>();
  const backendLog = deps.logger === undefined ? log : deps.logger.child({ module: 'backend/sdk' });
  const ctx: SessionContext = {
    query,
    spawn: deps.spawn ?? spawnHidden,
    killProcessTree: deps.killProcessTree ?? killTree,
    now: deps.now ?? (() => new Date()),
    timeouts: { ...SDK_TIMEOUTS, ...deps.timeouts },
    log: backendLog,
    disposed: () => disposed,
    finished: (session) => {
      live.delete(session);
    },
    warnUsageOnce: (fields, message) => {
      if (usageWarned) {
        backendLog.debug(fields, message);
        return;
      }
      usageWarned = true;
      backendLog.warn(fields, `${message} – the limit bar keeps the last rate-limit values`);
    },
    logInfoOnce: (key, fields, message) => {
      if (infoLogged.has(key)) {
        backendLog.debug(fields, message);
        return;
      }
      infoLogged.add(key);
      backendLog.info(fields, message);
    },
  };

  const subagentIds = async (req: HistoryRequest): Promise<string[]> => {
    const raw = await history.run(req.launch, { op: 'subagents', sessionId: req.sessionId });
    const parsed = agentIdsSchema.safeParse(raw);
    if (!parsed.success) {
      backendLog.warn({ sessionId: req.sessionId }, 'listSubagents returned no list; ignored');
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

    /** WP-70: a login process (SdkSession in login mode; closed with the backend like any session). */
    startLogin(req): LoginSession {
      const session = new SdkSession(loginStartRequest(req), ctx, req);
      live.add(session);
      session.start();
      return createLoginSession(session, ctx.timeouts, backendLog.child({ login: true }));
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

    /** WP-69: one subagent's transcript from `from` on, sliced in the worker (only the new part crosses). */
    async readSubagentHistory(req) {
      return toSubagentSlice(
        await history.run(req.launch, {
          op: 'subagentSlice',
          sessionId: req.sessionId,
          agentId: req.agentId,
          from: req.from,
        }),
      );
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
