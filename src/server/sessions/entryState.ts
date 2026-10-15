/**
 * State of one registry entry in the session engine (WP-13 §3.5.2): the entry (single source,
 * persisted after every change), the status facts (only through `reduceStatus`), broker, prompt
 * queue, mirror view, the runtime of the running process and the lifecycle lock. The ONE op path
 * (§2.3 Nr. 2) lives here: `emit(ops)` publishes → writes the transcript log (non-streaming
 * upserts/removes of the current conversation) → updates the mirror (or the loading buffer) →
 * `conversation.lastOrder`. Summaries go out after every change of entry or facts.
 */
import { isDeepStrictEqual } from 'node:util';
import type { Logger } from 'pino';
import type { ConversationId, EntryId, JsonValue, ProfileId } from '@shared/common';
import { makeError, type ErrorPayload } from '@shared/errors';
import {
  currentConversation,
  currentSessionId,
  type CappedText,
  type ContextBreakdown,
  type ContextGauge,
  type Conversation,
  type Entry,
  type Profile,
  type RateLimitInfo,
  type SessionSummary,
  type ToolCallItem,
  type ToolDecisionRef,
  type TranscriptItem,
  type Truncation,
} from '@shared/model';
import type { SessionOp } from '@shared/protocol';
import type { StatusFacts } from '@shared/status';
import type { SessionViewState } from '@shared/sync';
import type { AgentBackend } from '../backend/types';
import type { ClaudeIntegration } from '../claude/ports';
import type { newId } from '../lib/ids';
import type { ProcessFilter, ProcessQueryResult } from '../lib/process';
import { isStreamingItem } from '../store/transcripts';
import {
  CommandError,
  type BlobStore,
  type DecisionStore,
  type RegistryStore,
  type SessionPublisher,
  type SettingsStore,
  type StoreWarnings,
  type TranscriptStore,
} from '../sync/ports';
import { createBroker, type Broker } from './broker';
import { createSerial, type Serial } from './lib/serial';
import type { TimerHandle, Timers } from './lib/timers';
import { applyToMirror, baseView, findToolCallIn, readMirrorItems } from './mirror';
import { currentModelOption, type ModelCatalog } from './models';
import type {
  CreateLiveNormalizer,
  NormalizeContextUsage,
  NormalizeHistory,
  ReduceStatus,
  StatusEvent,
} from './ports';
import type { estimateContextGauge } from './normalizer';
import type { ProcessStore } from './processStore';
import { PromptQueue } from './promptQueue';
import { INITIAL_RETRY_STATE, type AutoRetryPolicy, type RetryState } from './retry';
import type { SessionRuntime } from './runtime';
import { acceptsAiTitle, aiTitleFrom, summaryOf, withCurrentConversation } from './summary';

// =====================================================================================
// Engine services shared by all entries (built by manager.ts)
// =====================================================================================

export interface SessionManagerOptions {
  /** ADR-025; false = never restart automatically. Default [2000, 10000, 30000] / 300000. */
  autoRetry: AutoRetryPolicy | false;
  /** Debounce of getContextUsage after idle (C.1). Default 250. */
  contextRefreshDelayMs: number;
  /** Upper bound for closing all sessions at shutdown, then taskkill. Default 15000. */
  shutdownTimeoutMs: number;
  /** B "Setting": costs one request per turn. Default false. */
  promptSuggestions: boolean;
  /**
   * Delay of the AI-title query after a turn (C.6, §3.5.8): the CLI writes its AI title
   * asynchronously after the result. Default 2000.
   */
  aiTitleDelayMs: number;
}

export interface EngineStores {
  registry: RegistryStore;
  transcripts: TranscriptStore;
  decisions: DecisionStore;
  blobs: BlobStore;
  settings: SettingsStore;
  warnings: StoreWarnings;
  processes: ProcessStore;
}

export interface NormalizerFns {
  createLiveNormalizer: CreateLiveNormalizer;
  normalizeHistory: NormalizeHistory;
  normalizeContextUsage: NormalizeContextUsage;
  estimateContextGauge: typeof estimateContextGauge;
}

