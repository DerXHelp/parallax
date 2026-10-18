/**
 * `SessionManager` (WP-13 §3.5): implements the port `SessionSource` (sync/ports.ts) on top of an
 * `AgentBackend` (Sdk or Fake). Lifecycle per entry (dormant at server start, resume on
 * interaction, ready after `supportedModels()`), all commands (commands.ts), prompt queue,
 * normalizer + status machine, mirror views for `loadView`, summaries/ops/host state through the
 * `SessionPublisher` (the hub), persistence through the stores, crash/auto-retry, server start
 * (recovery, orphans) and shutdown. Wiring for WP-20: docs/wp/WP-13b.md "Verdrahtung".
 *
 * Phase 2 (WP-31): idle sleep from the settings (ADR-105), git branch refresh for visible entries
 * (ADR-113), persistent model catalogs/account limits (ADR-114), slash-command cache (ADR-108),
 * notification settings (ADR-109), host-command routing (ADR-101) and the Phase-2 host state.
 * WP-34: external console (ADR-104), continue after the rate limit (ADR-112), image attachments
 * (ADR-103), clickable/silent native toasts (ADR-109), profile caches (ADR-102, `onProfileChanged`).
 * Fix round R4: no idle sleep for a process with a planned turn (ADR-121), a silent toast when a
 * window sounds itself (ADR-122), the shutdown waits (bounded) for running lifecycle operations
 * (R4-03).
 */
