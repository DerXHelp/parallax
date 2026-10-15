/**
 * `SessionManager` (WP-13 §3.5): implements the port `SessionSource` (sync/ports.ts) on top of an
 * `AgentBackend` (Sdk or Fake). Lifecycle per entry (dormant at server start, resume on
 * interaction, ready after `supportedModels()`), all Phase-1 commands (commands.ts), prompt queue,
 * normalizer + status machine, mirror views for `loadView`, summaries/ops/host state through the
 * `SessionPublisher` (the hub), persistence through the stores, crash/auto-retry, server start
 * (recovery, orphans) and shutdown. Wiring for WP-20: docs/wp/WP-13b.md "Verdrahtung".
 */
import type { Logger } from 'pino';
import { jsonValueSchema, type EntryId, type ProfileId } from '@shared/common';
import { makeError, type ErrorPayload } from '@shared/errors';
import {
  currentConversation,
  type Entry,
  type HostState,
  type HostWarning,
  type QueuedPrompt,
  type RateLimitInfo,
} from '@shared/model';
import type { Notification } from '@shared/protocol';
import { canSleep, INITIAL_STATUS_FACTS, type StatusFacts } from '@shared/status';
import type { SessionViewState } from '@shared/sync';
import type { AgentBackend } from '../backend/types';
import { profileNeedsSetup } from '../claude/integration';
import type { ClaudeIntegration } from '../claude/ports';
import { newId, newUuid } from '../lib/ids';
import { logger as rootLogger } from '../lib/logger';
import { checkCwd as realCheckCwd } from '../lib/paths';
import { childProcesses, killProcessTree, processInfo } from '../lib/process';
import {
  CommandError,
  type ClientPresence,
  type CommandContext,
  type SessionPublisher,
  type SessionSource,
} from '../sync/ports';
import { handleCommand, type CommandEngine } from './commands';
import {
  EntryState,
  NEVER_SLEEP,
  type EngineCore,
  type EngineStores,
  type NormalizerFns,
  type ProcDeps,
  type SessionManagerOptions,
  type SleepPolicy,
} from './entryState';
import { readGitBranch } from './lib/gitBranch';
import { realTimers, type TimerHandle, type Timers } from './lib/timers';
import type { ModelCatalog } from './models';
import {
  capInput as normalizerCapInput,
  capText as normalizerCapText,
  createLiveNormalizer,
  estimateContextGauge,
  normalizeContextUsage,
  normalizeHistory,
} from './normalizer';
import { decisionsCleared, isViewedByVisibleClient, planNotification } from './notifier';
import type { ReduceStatus } from './ports';
import type { ProcessStore } from './processStore';
import { cleanupOrphan, interruptedToolCalls, registryFacts, wasActive } from './recovery';
import { DEFAULT_AUTO_RETRY } from './retry';
import { closeRuntime } from './runtime';
import { reduceStatus as realReduceStatus } from './status/machine';
import { cwdLabel } from './summary';

export type { SessionManagerOptions, SleepPolicy } from './entryState';

export const DEFAULT_SESSION_MANAGER_OPTIONS: SessionManagerOptions = {
  autoRetry: DEFAULT_AUTO_RETRY,
  contextRefreshDelayMs: 250,
  shutdownTimeoutMs: 15_000,
  promptSuggestions: false,
  aiTitleDelayMs: 2_000,
};

/** Debounce of host-state publications after rate-limit events (§3.5.5). */
export const HOST_STATE_DEBOUNCE_MS = 1_000;
/** Items read at a restart to finalize the tool calls of an interrupted turn. */
export const RECOVERY_TAIL_ITEMS = 500;