export interface ProcDeps {
  /** Instant pre-filter of the orphan cleanup (lib/process.ts, `process.kill(pid, 0)`). */
  isProcessAlive(pid: number): boolean;
  /** One bundled, three-valued CIM query for all live orphan PIDs (lib/process.ts, R2-02). */
  queryProcesses(filter: ProcessFilter): Promise<ProcessQueryResult>;
  killProcessTree(pid: number): Promise<void>;
}

/**
 * Phase-2 idle sleep (§3.5.17): delay until a sleeping attempt, or null. Default: never. Sleep
 * also needs `canSleep(facts)` and – before it is enabled – wakeup/`/loop` detection (R0-27).
 */
export interface SleepPolicy {
  schedule(entryId: EntryId, facts: StatusFacts, now: Date): number | null;
}

export const NEVER_SLEEP: SleepPolicy = { schedule: () => null };

export interface EngineCore {
  readonly backend: AgentBackend;
  readonly claude: ClaudeIntegration;
  readonly stores: EngineStores;
  readonly normalizer: NormalizerFns;
  readonly reduceStatus: ReduceStatus;
  readonly ids: { newId: typeof newId; newUuid: () => string };
  readonly checkCwd: (cwd: string) => Promise<void>;
  readonly proc: ProcDeps;
  readonly capText: (text: string) => CappedText;
  readonly capInput: (input: Record<string, unknown>) => { input: JsonValue; truncated: Truncation | null };
  readonly gitBranch: (cwd: string, env: Record<string, string>) => Promise<string | null>;
  readonly sleepPolicy: SleepPolicy;
  readonly now: () => Date;
  readonly timers: Timers;
  readonly options: SessionManagerOptions;
  readonly log: Logger;
  publisher(): SessionPublisher;
  shuttingDown(): boolean;
  /** Throws CommandError(SERVER_SHUTTING_DOWN) once the shutdown began. */
  assertRunning(): void;
  /** Logs and reports an unexpected error (tests collect them, WP-20 ignores). */
  reportError(error: unknown, context: string): void;
  publishHostState(): void;
  /** Debounced (1 s) host-state publication, e.g. after rate limits. */
  scheduleHostState(): void;
  setEngineWarning(id: string, error: ErrorPayload | null): void;
  setAccountLimit(profileId: ProfileId, info: RateLimitInfo): void;
  models(profileId: ProfileId): ModelCatalog | null;
  setModels(profileId: ProfileId, catalog: ModelCatalog): void;
  allowsBypass(profileId: ProfileId): boolean;
  profile(profileId: ProfileId): Profile | undefined;
  /** Notifications, clearing, sleep policy – after every change of the facts. */
  factsChanged(state: EntryState, prev: StatusFacts, next: StatusFacts): void;
}

export type EntryPhase = 'dormant' | 'starting' | 'running' | 'closing';

export interface EntryStateInit {
  /** Title derived from the first prompt (session.create); the AI-title heuristic needs it. */
  promptTitle?: string | null;
}

/** Mutable state of one entry; see the file comment. */
export class EntryState {
  entry: Entry;
  facts: StatusFacts;
  readonly broker: Broker;
  readonly queue = new PromptQueue();
  /** start/close/resume/rename (dormant)/retry one after another. */
  readonly lifecycle: Serial = createSerial();
  mirror: SessionViewState | null = null;
  loading: { buffer: SessionOp[]; promise: Promise<SessionViewState> } | null = null;
  runtime: SessionRuntime | null = null;
  phase: EntryPhase = 'dormant';
  /** Title of the own pending `/rename X` (its echo becomes `custom`). */
  pendingRename: string | null = null;
  /** A turn after a conversation_reset is running (title_changed echoes are ignored). */
  resetInTurn = false;
  promptTitle: string | null;
  retry: RetryState = INITIAL_RETRY_STATE;
  retryTimer: TimerHandle | null = null;
  /** The start waits for the orphan cleanup of this entry (never two writers on one JSONL). */
  orphanCleanup: Promise<void> = Promise.resolve();
  /**
   * A recorded claude.exe of this entry was still alive at the server start and its check is still
   * running (R2-02): a start then shows `starting` while it waits.
   */
  orphanPending = false;
  viewedByVisibleClient = false;
  /** Hub subscribers (onSubscribersChanged). */
  subscribers = 0;
  lastSdkMaxTokens: number | null = null;
  /** Phase 2 display (Plan "Git-Branch"); refreshed at the end of every turn, not persisted. */
  gitBranch: string | null = null;
  sleepTimer: TimerHandle | null = null;
  private titleTimer: TimerHandle | null = null;
  private lastSummary: SessionSummary | null = null;
  private dirty = false;
  private urgent = false;
  private flushQueued = false;
  private contextTimer: TimerHandle | null = null;
  private contextBusy = false;
  private contextAgain = false;
  private titleBusy = false;
  private gitBusy = false;