import { createHash } from 'node:crypto';
import path from 'node:path';
import type { Logger } from 'pino';
import { jsonValueSchema, type ClientId, type EntryId, type ProfileId } from '@shared/common';
import { makeError, type ErrorPayload } from '@shared/errors';
import {
  currentConversation,
  type Entry,
  type HostState,
  type HostWarning,
  type Profile,
  type QueuedPrompt,
  type RateLimitInfo,
  type Settings,
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
import {
  descendantsOf,
  isProcessAlive,
  killProcessTree,
  listProcesses,
  queryProcesses,
} from '../lib/process';
import {
  CommandError,
  type ClientPresence,
  type CommandContext,
  type HostCommandHandler,
  type SessionPublisher,
  type SessionSource,
} from '../sync/ports';
import type { ConsoleLauncher, SystemIntegration } from '../system/ports';
import { createMemoryCatalogStore } from './catalogStore';
import { createMemoryCommandCatalogStore } from './commandCatalog';
import { handleCommand, type CommandEngine } from './commands';
import { restoreContinue } from './continuePlan';
import {
  EntryState,
  settingsSleepPolicy,
  type EngineCore,
  type EngineStores,
  type NormalizerFns,
  type ProcDeps,
  type SessionManagerOptions,
  type SleepPolicy,
} from './entryState';
import { restoreExternal } from './external';
import { readGitBranch } from './lib/gitBranch';
import { realTimers, type TimerHandle, type Timers } from './lib/timers';
import { catalogOrFallback, type ModelCatalog } from './models';
import {
  capInput as normalizerCapInput,
  capText as normalizerCapText,
  createLiveNormalizer,
  estimateContextGauge,
  normalizeContextUsage,
  normalizeHistory,
} from './normalizer';
import { DISABLED_NATIVE_TOASTS, toastShowOptions, type NativeToasts } from './nativeToasts';
import {
  decisionsCleared,
  isViewedByVisibleClient,
  isWatchedByFocusedClient,
  presenceSummary,
  routeChannel,
  routeNotification,
} from './notifier';
import type { ReduceStatus } from './ports';
import type { ProcessRecord, ProcessStore } from './processStore';
import {
  cleanupOrphans,
  interruptedToolCalls,
  keepsOrphanRecord,
  ORPHAN_START_TOLERANCE_MS,
  registryFacts,
  splitOrphanRecords,
  wasActive,
  type OrphanResult,
} from './recovery';
import { DEFAULT_AUTO_RETRY } from './retry';
import { closeRuntime } from './runtime';
import { reduceStatus as realReduceStatus } from './status/machine';
import { cwdLabel } from './summary';

export type { SessionManagerOptions, SleepPolicy } from './entryState';

export const DEFAULT_SESSION_MANAGER_OPTIONS: SessionManagerOptions = {
  autoRetry: DEFAULT_AUTO_RETRY,
  contextRefreshDelayMs: 250,
  shutdownTimeoutMs: 15_000,
  orphanShutdownWaitMs: 2_000,
  // R4-03: below the frame's 20-s bound of the whole engine shutdown (launcher/shutdown.ts).
  lifecycleShutdownWaitMs: 10_000,
  gitRefreshMs: 60_000,
  aiTitleDelayMs: 2_000,
  processSnapshotMs: 30_000,
  processSnapshotFirstMs: 10_000,
  // C.8 (CR-02, ADR-090): up to 5 s after close() for a clean end (SessionEnd hooks, transcript).
  shutdownKillAfterMs: 5_000,
  // ADR-104: console state check of a handed-off entry.
  externalPollMs: 5_000,
  // ADR-112: a plan at most 1 h overdue is still sent after a restart.
  continueGraceMs: 3_600_000,
};

/** WP22-05: bound of the interrupt sent at shutdown to a session that waits for a decision. */
export const SHUTDOWN_INTERRUPT_MS = 1_000;

/**
 * The shutdown frame (launcher/shutdown.ts) sweeps the server's child process trees only after the
 * engine's own C.8 window (interrupt ≤ 1 s, close(), ≤ 5 s, taskkill) plus a margin (CR-02).
 */
export const SHUTDOWN_SWEEP_GRACE_MS =
  SHUTDOWN_INTERRUPT_MS + DEFAULT_SESSION_MANAGER_OPTIONS.shutdownKillAfterMs + 2_000;

/**
 * CR-06 (ADR-090): may the shutdown end the turn of a session that waits for a decision? Only when
 * nothing is queued and no background work runs – otherwise BOTH ways start further work: after an
 * interrupt the CLI's drain loop starts the next queued prompt at once (a finishing background task
 * starts a turn of its own, Findings point 9), and on close() (stdin EOF) a waiting CLI fails the
 * permission ("Tool permission stream closed") and continues the turn with the queued prompt folded
 * in – a model call, tools (live, fix round). Such a session is ended with taskkill instead (it is
 * blocked on the answer and writes nothing). Parallax's queue lists every prompt it sent that has
 * not started.
 */
export function shutdownCanEndTurn(s: Pick<EntryState, 'queue' | 'facts'>): boolean {
  return s.queue.count() === 0 && s.facts.queuedPrompts === 0 && s.facts.backgroundTasks === 0;
}

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
    /**
     * Phase 2: the actual listening port (`HostState.port`, null before listen); compose.ts wires
     * it. Absent (engine tests) → null.
     */
    port?: () => number | null;
    /** Phase 2 (ADR-110): `HostState.systemIntegration` (SystemIntegration.available). Absent → false. */
    systemIntegration?: boolean;
  };
  /** Phase 2 (ADR-101): handlers of the host commands (`profile.*`, `fs.listDirectory`); default []. */
  hostCommands?: readonly HostCommandHandler[];
  /** After every successful settings.update (prev, next) – WP-40 wires SystemIntegration.apply. */
  onSettingsChanged?: (prev: Settings, next: Settings) => void;
  /** Extra host warnings merged into HostState.warnings (WP-40: SystemIntegration.warnings). */
  extraWarnings?: () => HostWarning[];
  /** Called (setImmediate) after server.shutdown was acknowledged; WP-20 then calls shutdown(). */
  onShutdownRequested?: () => void;
  /** Native Windows toasts (WP22-03/-15, A.9); default: off. */
  toasts?: NativeToasts;
  /**
   * Phase 2 (ADR-104, WP-34): the visible console of `session.openExternal` (WP-33
   * `createConsoleLauncher()`, fake server `createFakeConsoleLauncher()`). Absent →
   * `openExternal` answers EXTERNAL_CONSOLE_FAILED {reason:'unavailable'} and a handoff of an
   * earlier run stays `external` (its state is unknown, ADR-051).
   */
  consoleLauncher?: ConsoleLauncher;
  /** Phase 2 (ADR-109, WP-34): click target of native toasts (`toastLaunchUri`); absent → none. */
  systemIntegration?: Pick<SystemIntegration, 'toastLaunchUri'>;
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
  /** Idle sleep (test seam; default: `settings.idleSleep`, ADR-105). */
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
  /** ADR-112: a "continue" timer is armed. */
  continueScheduled: boolean;
  /** ADR-104: the next console state check is armed. */
  externalWatched: boolean;
  /** ADR-121: the running process has a planned turn (no idle sleep). */
  scheduledTurn: boolean;
}