export interface SessionManagerDeps {
  backend: AgentBackend;
  claude: ClaudeIntegration;
  stores: EngineStores;
  host: {
    serverVersion: string;
    sdkVersion: string;
    sdkClaudeCodeVersion: string;
    platform: string;
    dataDirLabel: string;
    dev: boolean;
  };
  /** Called (setImmediate) after server.shutdown was acknowledged; WP-20 then calls shutdown(). */
  onShutdownRequested?: () => void;
  // Defaults = the real modules (tests override):
  normalizer?: Partial<NormalizerFns>;
  reduceStatus?: ReduceStatus;
  ids?: { newId: typeof newId; newUuid: () => string };
  checkCwd?: (cwd: string) => Promise<void>;
  proc?: Partial<ProcDeps>;
  capInput?: EngineCore['capInput'];
  capText?: EngineCore['capText'];
  /** Git branch of a cwd (default: `readGitBranch` via resolveExecutable, R1-04). */
  gitBranch?: EngineCore['gitBranch'];
  /** Phase-2 idle sleep (default: never). */
  sleepPolicy?: SleepPolicy;
  now?: () => Date;
  /** Timer seam (default real, unref'd timers). */
  timers?: Timers;
  logger?: Logger;
  /** Unexpected internal errors (logged anyway); tests collect them. */
  onInternalError?: (error: unknown, context: string) => void;
  options?: Partial<SessionManagerOptions>;
}

/** Debug/test view of one entry (inspect). */
export interface EngineEntryInfo {
  entryId: EntryId;
  phase: EntryState['phase'];
  pid: number | null;
  facts: StatusFacts;
  queue: QueuedPrompt[];
  conversationId: string;
  sessionStateSeen: boolean;
  pendingRename: string | null;
  retryAttempts: number;
  retryScheduled: boolean;
  mirrorItems: number | null;
  subscribers: number;
  gitBranch: string | null;
}

export interface SessionManager extends SessionSource {
  /** The hub ↔ source cycle (before start()). */
  attachPublisher(publisher: SessionPublisher): void;
  /** Load the registry, recovery (§3.5.13); orphans are cleaned up in the background. */
  start(): Promise<void>;
  /** §3.5.14: close all processes (≤ shutdownTimeoutMs, then taskkill), flush the stores, dispose the backend. */
  shutdown(): Promise<void>;
  /** E.g. after warnings.onChange / checkProfile (WP-20). */
  publishHostState(): void;
  inspect(entryId: EntryId): EngineEntryInfo | null;
  /** Settles when the orphan cleanup of the server start is done (tests, diagnostics). */
  orphansDone(): Promise<void>;
}

/** Real `capInput` (WP-12 limits) for broker decision cards: JSON value + blob of the full input. */
function defaultCapInput(stores: EngineStores): EngineCore['capInput'] {
  return (input) => {
    const json = jsonValueSchema.safeParse(input);
    const value = json.success ? json.data : jsonValueSchema.parse(JSON.parse(JSON.stringify(input)));
    const capped = normalizerCapInput(value, '', { storeBlob: (d, m, n) => stores.blobs.put(d, m, n) });
    return { input: capped.input, truncated: capped.inputTruncated };
  };
}