  constructor(
    private readonly core: EngineCore,
    entry: Entry,
    facts: StatusFacts,
    init: EntryStateInit = {},
  ) {
    this.entry = entry;
    this.facts = facts;
    this.promptTitle = init.promptTitle ?? null;
    this.broker = createBroker({
      entryId: entry.id,
      now: core.now,
      newDecisionId: () => core.ids.newId('dc'),
      store: core.stores.decisions,
      conversationId: () => this.conversationId(),
      permissionMode: () => this.entry.permissionMode,
      allowsBypass: () => core.allowsBypass(this.entry.profileId),
      supportsAutoMode: () => this.supportsAutoMode(),
      findToolCall: (toolUseId) => this.findToolCall(toolUseId),
      capInput: core.capInput,
      emit: (ops) => {
        this.emit(ops);
      },
      attachDecision: (toolUseId, ref) => {
        this.attachDecision(toolUseId, ref);
      },
      onCountsChanged: (counts) => {
        this.reduce({ type: 'decisions_changed', decisions: counts });
      },
    });
  }

  get id(): EntryId {
    return this.entry.id;
  }

  conversation(): Conversation {
    return currentConversation(this.entry);
  }

  conversationId(): ConversationId {
    return this.conversation().id;
  }

  // ---- the op path ----

  /** Publish → log → mirror (or loading buffer) → lastOrder (§3.5.4). */
  emit(ops: readonly SessionOp[]): void {
    if (ops.length === 0) return;
    this.core.publisher().publishOps(this.entry.id, [...ops]);
    const conv = this.conversation();
    const at = this.core.now().toISOString();
    let lastOrder = conv.lastOrder;
    for (const op of ops) {
      if (op.op === 'item.upsert') {
        if (!isStreamingItem(op.item)) {
          this.core.stores.transcripts.append(this.entry.id, conv.id, {
            v: 1,
            at,
            op: 'upsert',
            item: op.item,
          });
        }
        lastOrder = Math.max(lastOrder, op.item.order);
      } else if (op.op === 'item.remove') {
        this.core.stores.transcripts.append(this.entry.id, conv.id, {
          v: 1,
          at,
          op: 'remove',
          itemId: op.itemId,
        });
      }
    }
    if (this.loading !== null) this.loading.buffer.push(...ops);
    else if (this.mirror !== null) this.mirror = applyToMirror(this.mirror, ops);
    if (lastOrder !== conv.lastOrder) {
      this.entry = withCurrentConversation(this.entry, (c) => ({ ...c, lastOrder }));
      this.touch();
    }
  }

  /** Engine-made `system/error` item (`px:` id, order = lastOrder + 1) – only without a live normalizer. */
  addSystemError(error: ErrorPayload): void {
    const conv = this.conversation();
    const order = conv.lastOrder + 1;
    const item: TranscriptItem = {
      id: `px:${conv.id}:${String(order)}`,
      order,
      at: this.core.now().toISOString(),
      parentToolUseId: null,
      kind: 'system',
      event: 'error',
      error,
    };
    this.emit([{ op: 'item.upsert', item }]);
  }