export interface SessionManager extends SessionSource {
  /** The hub ↔ source cycle (before start()). */
  attachPublisher(publisher: SessionPublisher): void;
  /**
   * Load the registry, recovery (§3.5.13); orphans are cleaned up in the background (one bundled
   * query for the live PIDs only, R2-02; a start of such an entry waits for it, visibly `starting`).
   */
  start(): Promise<void>;
  /** §3.5.14: close all processes (≤ shutdownTimeoutMs, then taskkill), flush the stores, dispose the backend. */
  shutdown(): Promise<void>;
  /** E.g. after warnings.onChange / checkProfile (WP-20), a profile change (WP-40). */
  publishHostState(): void;
  /**
   * ADR-102 (WP-34; WP-40 wires it to `PersistentProfileStore.onChange`): a profile was saved,
   * deleted or re-checked. For `profileId` – or, with null/absent, for every profile the engine
   * knows – the caches of a CHANGED profile are dropped: model catalog incl. the alias resolution
   * (memory and `model-catalogs.json`; open views of dormant entries fall back to the aliases), the
   * launch env of dormant entries (git PATH); a deleted profile also loses its account limits.
   * "Changed" = executable, env, configDir, args or passRawArgs differ from the last known profile
   * (a rename, colour, default or claude-status change keeps the caches, like WP-32's resolution
   * cache). Always publishes the host state afterwards.
   */
  onProfileChanged(profileId?: ProfileId | null): void;
  inspect(entryId: EntryId): EngineEntryInfo | null;
  /** Settles when the orphan cleanup of the server start is done (tests, diagnostics). */
  orphansDone(): Promise<void>;
  /** Settles when the console checks of the server start are done (ADR-104; tests, diagnostics). */
  externalChecksDone(): Promise<void>;
}

/**
 * Everything a profile's model catalog depends on (ADR-102), hashed (the env holds secrets); null =
 * the profile does not exist.
 */