export function createSessionManager(deps: SessionManagerDeps): SessionManager {
  const options: SessionManagerOptions = { ...DEFAULT_SESSION_MANAGER_OPTIONS, ...deps.options };
  const log = (deps.logger ?? rootLogger).child({ module: 'sessions' });
  const now = deps.now ?? (() => new Date());
  const timers = deps.timers ?? realTimers;
  const stores = deps.stores;
  const states = new Map<EntryId, EntryState>();
  const engineWarnings = new Map<string, HostWarning>();
  const accountLimits: Record<string, RateLimitInfo> = {};
  const modelCache = new Map<ProfileId, ModelCatalog>();
  const serverStartedAt = now();
  let publisher: SessionPublisher | null = null;
  let shuttingDown = false;
  let shutdownPromise: Promise<void> | null = null;
  let hostTimer: TimerHandle | null = null;
  let orphans: Promise<void> = Promise.resolve();

  const proc: ProcDeps = {
    processInfo: deps.proc?.processInfo ?? ((pid) => processInfo(pid)),
    killProcessTree: deps.proc?.killProcessTree ?? killProcessTree,
    childProcesses: deps.proc?.childProcesses ?? ((pid) => childProcesses(pid)),
  };

  const publisherOrThrow = (): SessionPublisher => {
    if (publisher === null) throw new Error('SessionManager: attachPublisher() must be called before use');
    return publisher;
  };

  const hostState = (): HostState => {
    const profiles = deps.claude.profiles.summaries();
    const defaultProfile = deps.claude.profiles.getDefault();
    const defaultSummary = profiles.find((p) => p.id === defaultProfile.id);
    return {
      serverVersion: deps.host.serverVersion,
      sdkVersion: deps.host.sdkVersion,
      sdkClaudeCodeVersion: deps.host.sdkClaudeCodeVersion,
      platform: deps.host.platform,
      dataDirLabel: deps.host.dataDirLabel,
      dev: deps.host.dev,
      backend: deps.backend.kind,
      profiles,
      defaultProfileId: defaultProfile.id,
      settings: stores.settings.get(),
      setupRequired: defaultSummary === undefined ? true : profileNeedsSetup(defaultSummary.claude),
      warnings: [...stores.warnings.list(), ...engineWarnings.values()],
      accountLimits: { ...accountLimits },
    };
  };

  const publishHostState = (): void => {
    if (publisher === null) return;
    publisher.publishHostState(hostState());
  };

  const reportError = (error: unknown, context: string): void => {
    log.error({ err: error, context }, 'session engine: unexpected error');
    try {
      deps.onInternalError?.(error, context);
    } catch {
      // A failing observer must not break the engine.
    }
  };

  const considerSleep = (s: EntryState, facts: StatusFacts): void => {
    s.sleepTimer?.cancel();
    s.sleepTimer = null;
    if (s.runtime === null || s.phase !== 'running' || !canSleep(facts, now())) return;
    const delay = core.sleepPolicy.schedule(s.id, facts, now());
    if (delay === null) return;
    s.sleepTimer = timers.setTimeout(() => {
      s.sleepTimer = null;
      if (shuttingDown || !canSleep(s.facts, now())) return;
      s.lifecycle
        .run(() => closeRuntime(s, core, 'sleep'))
        .catch((error: unknown) => {
          log.warn({ err: error, entryId: s.id }, 'idle sleep failed');
        });
    }, delay);
  };

  const core: EngineCore = {
    backend: deps.backend,
    claude: deps.claude,
    stores,
    normalizer: {
      createLiveNormalizer: deps.normalizer?.createLiveNormalizer ?? createLiveNormalizer,
      normalizeHistory: deps.normalizer?.normalizeHistory ?? normalizeHistory,
      normalizeContextUsage: deps.normalizer?.normalizeContextUsage ?? normalizeContextUsage,
      estimateContextGauge: deps.normalizer?.estimateContextGauge ?? estimateContextGauge,
    },
    reduceStatus: deps.reduceStatus ?? realReduceStatus,
    ids: deps.ids ?? { newId, newUuid },
    checkCwd: deps.checkCwd ?? realCheckCwd,
    proc,
    capText:
      deps.capText ??
      ((text) => normalizerCapText(text, { storeBlob: (d, m, n) => stores.blobs.put(d, m, n) })),
    capInput: deps.capInput ?? defaultCapInput(stores),
    gitBranch: deps.gitBranch ?? ((cwd, env) => readGitBranch(cwd, env)),
    sleepPolicy: deps.sleepPolicy ?? NEVER_SLEEP,
    now,
    timers,
    options,
    log,
    publisher: publisherOrThrow,
    shuttingDown: () => shuttingDown,
    assertRunning: () => {
      if (shuttingDown) throw new CommandError(makeError('SERVER_SHUTTING_DOWN'));
    },
    reportError,
    publishHostState,
    scheduleHostState: () => {
      if (hostTimer !== null || shuttingDown) return;
      hostTimer = timers.setTimeout(() => {
        hostTimer = null;
        publishHostState();
      }, HOST_STATE_DEBOUNCE_MS);
    },
    setEngineWarning: (id, error: ErrorPayload | null) => {
      if (error === null) {
        if (!engineWarnings.delete(id)) return;
      } else {
        const known = engineWarnings.get(id);
        if (known !== undefined && JSON.stringify(known.error) === JSON.stringify(error)) return;
        engineWarnings.set(id, { id, error, at: now().toISOString() });
      }
      publishHostState();
    },
    setAccountLimit: (profileId, info) => {
      accountLimits[profileId] = info;
      core.scheduleHostState();
    },
    models: (profileId) => modelCache.get(profileId) ?? null,
    setModels: (profileId, catalog) => {
      modelCache.set(profileId, catalog);
    },
    allowsBypass: (profileId) =>
      deps.claude.profiles.summaries().find((p) => p.id === profileId)?.allowsBypass ?? false,
    profile: (profileId) => deps.claude.profiles.get(profileId),
    factsChanged: (s, prev, next) => {
      const pub = publisherOrThrow();
      const planned = planNotification(prev, next, now(), pub.presence(), s.id);
      if (planned !== null) {
        const notification: Notification = {
          id: core.ids.newUuid(),
          kind: planned.kind,
          entryId: s.id,
          title: s.entry.title !== '' ? s.entry.title : cwdLabel(s.entry.cwd),
          delivery: planned.delivery,
          at: now().toISOString(),
        };
        pub.notify(planned.clientId, notification);
      }
      if (decisionsCleared(prev, next)) pub.clearNotification(s.id);
      considerSleep(s, next);
    },
  };

  const engine: CommandEngine = {
    core,
    state: (entryId) => states.get(entryId),
    createEntry: (entry: Entry, promptTitle: string | null) => {
      const s = new EntryState(core, entry, { ...INITIAL_STATUS_FACTS }, { promptTitle });
      s.viewedByVisibleClient = isViewedByVisibleClient(publisherOrThrow().presence(), entry.id);
      states.set(entry.id, s);
      s.touch(true);
      s.flush();
      return s;
    },
    runningCount: () => [...states.values()].filter((s) => s.runtime !== null).length,
    requestShutdown: () => {
      shuttingDown = true;
      for (const s of states.values()) s.cancelTimers();
      setImmediate(() => {
        try {
          deps.onShutdownRequested?.();
        } catch (error) {
          reportError(error, 'onShutdownRequested');
        }
      });
    },
  };

  /** §3.5.13 for one entry: decisions → facts → interrupted tool calls. */
  const recoverEntry = async (s: EntryState): Promise<void> => {
    const entry = s.entry;
    let records: Awaited<ReturnType<EngineStores['decisions']['load']>> = [];
    try {
      records = await stores.decisions.load(entry.id);
    } catch (error) {
      log.error({ err: error, entryId: entry.id }, 'decisions could not be loaded');
    }
    const { hadOpen } = s.broker.restore(records);
    s.reduce({ type: 'server_restart', hadOpenDecisions: hadOpen });
    s.reduce({ type: 'decisions_changed', decisions: s.broker.counts() });
    if (wasActive(entry) || hadOpen) {
      try {
        const tail = await stores.transcripts.readTail(
          entry.id,
          currentConversation(entry).id,
          RECOVERY_TAIL_ITEMS,
        );
        const fixed = interruptedToolCalls(tail.items);
        if (fixed.length > 0) s.emit(fixed.map((item) => ({ op: 'item.upsert', item })));
      } catch (error) {
        log.error({ err: error, entryId: entry.id }, 'transcript tail could not be read at the restart');
      }
    }
    s.touch();
  };

  const manager: SessionManager = {
    attachPublisher(next) {
      publisher = next;
    },

    async start() {
      publisherOrThrow();
      let records: Awaited<ReturnType<ProcessStore['load']>> = [];
      try {
        records = await stores.processes.load();
      } catch (error) {
        log.error({ err: error }, 'processes.json could not be loaded – no orphan cleanup');
      }
      for (const entry of stores.registry.list()) {
        states.set(entry.id, new EntryState(core, entry, registryFacts(entry)));
      }
      const cleanups: Promise<void>[] = [];
      const byEntry = new Map<EntryId, typeof records>();
      for (const record of records)
        byEntry.set(record.entryId, [...(byEntry.get(record.entryId) ?? []), record]);
      for (const [entryId, list] of byEntry) {
        const cleanup = Promise.all(
          list.map(async (record) => {
            const result = await cleanupOrphan(record, { ...proc, serverStartedAt, log });
            log.info({ entryId, pid: record.pid, result }, 'orphan check');
            stores.processes.remove(record.entryId, record.pid);
          }),
        ).then(() => undefined);
        const s = states.get(entryId);
        if (s !== undefined) s.orphanCleanup = cleanup;
        cleanups.push(cleanup);
      }
      orphans = Promise.all(cleanups).then(() => undefined);
      await Promise.all([...states.values()].map((s) => recoverEntry(s)));
      for (const s of states.values()) s.flush();
    },

    shutdown() {
      shutdownPromise ??= (async () => {
        shuttingDown = true;
        hostTimer?.cancel();
        hostTimer = null;
        for (const s of states.values()) {
          s.cancelTimers();
          // Never cancel at shutdown: open records stay open → `expired` after the restart (A.10).
          s.broker.freeze();
        }
        const running = [...states.values()].filter((s) => s.runtime !== null);
        const closes = running.map(async (s) => {
          const runtime = s.runtime;
          if (runtime === null) return;
          runtime.closing = true;
          try {
            await runtime.agent.close();
          } catch (error) {
            log.warn({ err: error, entryId: s.id }, 'close() failed at shutdown');
          }
          await runtime.exited;
        });
        const cap: { timer: TimerHandle | null } = { timer: null };
        await Promise.race([
          Promise.allSettled(closes),
          new Promise<void>((resolve) => {
            cap.timer = timers.setTimeout(resolve, options.shutdownTimeoutMs);
          }),
        ]);
        cap.timer?.cancel();
        for (const s of states.values()) {
          const pid = s.runtime?.pid ?? null;
          if (pid === null) continue;
          log.error({ entryId: s.id, pid }, 'process did not end at shutdown – killing its tree');
          await proc.killProcessTree(pid).catch((error: unknown) => {
            log.error({ err: error, entryId: s.id, pid }, 'killProcessTree failed at shutdown');
          });
        }
        for (const s of states.values()) s.flush();
        const flushes = await Promise.allSettled([
          stores.registry.flush(),
          stores.transcripts.flush(),
          stores.decisions.flush(),
          stores.processes.flush(),
        ]);
        for (const result of flushes) {
          if (result.status === 'rejected')
            log.error({ err: result.reason }, 'store flush failed at shutdown');
        }
        try {
          await deps.backend.dispose();
        } catch (error) {
          log.error({ err: error }, 'backend.dispose failed');
        }
      })();
      return shutdownPromise;
    },

    publishHostState,
    hostState,

    listSummaries: () => [...states.values()].map((s) => s.summary()),

    async loadView(entryId): Promise<SessionViewState | null> {
      const s = states.get(entryId);
      return s === undefined ? null : s.loadView();
    },

    handleCommand: (cmd, ctx: CommandContext) => handleCommand(engine, cmd, ctx),

    onPresenceChanged(all: readonly ClientPresence[]) {
      for (const s of states.values()) {
        const visible = isViewedByVisibleClient(all, s.id);
        s.viewedByVisibleClient = visible;
        if (visible && s.facts.unread) {
          s.reduce({ type: 'viewed' });
          publisherOrThrow().clearNotification(s.id);
        }
      }
    },

    onSubscribersChanged(entryId, count) {
      const s = states.get(entryId);
      if (s === undefined) return;
      s.subscribers = count;
      if (count === 0) s.dropMirrorIfUnused();
    },

    inspect(entryId) {
      const s = states.get(entryId);
      if (s === undefined) return null;
      return {
        entryId: s.id,
        phase: s.phase,
        pid: s.runtime?.pid ?? null,
        facts: s.facts,
        queue: s.queue.list(),
        conversationId: s.conversationId(),
        sessionStateSeen: s.runtime?.sessionStateSeen ?? false,
        pendingRename: s.pendingRename,
        retryAttempts: s.retry.attempts,
        retryScheduled: s.retryTimer !== null,
        mirrorItems: s.mirror?.items.length ?? null,
        subscribers: s.subscribers,
        gitBranch: s.gitBranch,
      };
    },

    orphansDone: () => orphans,
  };
  return manager;
}