  /** `detail.patch {queue}` + `queue_changed` after every queue change (§3.5.7). */
  publishQueue(): void {
    this.emit([{ op: 'detail.patch', patch: { queue: this.queue.list() } }]);
    this.reduce({ type: 'queue_changed', count: this.queue.count() });
  }

  // ---- facts ----

  reduce(event: StatusEvent): void {
    // Shutdown: the last state stays persisted (e.g. working → interrupted after the restart).
    if (this.core.shuttingDown()) return;
    const prev = this.facts;
    const next = this.core.reduceStatus(prev, event, this.core.now(), {
      viewedByVisibleClient: this.viewedByVisibleClient,
      sessionStateSeen: this.runtime?.sessionStateSeen ?? false,
    });
    if (next === prev) return;
    this.facts = next;
    if (this.entry.lastRunState !== next.runState || this.entry.unread !== next.unread) {
      this.entry = { ...this.entry, lastRunState: next.runState, unread: next.unread };
    }
    this.touch(true);
    this.core.factsChanged(this, prev, next);
  }

  // ---- entry changes, persistence, summary ----

  patch(change: (entry: Entry) => Entry): void {
    const next = change(this.entry);
    if (next === this.entry) return;
    this.entry = next;
    this.touch();
  }

  setLastError(error: ErrorPayload | null): void {
    if (error === null) {
      if (this.entry.lastError !== null) this.patch((e) => ({ ...e, lastError: null }));
      return;
    }
    this.patch((e) => ({ ...e, lastError: { ...error, at: this.core.now().toISOString() } }));
  }

  /** Gauge from getContextUsage (sdk) or the estimate during the turn (C.1, F.12). */
  setContext(gauge: ContextGauge): void {
    if (gauge.source === 'sdk') this.lastSdkMaxTokens = gauge.maxTokens;
    this.patch((e) => ({ ...e, context: gauge, contextPct: Math.round(gauge.percentage) }));
  }

  /** Persist + summary, coalesced per microtask (one registry write per normalizer output). */
  touch(urgent = false): void {
    this.dirty = true;
    this.urgent ||= urgent;
    if (this.flushQueued) return;
    this.flushQueued = true;
    queueMicrotask(() => {
      this.flush();
    });
  }

  flush(): void {
    this.flushQueued = false;
    if (!this.dirty) return;
    this.dirty = false;
    const urgent = this.urgent;
    this.urgent = false;
    try {
      this.core.stores.registry.upsert(this.entry);
    } catch (error) {
      this.core.reportError(error, 'registry.upsert');
    }
    this.publishSummary(urgent);
  }

  summary(): SessionSummary {
    return summaryOf(this.entry, this.facts, { gitBranch: this.gitBranch });
  }

  publishSummary(urgent: boolean): void {
    const summary = this.summary();
    if (this.lastSummary !== null && isDeepStrictEqual(summary, this.lastSummary)) return;
    this.lastSummary = summary;
    this.core.publisher().publishSummary(summary, urgent);
  }

  // ---- mirror / loadView (§3.5.11) ----

  loadView(): Promise<SessionViewState> {
    return this.mirror === null ? this.ensureMirror() : Promise.resolve(this.mirror);
  }

  /** Builds the mirror from the log (+ history fallback); ops meanwhile go to the buffer. */
  ensureMirror(): Promise<SessionViewState> {
    if (this.mirror !== null) return Promise.resolve(this.mirror);
    if (this.loading !== null) return this.loading.promise;
    const buffer: SessionOp[] = [];
    const promise = (async () => {
      try {
        const read = await readMirrorItems(this.entry, {
          transcripts: this.core.stores.transcripts,
          backend: this.core.backend,
          claude: this.core.claude,
          normalizeHistory: this.core.normalizer.normalizeHistory,
          storeBlob: (data, mediaType, name) => this.core.stores.blobs.put(data, mediaType, name),
          now: this.core.now,
          onHistoryError: (error) => {
            this.core.log.warn({ err: error, entryId: this.entry.id }, 'history import failed');
          },
        });
        if (read.imported.length > 0) this.importHistory(read.imported);
        // The base is built now (current broker, queue, conversations); ops published while
        // reading are applied on top – the view contains every op published so far (WP-10 Nr. 5).
        const base = baseView({
          entry: this.entry,
          items: read.items,
          hasEarlier: read.hasEarlier,
          decisions: [...this.broker.expired(), ...this.broker.open()],
          models: this.core.models(this.entry.profileId)?.options ?? null,
          queue: this.queue.list(),
        });
        const view = applyToMirror(base, buffer);
        this.mirror = view;
        return view;
      } finally {
        this.loading = null;
      }
    })();
    this.loading = { buffer, promise };
    return promise;
  }