export function profileCacheKey(profile: Profile | undefined): string | null {
  if (profile === undefined) return null;
  const parts = [profile.executable, profile.env, profile.configDir, profile.args, profile.passRawArgs];
  return createHash('sha256').update(JSON.stringify(parts)).digest('hex');
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
  const stores: Required<EngineStores> = {
    ...deps.stores,
    catalogs: deps.stores.catalogs ?? createMemoryCatalogStore(),
    commandCatalogs: deps.stores.commandCatalogs ?? createMemoryCommandCatalogStore(),
  };
  const toasts = deps.toasts ?? DISABLED_NATIVE_TOASTS;
  const hostCommands = deps.hostCommands ?? [];
  const states = new Map<EntryId, EntryState>();
  const engineWarnings = new Map<string, HostWarning>();
  // ADR-114: the last catalogs and subscription limits of the previous run are known at once.
  const accountLimits = new Map<ProfileId, RateLimitInfo>(Object.entries(stores.catalogs.limits()));
  const modelCache = new Map<ProfileId, ModelCatalog>(
    Object.entries(stores.catalogs.models()).map(([profileId, stored]) => [
      profileId,
      { options: stored.options, resolved: stored.resolved, skipped: 0 },
    ]),
  );
  /**
   * ADR-102: `profileCacheKey` of every profile as last seen – the persisted catalogs belong to the
   * profiles as they are at this start; onProfileChanged compares against these keys.
   */
  const profileKeys = new Map<ProfileId, string>();
  for (const profile of deps.claude.profiles.list()) {
    const key = profileCacheKey(profile);
    if (key !== null) profileKeys.set(profile.id, key);
  }
  /** ADR-104: the console checks of the server start (tests, diagnostics). */
  let externalChecks: Promise<void> = Promise.resolve();
  let publisher: SessionPublisher | null = null;
  let shuttingDown = false;
  let shutdownPromise: Promise<void> | null = null;
  let hostTimer: TimerHandle | null = null;
  /** ADR-113: the 60-s git refresh of entries a visible window shows. */
  let gitTimer: TimerHandle | null = null;
  /** Last focus/view per client (git refresh on a focus change, ADR-113). */
  const lastFocus = new Map<ClientId, { focused: boolean; viewing: EntryId | null }>();
  let orphans: Promise<void> = Promise.resolve();
  /** R3-06: set once shutdown() flushed the stores – they close right after (compose.ts). */
  let storesFlushed = false;

  // WP22-06 (R2-03 follow-up): the heartbeat snapshots the process trees; the next start ends only
  // the verified claude.exe root and exactly matching processes of its last snapshot.
  const proc: ProcDeps = {
    isProcessAlive: deps.proc?.isProcessAlive ?? isProcessAlive,
    queryProcesses: deps.proc?.queryProcesses ?? ((filter) => queryProcesses(filter)),
    listProcesses: deps.proc?.listProcesses ?? (() => listProcesses()),
    killProcessTree: deps.proc?.killProcessTree ?? killProcessTree,
  };
  let snapshotTimer: TimerHandle | null = null;
  let snapshotBusy = false;
  const snapshotsStopped = (): boolean => shuttingDown || storesFlushed;

  const publisherOrThrow = (): SessionPublisher => {
    if (publisher === null) throw new Error('SessionManager: attachPublisher() must be called before use');
    return publisher;
  };

  const reportError = (error: unknown, context: string): void => {
    log.error({ err: error, context }, 'session engine: unexpected error');
    try {
      deps.onInternalError?.(error, context);
    } catch {
      // A failing observer must not break the engine.
    }
  };

  /** WP-40's warnings (SystemIntegration); a failing source never breaks the host state. */
  const extraWarnings = (): HostWarning[] => {
    try {
      return deps.extraWarnings?.() ?? [];
    } catch (error) {
      reportError(error, 'extraWarnings');
      return [];
    }
  };

  const hostState = (): HostState => {
    // Entries per profile, archived ones included (delete protection, configDir warning; ADR-102).
    const entryCounts = new Map<string, number>();
    for (const s of states.values()) {
      entryCounts.set(s.entry.profileId, (entryCounts.get(s.entry.profileId) ?? 0) + 1);
    }
    const profiles = deps.claude.profiles
      .summaries()
      .map((p) => ({ ...p, entryCount: entryCounts.get(p.id) ?? 0 }));
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
      warnings: [...stores.warnings.list(), ...engineWarnings.values(), ...extraWarnings()],
      accountLimits: Object.fromEntries(accountLimits),
      nativeNotifications: toasts.available(),
      port: deps.host.port?.() ?? null,
      systemIntegration: deps.host.systemIntegration ?? false,
    };
  };

  /** The entry's notifications are done (seen, answered elsewhere): window hints and native toast. */
  const clearNotifications = (entryId: EntryId): void => {
    publisherOrThrow().clearNotification(entryId);
    toasts.clear(entryId);
  };

  const publishHostState = (): void => {
    if (publisher === null) return;
    publisher.publishHostState(hostState());
  };

  const presence = (): readonly ClientPresence[] => publisher?.presence() ?? [];

  /** Entries with a live claude.exe (PID known). */
  const runningProcesses = (): { s: EntryState; pid: number }[] =>
    [...states.values()].flatMap((s) => {
      const pid = s.runtime?.alive === true ? s.runtime.pid : null;
      return pid === null ? [] : [{ s, pid }];
    });

  /**
   * WP22-06 heartbeat: ONE process listing for all running sessions; per claude.exe its current
   * descendants with exact start times + `aliveAt` into processes.json (debounced write). After a
   * hard abort the next start ends exactly these processes (recovery.ts). An inconclusive listing
   * keeps the previous snapshot.
   */
  const takeProcessSnapshot = async (): Promise<void> => {
    const running = runningProcesses();
    if (snapshotBusy || shuttingDown || running.length === 0) return;
    snapshotBusy = true;
    try {
      const result = await proc.listProcesses();
      if (result.kind === 'unknown') {
        log.debug(
          { reason: result.reason, detail: result.detail },
          'process snapshot inconclusive – kept the last one',
        );
        return;
      }
      // The shutdown may have begun during the listing.
      if (snapshotsStopped()) return;
      const byPid = new Map(result.processes.map((p) => [p.pid, p]));
      const aliveAt = now().toISOString();
      for (const { s, pid } of running) {
        const root = byPid.get(pid);
        const runtime = s.runtime;
        if (runtime?.pid !== pid || root === undefined || runtime.spawnedAt === null) continue;
        // Only the process this runtime spawned (image + start time, like the orphan check): a
        // fake PID of the FakeBackend or a PID reused since must never lend its tree to a record.
        const image = path.win32.basename(runtime.launch.executablePath).toLowerCase();
        const sameStart =
          Math.abs(root.startedAt.getTime() - runtime.spawnedAt.getTime()) <= ORPHAN_START_TOLERANCE_MS;
        if (root.name.toLowerCase() !== image || !sameStart) continue;
        const children = descendantsOf(result.processes, root).map((p) => ({
          pid: p.pid,
          image: p.name,
          startedAt: p.startedAt.toISOString(),
        }));
        stores.processes.heartbeat(s.id, pid, { aliveAt, children });
      }
    } catch (error) {
      log.warn({ err: error }, 'process snapshot failed');
    } finally {
      snapshotBusy = false;
    }
  };

  const scheduleProcessSnapshot = (delayMs: number): void => {
    if (options.processSnapshotMs <= 0 || shuttingDown || snapshotTimer !== null) return;
    snapshotTimer = timers.setTimeout(() => {
      snapshotTimer = null;
      void takeProcessSnapshot().finally(() => {
        if (runningProcesses().length > 0) scheduleProcessSnapshot(options.processSnapshotMs);
      });
    }, delayMs);
  };

  const cancelProcessSnapshot = (): void => {
    snapshotTimer?.cancel();
    snapshotTimer = null;
  };

  /**
   * ADR-105: a running process may fall asleep when `canSleep(facts)` holds and no focused + visible
   * window shows the entry (the user would face "Starting…"). The idle time counts from the moment
   * both hold (`sleepSince`); every change of facts, presence or settings re-plans.
   */
  const sleepEligible = (s: EntryState, clients: readonly ClientPresence[]): boolean =>
    !shuttingDown &&
    s.runtime !== null &&
    s.phase === 'running' &&
    // ADR-121 (R4-02): a planned turn (ScheduleWakeup/CronCreate, /loop) dies with the process.
    !s.runtime.scheduled &&
    canSleep(s.facts, now()) &&
    !isWatchedByFocusedClient(clients, s.id);

  const planSleep = (s: EntryState, clients: readonly ClientPresence[]): void => {
    s.sleepTimer?.cancel();
    s.sleepTimer = null;
    if (!sleepEligible(s, clients)) {
      s.sleepSince = null;
      return;
    }
    const at = now();
    s.sleepSince ??= at.getTime();
    const delay = core.sleepPolicy.schedule(s.id, s.facts, at, new Date(s.sleepSince));
    if (delay === null) return;
    s.sleepTimer = timers.setTimeout(() => {
      s.sleepTimer = null;
      if (!sleepEligible(s, presence())) {
        planSleep(s, presence());
        return;
      }
      s.lifecycle
        .run(async () => {
          // Re-checked inside the lock (a prompt may have started a turn meanwhile).
          if (sleepEligible(s, presence())) await closeRuntime(s, core, 'sleep');
        })
        .catch((error: unknown) => {
          log.warn({ err: error, entryId: s.id }, 'idle sleep failed');
        });
    }, delay);
  };

  /** Entries a visible window shows (focus not required) – the git refresh targets (ADR-113). */
  const viewedStates = (clients: readonly ClientPresence[]): EntryState[] =>
    [...states.values()].filter((s) => isViewedByVisibleClient(clients, s.id));

  const cancelGitRefresh = (): void => {
    gitTimer?.cancel();
    gitTimer = null;
  };

  /** ADR-113: every `gitRefreshMs` while a visible window shows an entry (dormant ones too). */
  const scheduleGitRefresh = (clients: readonly ClientPresence[] = presence()): void => {
    if (options.gitRefreshMs <= 0 || shuttingDown || gitTimer !== null) return;
    if (viewedStates(clients).length === 0) return;
    gitTimer = timers.setTimeout(() => {
      gitTimer = null;
      if (shuttingDown) return;
      for (const s of viewedStates(presence())) void s.refreshGitBranch();
      scheduleGitRefresh();
    }, options.gitRefreshMs);
  };

  const core: EngineCore = {
    backend: deps.backend,
    claude: deps.claude,
    consoleLauncher: deps.consoleLauncher ?? null,
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
    sleepPolicy: deps.sleepPolicy ?? settingsSleepPolicy(() => stores.settings.get()),
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
      accountLimits.set(profileId, info);
      try {
        stores.catalogs.setLimit(profileId, info);
      } catch (error) {
        reportError(error, 'catalogs.setLimit');
      }
      core.scheduleHostState();
    },
    models: (profileId) => modelCache.get(profileId) ?? null,
    setModels: (profileId, catalog) => {
      modelCache.set(profileId, catalog);
      const key = profileCacheKey(deps.claude.profiles.get(profileId));
      if (key !== null && !profileKeys.has(profileId)) profileKeys.set(profileId, key);
      try {
        stores.catalogs.setModels(profileId, {
          options: catalog.options,
          resolved: catalog.resolved,
          at: now().toISOString(),
        });
      } catch (error) {
        reportError(error, 'catalogs.setModels');
      }
    },
    allowsBypass: (profileId) =>
      deps.claude.profiles.summaries().find((p) => p.id === profileId)?.allowsBypass ?? false,
    profile: (profileId) => deps.claude.profiles.get(profileId),
    clearNotifications,
    considerSleep: (s) => {
      planSleep(s, presence());
    },
    factsChanged: (s, prev, next) => {
      // WP22-05: the interrupt at shutdown ends turns – no "done" notification for that.
      if (shuttingDown) return;
      const pub = publisherOrThrow();
      const settings = stores.settings.get();
      const clients = pub.presence();
      const route = routeNotification(
        prev,
        next,
        now(),
        clients,
        s.id,
        toasts.available(),
        settings.notifications,
      );
      // WP41-04: one line per notification – target, channel and why (never the title: prompt text).
      if (route !== null) {
        log.debug(
          {
            entryId: s.id,
            kind: route.kind,
            channel: routeChannel(route.planned),
            clientId: route.planned?.clientId ?? null,
            reason: route.reason,
            tieBreak: route.tieBreak,
            filter: route.filter,
            presence: presenceSummary(clients, s.id),
          },
          'notification route',
        );
      }
      const planned = route?.planned ?? null;
      if (planned !== null) {
        const title = s.entry.title !== '' ? s.entry.title : cwdLabel(s.entry.cwd);
        if (planned.clientId !== null) {
          const notification: Notification = {
            id: core.ids.newUuid(),
            kind: planned.kind,
            entryId: s.id,
            title,
            delivery: planned.delivery,
            at: now().toISOString(),
          };
          pub.notify(planned.clientId, notification);
        }
        // ADR-109: click → the session (opt-in protocol handler), silent when the event's sound is
        // off – ADR-122: or when a window got the notify above (it plays the sound itself).
        if (planned.native) {
          toasts.show(
            s.id,
            planned.kind,
            title,
            toastShowOptions(s.id, planned.kind, settings, deps.systemIntegration, planned.clientId !== null),
          );
        }
      }
      if (decisionsCleared(prev, next)) clearNotifications(s.id);
      planSleep(s, pub.presence());
    },
    processSpawned: () => {
      scheduleProcessSnapshot(options.processSnapshotFirstMs);
    },
    processEnded: () => {
      if (runningProcesses().length === 0) cancelProcessSnapshot();
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
      // HostState.profiles[].entryCount changed.
      publishHostState();
      return s;
    },
    runningCount: () => [...states.values()].filter((s) => s.runtime !== null).length,
    requestShutdown: () => {
      shuttingDown = true;
      cancelGitRefresh();
      for (const s of states.values()) s.cancelTimers();
      setImmediate(() => {
        try {
          deps.onShutdownRequested?.();
        } catch (error) {
          reportError(error, 'onShutdownRequested');
        }
      });
    },
    hostCommands,
    settingsChanged: (prev, next) => {
      try {
        deps.onSettingsChanged?.(prev, next);
      } catch (error) {
        reportError(error, 'onSettingsChanged');
      }
      publishHostState();
      // ADR-105: idle sleep on/off and its minutes apply at once.
      for (const s of states.values()) planSleep(s, presence());
    },
  };

  /**
   * ADR-102: the caches of a changed (or deleted) profile – model catalog incl. alias resolution in
   * memory and on disk, the launch env of its dormant entries; a deleted profile also loses its
   * account limits. Open views of dormant entries fall back to the aliases.
   */
  const dropProfileCaches = (profileId: ProfileId, deleted: boolean): void => {
    const hadCatalog = modelCache.delete(profileId);
    try {
      stores.catalogs.removeModels(profileId);
      if (deleted && accountLimits.delete(profileId)) stores.catalogs.removeLimit(profileId);
    } catch (error) {
      reportError(error, 'catalogs.remove');
    }
    for (const s of states.values()) {
      if (s.entry.profileId !== profileId || s.runtime !== null) continue;
      s.lastEnv = null;
      if (hadCatalog && (s.mirror !== null || s.loading !== null)) {
        s.emit([{ op: 'detail.patch', patch: { models: catalogOrFallback(null).options } }]);
      }
    }
    log.info({ profileId, deleted }, 'profile caches dropped');
  };

  /**
   * §3.5.13 Nr. 4 with R2-02: dead PIDs (instant pre-filter) are removed without any PowerShell;
   * the live ones go into ONE background query. Only entries with a live record wait for it
   * (`orphanPending` → the start shows `starting`); `unknown`/`failed` keep their record.
   */
  const startOrphanCleanup = (records: readonly ProcessRecord[]): void => {
    const { alive, dead } = splitOrphanRecords(records, (pid) => proc.isProcessAlive(pid));
    for (const record of dead) {
      log.info({ entryId: record.entryId, pid: record.pid, result: 'gone' }, 'orphan check');
      stores.processes.remove(record.entryId, record.pid);
    }
    const results = cleanupOrphans(alive, { ...proc, log });
    const byEntry = new Map<EntryId, Promise<void>[]>();
    alive.forEach((record, index) => {
      const result = results[index] ?? Promise.resolve<OrphanResult>('unknown');
      // R3-06: never rejects. A result after the shutdown flushed the stores is ignored (the store
      // is closing; the record stays and the next start checks it again).
      const done = result
        .then((outcome) => {
          if (storesFlushed) {
            log.info(
              { entryId: record.entryId, pid: record.pid, result: outcome },
              'orphan check after shutdown ignored',
            );
            return;
          }
          log.info({ entryId: record.entryId, pid: record.pid, result: outcome }, 'orphan check');
          if (!keepsOrphanRecord(outcome)) stores.processes.remove(record.entryId, record.pid);
        })
        .catch((error: unknown) => {
          log.warn({ err: error, entryId: record.entryId, pid: record.pid }, 'orphan check failed');
        });
      byEntry.set(record.entryId, [...(byEntry.get(record.entryId) ?? []), done]);
    });
    const all: Promise<void>[] = [];
    for (const [entryId, list] of byEntry) {
      const cleanup = Promise.all(list).then(() => undefined);
      all.push(cleanup);
      const s = states.get(entryId);
      if (s === undefined) continue;
      s.orphanPending = true;
      s.orphanCleanup = cleanup.finally(() => {
        s.orphanPending = false;
      });
    }
    orphans = Promise.all(all).then(() => undefined);
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
      startOrphanCleanup(records);
      await Promise.all([...states.values()].map((s) => recoverEntry(s)));
      for (const s of states.values()) s.flush();
      // ADR-112: scheduled "continue" plans; ADR-104: open handoffs are checked in the background
      // (running/unknown → watched, ended → return with import).
      for (const s of states.values()) restoreContinue(core, s);
      externalChecks = Promise.all([...states.values()].map((s) => restoreExternal(core, s))).then(
        () => undefined,
      );
    },

    shutdown() {
      shutdownPromise ??= (async () => {
        shuttingDown = true;
        hostTimer?.cancel();
        hostTimer = null;
        cancelGitRefresh();
        cancelProcessSnapshot();
        for (const s of states.values()) {
          s.cancelTimers();
          // Never cancel at shutdown: open records stay open → `expired` after the restart (A.10).
          s.broker.freeze();
        }
        /** True when `work` settled within `ms` on the engine clock (timers seam), false on timeout. */
        const within = async (work: Promise<unknown>, ms: number): Promise<boolean> => {
          const cap: { timer: TimerHandle | null } = { timer: null };
          const settled = await Promise.race([
            work.then(
              () => true,
              () => true,
            ),
            new Promise<boolean>((resolve) => {
              cap.timer = timers.setTimeout(() => {
                resolve(false);
              }, ms);
            }),
          ]);
          cap.timer?.cancel();
          return settled;
        };
        // R4-03: lifecycle operations still running – `openExternal` while PowerShell opens the
        // console (its query is already closed, so the closes below do not wait for it), a return
        // import – finish before the stores are flushed; bounded, alongside the closes.
        const busy = [...states.values()].filter((s) => s.lifecycle.pending > 0);
        const lifecycleSettled =
          busy.length === 0
            ? Promise.resolve(true)
            : within(Promise.all(busy.map((s) => s.lifecycle.idle())), options.lifecycleShutdownWaitMs);
        const killTree = async (
          s: EntryState,
          pid: number,
          level: 'info' | 'error',
          message: string,
        ): Promise<void> => {
          log[level]({ entryId: s.id, pid }, message);
          await proc.killProcessTree(pid).catch((error: unknown) => {
            log.error({ err: error, entryId: s.id, pid }, 'killProcessTree failed at shutdown');
          });
        };
        /** Prompts the CLI never started: a px item each, like after a crash (CR-06, §3.5.12). */
        const reportUndelivered = (s: EntryState): void => {
          const undelivered = s.queue.drain();
          for (const prompt of undelivered) {
            s.addSystemError(
              makeError(
                'PROMPT_NOT_DELIVERED',
                { messageUuid: prompt.messageUuid, preview: prompt.text.text.slice(0, 100) },
                'the server stopped before the prompt was started; it is not resent automatically',
              ),
            );
          }
          if (undelivered.length > 0) s.publishQueue();
        };
        const running = [...states.values()].filter((s) => s.runtime !== null);
        // C.8 (CR-02, ADR-090): close() of every query in parallel, up to `shutdownKillAfterMs`
        // (5 s) after it for a clean end – SessionEnd hooks and the CLI's transcript writes must not
        // be cut off –, only then taskkill /T /F of what still runs.
        const closes = running.map(async (s) => {
          const runtime = s.runtime;
          if (runtime === null) return;
          runtime.closing = true;
          // A CLI that waits for a permission/question/plan answer: the frozen broker keeps the
          // records open (→ expired after the restart, A.10).
          if (runtime.alive && s.broker.open().length > 0) {
            if (shutdownCanEndTurn(s)) {
              // WP22-05: end its turn first (bounded) – it ends cleanly then, no model call.
              await within(runtime.agent.interrupt(), SHUTDOWN_INTERRUPT_MS);
            } else if (runtime.pid !== null) {
              // CR-06: neither interrupt nor close() – both would start the queued work.
              log.info(
                { entryId: s.id, queued: s.queue.count(), backgroundTasks: s.facts.backgroundTasks },
                'shutdown: waiting with queued work – ending its tree without close()',
              );
              await killTree(
                s,
                runtime.pid,
                'info',
                'shutdown: ending the process tree of a waiting session',
              );
              await runtime.exited;
              // After the exit: no live normalizer allocates item orders any more.
              reportUndelivered(s);
              return;
            }
          }
          const closed = (async () => {
            try {
              await runtime.agent.close();
            } catch (error) {
              log.warn({ err: error, entryId: s.id }, 'close() failed at shutdown');
            }
          })();
          if (!(await within(runtime.exited, options.shutdownKillAfterMs)) && runtime.pid !== null) {
            await killTree(s, runtime.pid, 'info', 'process still running at shutdown – ending its tree');
          }
          await closed;
          await runtime.exited;
        });
        // Upper bound of the whole step (each close() above has its own 5-s window).
        if (!(await within(Promise.allSettled(closes), options.shutdownTimeoutMs))) {
          // R2-06: the remaining trees in parallel (each taskkill may take seconds).
          await Promise.allSettled(
            [...states.values()].map(async (s) => {
              const pid = s.runtime?.pid ?? null;
              if (pid !== null)
                await killTree(s, pid, 'error', 'process did not end at shutdown – killing its tree');
            }),
          );
        }
        if (!(await lifecycleSettled)) {
          log.warn(
            { entries: busy.filter((s) => s.lifecycle.pending > 0).map((s) => s.id) },
            'shutdown: lifecycle operations still running – flushing without them',
          );
        }
        // R3-06: a still running orphan check of the start may finish now (bounded); its removals
        // are flushed below, anything later is ignored.
        const orphanWait: { timer: TimerHandle | null } = { timer: null };
        await Promise.race([
          orphans,
          new Promise<void>((resolve) => {
            orphanWait.timer = timers.setTimeout(resolve, options.orphanShutdownWaitMs);
          }),
        ]);
        orphanWait.timer?.cancel();
        for (const s of states.values()) s.flush();
        storesFlushed = true;
        const flushes = await Promise.allSettled([
          stores.registry.flush(),
          stores.transcripts.flush(),
          stores.decisions.flush(),
          stores.processes.flush(),
          stores.catalogs.flush(),
          stores.commandCatalogs.flush(),
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
          clearNotifications(s.id);
        }
        // ADR-105: a focused viewer keeps the session awake; leaving it starts the idle time.
        planSleep(s, all);
      }
      // ADR-113: a client that gained focus or switched sessions sees a fresh branch.
      const focusedOn = new Set<EntryId>();
      for (const c of all) {
        const viewing = c.presence.viewingEntryId;
        const before = lastFocus.get(c.clientId);
        const focused = c.presence.focused && c.presence.visible;
        if (focused && viewing !== null && (before?.focused !== true || before.viewing !== viewing)) {
          focusedOn.add(viewing);
        }
      }
      lastFocus.clear();
      for (const c of all) {
        lastFocus.set(c.clientId, {
          focused: c.presence.focused && c.presence.visible,
          viewing: c.presence.viewingEntryId,
        });
      }
      if (!shuttingDown) {
        for (const entryId of focusedOn) void states.get(entryId)?.refreshGitBranch();
      }
      if (viewedStates(all).length === 0) cancelGitRefresh();
      else scheduleGitRefresh(all);
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
        gitBranch: s.entry.gitBranch,
        continueScheduled: s.continueTimer !== null,
        externalWatched: s.externalTimer !== null,
        scheduledTurn: s.runtime?.scheduled ?? false,
      };
    },

    onProfileChanged(profileId) {
      const known = deps.claude.profiles.list().map((p) => p.id);
      const ids =
        profileId === undefined || profileId === null
          ? new Set<ProfileId>([
              ...profileKeys.keys(),
              ...known,
              ...modelCache.keys(),
              ...accountLimits.keys(),
            ])
          : new Set<ProfileId>([profileId]);
      for (const id of ids) {
        const key = profileCacheKey(deps.claude.profiles.get(id));
        const before = profileKeys.get(id) ?? null;
        if (key !== null && key === before) continue;
        if (key === null) {
          profileKeys.delete(id);
        } else {
          profileKeys.set(id, key);
        }
        // A profile seen for the first time has no caches of an older version.
        if (before === null && key !== null && !modelCache.has(id)) continue;
        if (key === null && !modelCache.has(id) && !accountLimits.has(id)) continue;
        dropProfileCaches(id, key === null);
      }
      publishHostState();
    },

    orphansDone: () => orphans,
    externalChecksDone: () => externalChecks,
  };
  return manager;
}