  /** A mirror without log items (the log could not be read; the session still needs one). */
  emptyMirror(): SessionViewState {
    const view = baseView({
      entry: this.entry,
      items: [],
      hasEarlier: this.conversation().lastOrder > 0,
      decisions: [...this.broker.expired(), ...this.broker.open()],
      models: this.core.models(this.entry.profileId)?.options ?? null,
      queue: this.queue.list(),
    });
    this.mirror = view;
    return view;
  }

  /** Cache eviction (B): without process and subscribers the mirror is dropped. */
  dropMirrorIfUnused(): void {
    if (this.runtime === null && this.subscribers === 0 && this.loading === null) this.mirror = null;
  }

  /** One-time import of the Claude history into the log (A.3). */
  private importHistory(items: readonly TranscriptItem[]): void {
    const conv = this.conversation();
    const at = this.core.now().toISOString();
    let lastOrder = conv.lastOrder;
    for (const item of items) {
      this.core.stores.transcripts.append(this.entry.id, conv.id, { v: 1, at, op: 'upsert', item });
      lastOrder = Math.max(lastOrder, item.order);
    }
    this.core.log.info({ entryId: this.entry.id, items: items.length }, 'transcript imported from history');
    if (lastOrder !== conv.lastOrder) {
      this.entry = withCurrentConversation(this.entry, (c) => ({ ...c, lastOrder }));
      this.touch();
    }
  }

  findToolCall(toolUseId: string): ToolCallItem | null {
    return findToolCallIn(this.mirror, toolUseId);
  }

  /** Broker → normalizer (tool call status/ref) → emit; no-op without a live normalizer. */
  attachDecision(toolUseId: string, ref: ToolDecisionRef): void {
    const rt = this.runtime;
    if (!rt?.alive) return;
    this.emit(rt.normalizer.attachDecision(toolUseId, ref).ops);
  }

  /** Plan approveModes offer `auto` only if the current model supports it (C.4). */
  private supportsAutoMode(): boolean {
    const catalog = this.core.models(this.entry.profileId);
    return (
      currentModelOption(catalog, this.entry.modelSetting, this.entry.lastModel)?.supportsAutoMode ?? false
    );
  }

  // ---- timers and background queries of a running process ----

  cancelRetry(): void {
    this.retryTimer?.cancel();
    this.retryTimer = null;
  }

  /** Timers of a running process (context refresh, idle sleep) – not the retry of a crashed one. */
  cancelProcessTimers(): void {
    this.contextTimer?.cancel();
    this.contextTimer = null;
    this.sleepTimer?.cancel();
    this.sleepTimer = null;
    this.titleTimer?.cancel();
    this.titleTimer = null;
  }

  /** After a non-synthetic turn: AI-title query, debounced (the CLI writes the title after the result). */
  scheduleAiTitle(): void {
    if (this.runtime === null) return;
    this.titleTimer?.cancel();
    this.titleTimer = this.core.timers.setTimeout(() => {
      this.titleTimer = null;
      void this.queryAiTitle();
    }, this.core.options.aiTitleDelayMs);
  }

  cancelTimers(): void {
    this.cancelRetry();
    this.cancelProcessTimers();
  }

  /** After idle (C.1): one getContextUsage('summary'), debounced, at most one at a time. */
  scheduleContextRefresh(): void {
    if (this.runtime === null) return;
    this.contextTimer?.cancel();
    this.contextTimer = this.core.timers.setTimeout(() => {
      this.contextTimer = null;
      void this.refreshContext();
    }, this.core.options.contextRefreshDelayMs);
  }

  private async refreshContext(): Promise<void> {
    const rt = this.runtime;
    if (!rt?.alive) return;
    if (this.contextBusy) {
      this.contextAgain = true;
      return;
    }
    this.contextBusy = true;
    try {
      const raw = await rt.agent.getContextUsage('summary');
      const breakdown = this.core.normalizer.normalizeContextUsage(
        raw,
        { contextWindow: rt.launch.contextWindow },
        this.core.now(),
        'summary',
      );
      if (breakdown !== null && this.runtime === rt) this.setContext(gaugeOf(breakdown));
    } catch (error) {
      this.core.log.debug({ err: error, entryId: this.entry.id }, 'getContextUsage failed');
    } finally {
      this.contextBusy = false;
      if (this.contextAgain) {
        this.contextAgain = false;
        this.scheduleContextRefresh();
      }
    }
  }

  /** After a non-synthetic turn (C.6, F.8): AI title via getSessionInfo, one at a time. */
  async queryAiTitle(): Promise<void> {
    const rt = this.runtime;
    const sessionId = currentSessionId(this.entry);
    if (rt === null || sessionId === null || this.titleBusy || !acceptsAiTitle(this.entry.titleSource))
      return;
    this.titleBusy = true;
    try {
      const info = await this.core.backend.getSessionInfo({
        sessionId,
        cwd: this.entry.cwd,
        launch: rt.launch,
      });
      if (currentSessionId(this.entry) !== sessionId) return;
      const title = aiTitleFrom(info, this.titleContext());
      if (title !== null) this.patch((e) => ({ ...e, title, titleSource: 'ai' }));
    } catch (error) {
      this.core.log.debug({ err: error, entryId: this.entry.id }, 'getSessionInfo failed');
    } finally {
      this.titleBusy = false;
    }
  }

  private titleContext(): { title: string; titleSource: Entry['titleSource']; promptTitle: string | null } {
    return { title: this.entry.title, titleSource: this.entry.titleSource, promptTitle: this.promptTitle };
  }

  /** At the end of every turn: branch via `resolveExecutable('git')` (R1-04), one at a time. */
  async refreshGitBranch(): Promise<void> {
    const rt = this.runtime;
    if (rt === null || this.gitBusy) return;
    this.gitBusy = true;
    try {
      const branch = await this.core.gitBranch(this.entry.cwd, rt.launch.env);
      if (branch !== this.gitBranch) {
        this.gitBranch = branch;
        this.touch();
      }
    } catch (error) {
      this.core.log.debug({ err: error, entryId: this.entry.id }, 'git branch lookup failed');
    } finally {
      this.gitBusy = false;
    }
  }

  /** Start failure without a process (§3.5.3 Nr. 2): error facts, px item, lastError. */
  failStart(error: ErrorPayload): void {
    this.reduce({ type: 'process_starting' });
    this.reduce({ type: 'process_exit', expected: false, error });
    this.addSystemError(error);
    this.setLastError(error);
  }
}

/** ContextBreakdown → the gauge fields stored on the entry. */
export function gaugeOf(breakdown: ContextBreakdown): ContextGauge {
  return {
    percentage: breakdown.percentage,
    totalTokens: breakdown.totalTokens,
    maxTokens: breakdown.maxTokens,
    source: breakdown.source,
    model: breakdown.model,
    at: breakdown.at,
  };
}

/** `ErrorPayload` of a thrown value (CommandError → its payload, others → fallback). */
export function errorPayloadOf(error: unknown, fallback: ErrorPayload): ErrorPayload {
  return error instanceof CommandError ? error.error : fallback;
}

/** English message of a thrown value (logs and `ErrorPayload.message` only, never shown). */
export function errorMessage(error: unknown): string {
  return (error instanceof Error ? error.message : String(error)).slice(0, 2000);
}

/** CommandError(code, params) shortcut. */
export function commandError(
  code: Parameters<typeof makeError>[0],
  params: Parameters<typeof makeError>[1] = {},
): CommandError {
  return new CommandError(makeError(code, params));
}
