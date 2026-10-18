/**
 * `SessionRuntime` – one `claude` process of an entry (WP-13 §3.5.3–§3.5.5, §3.5.9, §3.5.12): the
 * single consumer of `AgentSession.events`, the live normalizer (WP-12), status signals → engine
 * effects, the process end (cancel decisions, finalize items, undelivered prompts, crash error,
 * auto-retry). Every event is handled synchronously (no await between events), so an exit is
 * processed before the backend aborts the CLI's open canUseTool signals (13a: one macrotask later).
 * Plus the lifecycle operations that run inside the entry's lock: start, close, prompt delivery.
 */
import path from 'node:path';
import type { ClientId, PermissionMode, PromptPriority } from '@shared/common';
import { makeError, type ErrorPayload } from '@shared/errors';
import { currentConversation, currentSessionId } from '@shared/model';
import { openDecisionCount } from '@shared/status';
import type { AgentSession, BackendEvent } from '../backend/types';
import type { LaunchSpec } from '../claude/ports';
import { CommandError } from '../sync/ports';
import { NO_ATTACHMENTS, promptContent, type PromptAttachments } from './attachments';
import { toSlashCommands } from './commandCatalog';
import { commandError, errorMessage, errorPayloadOf, type EngineCore, type EntryState } from './entryState';
import { toModelCatalog } from './models';
import type { LiveNormalizer, StatusSignal } from './ports';
import { afterSuccessfulTurn, decideRetry } from './retry';
import {
  endReasonFor,
  newConversation,
  parseRenameCommand,
  titleChangeDecision,
  withCurrentConversation,
} from './summary';

type ExitEvent = Extract<BackendEvent, { type: 'exit' }>;

/** Bytes of stderr kept for the crash message (English `message` only, never in the UI). */
const STDERR_TAIL_CHARS = 4096;
const STDERR_MESSAGE_CHARS = 1000;

/** supportedModels() attempts before a process that started without a prompt counts as failed (R2-04). */
export const READY_ATTEMPTS = 2;

export class SessionRuntime {
  pid: number | null;
  spawnedAt: Date | null = null;
  /** This process emitted a real session_state signal (ReduceStatusContext). */
  sessionStateSeen = false;
  /** A prompt went to this process (readiness then sets no synthetic idle). */
  sentSinceStart = false;
  /** close() was requested (an iterator end counts as expected). */
  closing = false;
  /** The normalizer may still be used (false once the exit was handled). */
  alive = true;
  /** A turn_result reported a startup failure (its error item and lastError stay). */
  startupFailure = false;
  spawnError: { name: string; message: string } | null = null;
  /**
   * The engine closes this process because of a failure (R2-04: not ready): its exit counts as
   * unexpected with this error, even though close() was called.
   */
  failure: ErrorPayload | null = null;
  /** A non-synthetic turn_result came: query the AI title at the end of the turn. */
  private titleDue = false;
  /** Crash detail of `error{where:'iterator'}` (English message only). */
  private iteratorError: string | null = null;
  readonly exited: Promise<void>;
  private resolveExited: () => void = () => undefined;
  private exitHandled = false;
  private stderrTail = '';
  private readonly startedAt: Date;
  /**
   * WP22-10: `total_cost_usd` counts per query segment (CLI 2.1.300 starts at 0 after a resume,
   * Findings F.14 is outdated). The conversation's cost = the earlier segments (`costBase`) + this
   * segment's total since the conversation began here (`costOffset`, a `/clear` in this process).
   */
  private costBase: number;
  private costOffset = 0;
  private lastCostTotal: number | null = null;

  constructor(
    private readonly state: EntryState,
    private readonly core: EngineCore,
    readonly agent: AgentSession,
    readonly normalizer: LiveNormalizer,
    readonly launch: LaunchSpec,
  ) {
    this.pid = agent.pid;
    this.startedAt = core.now();
    this.costBase = currentConversation(state.entry).costUsd ?? 0;
    this.exited = new Promise((resolve) => {
      this.resolveExited = resolve;
    });
  }

  /** Starts the event loop (background). */
  run(): void {
    void this.loop();
  }

  private async loop(): Promise<void> {
    try {
      for await (const event of this.agent.events) {
        try {
          this.handle(event);
        } catch (error) {
          this.core.reportError(error, `event ${event.type}`);
        }
      }
    } catch (error) {
      this.core.log.error({ err: error, entryId: this.state.id }, 'backend event iterator failed');
    }
    // The port guarantees `exit` as the last event; a broken backend still gets a clean end.
    if (!this.exitHandled) {
      this.onExit({ type: 'exit', code: null, signal: null, expected: this.closing, at: this.core.now() });
    }
  }

  private handle(event: BackendEvent): void {
    switch (event.type) {
      case 'spawned':
        this.onSpawned(event.pid, event.at);
        return;
      case 'stderr':
        this.stderrTail = (this.stderrTail + event.data).slice(-STDERR_TAIL_CHARS);
        return;
      case 'error':
        if (event.where === 'spawn') this.spawnError ??= { name: event.name, message: event.message };
        if (event.where === 'iterator') this.iteratorError ??= `${event.name}: ${event.message}`;
        this.core.log.warn(
          {
            entryId: this.state.id,
            where: event.where,
            name: event.name,
            message: event.message.slice(0, 500),
          },
          'backend error',
        );
        return;
      case 'message':
        this.onMessage(event.message, event.at);
        return;
      case 'exit':
        this.onExit(event);
        return;
    }
  }

  private onSpawned(pid: number, at: Date): void {
    this.pid = pid;
    this.spawnedAt = at;
    const record = {
      entryId: this.state.id,
      pid,
      image: path.win32.basename(this.launch.executablePath),
      startedAt: at.toISOString(),
    };
    this.core.stores.processes.add(record).catch((error: unknown) => {
      this.core.log.warn({ err: error, entryId: this.state.id, pid }, 'processes.json: add failed');
    });
    this.core.processSpawned();
  }

  private onMessage(raw: unknown, at: Date): void {
    if (!this.alive) return;
    const out = this.normalizer.push(raw, at);
    this.state.emit(out.ops);
    for (const signal of out.signals) this.onSignal(signal);
  }

  // ---- signals (§3.5.5; ops of the same output are already published) ----

  private onSignal(signal: StatusSignal): void {
    const s = this.state;
    switch (signal.type) {
      case 'session_state':
        this.sessionStateSeen = true;
        s.reduce(signal);
        if (signal.state === 'idle') {
          s.resetInTurn = false;
          this.turnEnded();
        } else {
          // The error of the last turn stays until the next turn starts (WP-12).
          s.setLastError(null);
        }
        return;
      case 'init':
        s.patch((e) => ({
          ...e,
          cliVersion: signal.cliVersion,
          apiKeySource: signal.apiKeySource,
          permissionMode: signal.permissionMode ?? e.permissionMode,
        }));
        if (currentSessionId(s.entry) === null) this.setSessionId(signal.sessionId);
        s.reduce(signal);
        return;
      case 'session_id':
        this.setSessionId(signal.sessionId);
        return;
      case 'permission_mode': {
        const mode = signal.mode;
        if (mode !== null) s.patch((e) => (e.permissionMode === mode ? e : { ...e, permissionMode: mode }));
        return;
      }
      case 'compacting':
      case 'retry':
      case 'background_tasks':
        s.reduce(signal);
        return;
      case 'rate_limit':
        s.reduce(signal);
        // ADR-114: the subscription display only shows limits of subscription sessions.
        if (s.entry.apiKeySource === 'none') this.core.setAccountLimit(s.entry.profileId, signal.info);
        return;
      case 'assistant_model':
        s.patch((e) => (e.lastModel === signal.model ? e : { ...e, lastModel: signal.model }));
        return;
      case 'assistant_error':
        s.reduce(signal);
        s.setLastError(signal.error);
        return;
      case 'context_estimate': {
        const gauge = this.core.normalizer.estimateContextGauge(
          signal,
          { override: this.launch.contextWindow, lastSdkMaxTokens: s.lastSdkMaxTokens },
          this.core.now(),
        );
        if (gauge !== null) s.setContext(gauge);
        return;
      }
      case 'turn_result':
        this.onTurnResult(signal);
        return;
      case 'conversation_reset':
        this.onConversationReset(signal);
        return;
      case 'title_changed': {
        const decision = titleChangeDecision(
          { titleSource: s.entry.titleSource, pendingRename: s.pendingRename, resetInTurn: s.resetInTurn },
          signal.title,
        );
        if (decision.kind === 'ignore') return;
        if (decision.echo) s.pendingRename = null;
        s.patch((e) => ({ ...e, title: decision.title, titleSource: decision.titleSource }));
        return;
      }
      case 'prompt_lifecycle':
        if (s.queue.onLifecycle(signal.messageUuid, signal.state)) s.publishQueue();
        return;
      case 'mcp_servers':
        this.core.setEngineWarning(
          `mcp:${s.id}`,
          signal.notApproved.length === 0
            ? null
            : makeError('MCP_SERVER_NOT_APPROVED', { servers: signal.notApproved.join(', ').slice(0, 500) }),
        );
        return;
    }
  }

  /** End of a turn (idle, or the result of an old CLI): context gauge and – after a real turn – the AI title. */
  private turnEnded(): void {
    const s = this.state;
    s.scheduleContextRefresh();
    if (this.titleDue) {
      this.titleDue = false;
      s.scheduleAiTitle();
    }
  }

  private setSessionId(sessionId: string): void {
    const s = this.state;
    if (currentSessionId(s.entry) === sessionId) return;
    s.patch((e) => withCurrentConversation(e, (c) => ({ ...c, sessionId })));
    s.emit([{ op: 'detail.patch', patch: { conversations: s.entry.conversations } }]);
  }

  private onTurnResult(signal: Extract<StatusSignal, { type: 'turn_result' }>): void {
    const s = this.state;
    s.reduce(signal);
    if (s.queue.onTurnResult(signal.userMessageUuids)) s.publishQueue();
    const at = this.core.now().toISOString();
    const costUsd = this.conversationCost(signal.costUsdTotal);
    s.patch((e) =>
      withCurrentConversation(
        { ...e, lastActivityAt: at, lastResultExcerpt: signal.resultExcerpt ?? e.lastResultExcerpt },
        (c) => ({ ...c, costUsd: costUsd ?? c.costUsd }),
      ),
    );
    if (signal.error !== null) {
      if (signal.startupFailure) this.startupFailure = true;
      s.setLastError(signal.error);
    } else if (signal.outcome === 'success') {
      s.setLastError(null);
      s.retry = afterSuccessfulTurn(s.retry);
    }
    if (!signal.synthetic && !this.core.shuttingDown()) {
      this.titleDue = true;
      void s.refreshGitBranch();
    }
    // Old CLI without session_state_changed: the result is the turn end (C.1).
    if (!this.sessionStateSeen) this.turnEnded();
    s.resetInTurn = false;
  }

  /** WP22-10: summed over the query segments of the conversation (null = no cost reported). */
  private conversationCost(total: number | null): number | null {
    if (total === null) return null;
    if (this.lastCostTotal !== null && total < this.lastCostTotal) {
      // The counter started again inside this process: keep what was counted so far.
      this.costBase += Math.max(0, this.lastCostTotal - this.costOffset);
      this.costOffset = 0;
    }
    this.lastCostTotal = total;
    return Math.round((this.costBase + Math.max(0, total - this.costOffset)) * 1e9) / 1e9;
  }

  /** §3.5.9, diagram f: the ops of this output already went to the OLD conversation. */
  private onConversationReset(signal: Extract<StatusSignal, { type: 'conversation_reset' }>): void {
    const s = this.state;
    s.broker.cancel('all', 'conversation_reset', 'deny');
    const at = this.core.now().toISOString();
    const previous = currentConversation(s.entry);
    const conversationId = this.core.ids.newId('cv');
    const keepCustom = s.entry.titleSource === 'custom';
    s.patch((e) => ({
      ...e,
      conversations: [
        ...e.conversations.slice(0, -1),
        {
          ...previous,
          endedAt: at,
          endReason: endReasonFor(signal.trigger),
          title: e.title === '' ? null : e.title,
        },
        newConversation(conversationId, at, signal.correlationId),
      ],
      // The CLI takes a custom title over (F.7); otherwise the new conversation starts untitled.
      title: keepCustom ? e.title : '',
      titleSource: keepCustom ? 'custom' : 'none',
      context: null,
      contextPct: null,
    }));
    s.promptTitle = null;
    s.resetInTurn = true;
    s.lastSdkMaxTokens = null;
    // The new conversation costs from here on (the process total keeps counting).
    this.costBase = 0;
    this.costOffset = this.lastCostTotal ?? 0;
    s.emit([
      {
        op: 'conversation.reset',
        conversationId,
        previousConversationId: previous.id,
        trigger: signal.trigger,
        hasEarlier: false,
      },
      { op: 'detail.patch', patch: { conversationId, conversations: s.entry.conversations } },
    ]);
    // Afterwards: the marker system/conversation_reset comes with the next output (WP-12 Nr. 1).
    this.normalizer.startConversation(conversationId, 1);
  }

  // ---- process end (§3.5.12) ----

  onExit(event: ExitEvent): void {
    if (this.exitHandled) return;
    this.exitHandled = true;
    const s = this.state;
    const pid = this.pid;
    try {
      if (this.core.shuttingDown()) {
        // Shutdown: nothing is cancelled or persisted (open decisions → expired after the restart).
        if (pid !== null) this.core.stores.processes.remove(s.id, pid);
        return;
      }
      const idleBefore =
        s.facts.runState === 'idle' && s.queue.count() === 0 && openDecisionCount(s.facts) === 0;
      // Synchronously first: the CLI's signals of open canUseTool requests abort only afterwards.
      s.broker.cancel('all', 'process_exit', 'deny');
      const finalized = this.normalizer.finalizeOpen('process_exit');
      s.emit(finalized.ops);
      for (const signal of finalized.signals) this.onSignal(signal);
      this.alive = false;

      const undelivered = s.queue.drain();
      for (const prompt of undelivered) {
        s.addSystemError(
          makeError(
            'PROMPT_NOT_DELIVERED',
            { messageUuid: prompt.messageUuid, preview: prompt.text.text.slice(0, 100) },
            'the process ended before the prompt was started; it is not resent automatically',
          ),
        );
      }
      if (undelivered.length > 0) s.publishQueue();

      // An engine-initiated close because of a failure (R2-04) ends in `error`, not `sleeping`; a
      // crash on its own keeps its own error.
      const expected = event.expected && this.failure === null;
      let error: ErrorPayload | null = null;
      if (!expected) {
        error = event.expected && this.failure !== null ? this.failure : this.exitError(event);
        if (!this.startupFailure) {
          s.addSystemError(error);
          s.setLastError(error);
        }
      }
      s.reduce({ type: 'process_exit', expected, error });
      if (pid !== null) this.core.stores.processes.remove(s.id, pid);
      const runtimeMs = event.at.getTime() - (this.spawnedAt ?? this.startedAt).getTime();
      this.scheduleRetry({ expected, code: error?.code ?? null, idleBefore, runtimeMs });
    } catch (error) {
      this.core.reportError(error, 'onExit');
    } finally {
      this.alive = false;
      if (s.runtime === this) {
        s.runtime = null;
        s.phase = 'dormant';
      }
      s.cancelProcessTimers();
      if (!this.core.shuttingDown()) s.dropMirrorIfUnused();
      this.core.processEnded();
      this.resolveExited();
    }
  }

  private exitError(event: ExitEvent): ErrorPayload {
    const stderr = this.stderrTail.trim().slice(-STDERR_MESSAGE_CHARS);
    if (this.spawnError !== null) {
      return makeError(
        'CLAUDE_SPAWN_FAILED',
        { reason: this.spawnError.message.slice(0, 200) },
        `${this.spawnError.name}: ${this.spawnError.message}`.slice(0, 2000),
      );
    }
    const details = [
      'claude exited unexpectedly',
      ...(this.iteratorError === null ? [] : [`iterator: ${this.iteratorError}`]),
      ...(stderr === '' ? [] : [`stderr: ${stderr}`]),
    ];
    return makeError(
      'CLAUDE_PROCESS_CRASHED',
      { exitCode: event.code, signal: event.signal },
      details.join('; ').slice(0, 2000),
    );
  }

  private scheduleRetry(end: Parameters<typeof decideRetry>[2]): void {
    const s = this.state;
    const decision = decideRetry(this.core.options.autoRetry, s.retry, end);
    s.retry = decision.state;
    if (!decision.retry) return;
    this.core.log.warn(
      { entryId: s.id, attempt: decision.attempt, delayMs: decision.delayMs },
      'claude crashed while idle – automatic restart scheduled',
    );
    s.cancelRetry();
    s.retryTimer = this.core.timers.setTimeout(() => {
      s.retryTimer = null;
      if (this.core.shuttingDown() || s.runtime !== null) return;
      s.lifecycle
        .run(() => startRuntime(s, this.core, { byClientId: null }))
        .catch((error: unknown) => {
          this.core.log.warn({ err: error, entryId: s.id }, 'automatic restart failed');
        });
    }, decision.delayMs);
  }

  /**
   * Readiness (§2.3 Nr. 6): supportedModels() answers after the initialize handshake. R2-04: a
   * second attempt after a failure/timeout (the backend bounds each one, SdkBackend `readyMs`
   * 60 s); if both fail and nothing else showed that the process works (no session_state, no
   * prompt), the process is closed and the entry ends in `error` with CLAUDE_CONTROL_FAILED –
   * never a lasting `starting`.
   */
  async ready(): Promise<void> {
    const s = this.state;
    let raw: unknown[] | null = null;
    for (let attempt = 1; raw === null; attempt += 1) {
      try {
        raw = await this.agent.supportedModels();
      } catch (error) {
        if (!this.alive || this.closing) return;
        this.core.log.warn({ err: error, entryId: s.id, attempt }, 'supportedModels failed');
        if (attempt >= READY_ATTEMPTS) {
          this.notReady(error);
          return;
        }
      }
    }
    if (!this.alive) return;
    const catalog = toModelCatalog(raw);
    this.core.setModels(s.entry.profileId, catalog);
    s.emit([{ op: 'detail.patch', patch: { models: catalog.options } }]);
    // Started without a prompt: nothing else would leave `starting` (synthetic, not "seen").
    if (!this.sessionStateSeen && !this.sentSinceStart) s.reduce({ type: 'session_state', state: 'idle' });
    // Phase 2: the slash-command catalog (ADR-108) and the git branch (ADR-113) after readiness.
    void this.refreshCommands();
    void s.refreshGitBranch();
  }

  /** ADR-108: `supportedCommands()` → `detail.patch {commands}` (+ cache via emit); errors only logged. */
  private async refreshCommands(): Promise<void> {
    let raw: unknown[];
    try {
      raw = await this.agent.supportedCommands();
    } catch (error) {
      if (this.alive && !this.closing) {
        this.core.log.warn({ err: error, entryId: this.state.id }, 'supportedCommands failed');
      }
      return;
    }
    if (!this.alive || this.state.runtime !== this) return;
    this.state.emit([{ op: 'detail.patch', patch: { commands: toSlashCommands(raw) } }]);
  }

  /** Readiness failed twice (R2-04): close the process, the exit reports `failure`. */
  private notReady(error: unknown): void {
    const s = this.state;
    // A prompt went out or the CLI reported its state: its own signals drive the status. Without a
    // process (or once it ends) the exit reports the real cause.
    if (this.sessionStateSeen || this.sentSinceStart || this.pid === null || !this.alive) return;
    this.failure = makeError(
      'CLAUDE_CONTROL_FAILED',
      { method: 'supportedModels' },
      `claude did not become ready: ${errorMessage(error)}`.slice(0, 2000),
    );
    this.core.log.error({ entryId: s.id, pid: this.pid }, 'claude did not become ready – closing it');
    s.lifecycle
      .run(() => (s.runtime === this ? closeRuntime(s, this.core, 'not_ready') : Promise.resolve()))
      .catch((closeError: unknown) => {
        this.core.reportError(closeError, 'close after readiness failure');
      });
  }
}

// =====================================================================================
// Lifecycle operations (call inside `state.lifecycle.run`)
// =====================================================================================

export interface StartOptions {
  /** Who triggered the start (closeExpired → decision.resolved.byClientId); null = engine. */
  byClientId: ClientId | null;
  /** Plan approval after a restart (A.10): the mode chosen in the expired card. */
  permissionMode?: PermissionMode;
}

/** §3.5.3. Throws CommandError (start failure: status `error`, px item, lastError). */
export async function startRuntime(
  s: EntryState,
  core: EngineCore,
  options: StartOptions,
): Promise<SessionRuntime> {
  if (s.runtime !== null) return s.runtime;
  core.assertRunning();
  // ADR-106: an archived entry never starts (also not a start queued before the archiving, a retry).
  if (s.entry.archived) throw commandError('SESSION_ARCHIVED', { entryId: s.id });
  s.phase = 'starting';
  try {
    if (s.orphanPending) {
      // R2-02: a recorded claude.exe of this entry was alive at the server start; its check runs in
      // the background (≤ 60 s). Never two writers on one JSONL – wait, but visibly.
      s.reduce({ type: 'process_starting' });
    }
    await s.orphanCleanup;
    core.assertRunning();
    let launch: LaunchSpec;
    try {
      launch = await core.claude.launchSpecFor(s.entry.profileId, s.id);
      await core.checkCwd(s.entry.cwd);
    } catch (error) {
      core.assertRunning();
      const payload = errorPayloadOf(error, makeError('INTERNAL_ERROR', {}, errorMessage(error)));
      if (!(error instanceof CommandError)) core.reportError(error, 'start');
      s.failStart(payload);
      throw new CommandError(payload);
    }
    s.lastEnv = launch.env;
    try {
      await s.ensureMirror();
    } catch (error) {
      core.log.error(
        { err: error, entryId: s.id },
        'transcript could not be read – starting with an empty view',
      );
      s.emptyMirror();
    }
    core.assertRunning();

    const entry = s.entry;
    const profile = core.profile(entry.profileId);
    const allowsBypass = core.allowsBypass(entry.profileId);
    let permissionMode: PermissionMode | null =
      options.permissionMode ??
      entry.permissionMode ??
      profile?.defaults.permissionMode ??
      launch.sdkOptions.permissionMode ??
      null;
    // C.3 / §5.2: a stored bypass mode is passed only while the profile still allows it.
    if (permissionMode === 'bypassPermissions' && !allowsBypass) permissionMode = null;

    s.broker.closeExpired(options.byClientId);
    const conversation = currentConversation(entry);
    const normalizer = core.normalizer.createLiveNormalizer({
      entryId: entry.id,
      conversationId: conversation.id,
      nextOrder: conversation.lastOrder + 1,
      storeBlob: (data, mediaType, name) => core.stores.blobs.put(data, mediaType, name),
      now: core.now,
    });
    let agent: AgentSession;
    try {
      agent = core.backend.start({
        entryId: entry.id,
        cwd: entry.cwd,
        launch,
        resumeSessionId: currentSessionId(entry),
        model: entry.modelSetting ?? launch.sdkOptions.model ?? null,
        permissionMode,
        effort: entry.effort,
        // ADR-117: the setting applies from the next process start.
        promptSuggestions: core.stores.settings.get().promptSuggestions,
        fastMode: entry.fastMode,
        canUseTool: s.broker.handler,
      });
    } catch (error) {
      const payload = makeError('CLAUDE_SPAWN_FAILED', { reason: errorMessage(error).slice(0, 200) });
      s.failStart(payload);
      throw new CommandError(payload);
    }
    const runtime = new SessionRuntime(s, core, agent, normalizer, launch);
    s.runtime = runtime;
    s.phase = 'running';
    s.reduce({ type: 'process_starting' });
    runtime.run();
    if (agent.pid === null) {
      // R2-07: no process was spawned (synchronous spawn failure, missing .exe). The exit events
      // set the status (error, px item, lastError); the command fails with the start code (§3.5.6)
      // instead of a later SESSION_NOT_RUNNING.
      await runtime.exited;
      const reason = runtime.spawnError?.message ?? 'claude could not be started';
      throw new CommandError(makeError('CLAUDE_SPAWN_FAILED', { reason: reason.slice(0, 200) }));
    }
    void runtime.ready();
    return runtime;
  } finally {
    if (s.runtime === null) s.phase = 'dormant';
  }
}

/**
 * `closeRuntime(reason)` (§3.5.12): close() (5-s rule in the backend); onExit cleans up. Open
 * decisions are cancelled first (`process_exit`, R2-16): deterministic, whether or not the SDK
 * aborts the CLI's canUseTool signals before the process exit.
 */
export async function closeRuntime(
  s: EntryState,
  core: EngineCore,
  reason: 'user' | 'sleep' | 'handoff' | 'not_ready' | 'archive' | 'switch',
): Promise<void> {
  const runtime = s.runtime;
  if (runtime === null) return;
  core.log.info({ entryId: s.id, reason }, 'closing claude process');
  s.phase = 'closing';
  runtime.closing = true;
  s.broker.cancel('all', 'process_exit', 'deny');
  try {
    await runtime.agent.close();
  } catch (error) {
    core.log.error({ err: error, entryId: s.id }, 'close() failed – killing the process tree');
    if (runtime.pid !== null) {
      await core.proc.killProcessTree(runtime.pid).catch((killError: unknown) => {
        core.log.error({ err: killError, entryId: s.id }, 'killProcessTree failed');
      });
    }
  }
  await runtime.exited;
}

/**
 * Sends one prompt to the running process (§3.5.6 sendPrompt): `/rename X` → pendingRename,
 * `now` cancels open main-agent decisions, registerPrompt BEFORE send (F.9), queue `sending`.
 * Phase 2 (ADR-103): checked image attachments go first as base64 blocks; the `user_message` item
 * and the queue entry carry their BlobRefs.
 */
export function deliverPrompt(
  s: EntryState,
  core: EngineCore,
  text: string,
  priority: PromptPriority,
  attachments: PromptAttachments = NO_ATTACHMENTS,
): string {
  const runtime = s.runtime;
  if (runtime === null || !runtime.alive || runtime.closing) {
    throw commandError('SESSION_NOT_RUNNING', { entryId: s.id });
  }
  const messageUuid = core.ids.newUuid();
  const rename = parseRenameCommand(text);
  if (rename !== null) s.pendingRename = rename;
  if (priority === 'now' && s.broker.open().some((d) => d.requester.kind === 'main')) {
    s.broker.cancel('main', 'interrupted', 'deny');
  }
  const at = core.now();
  runtime.normalizer.registerPrompt({ messageUuid, text, attachments: [...attachments.refs], priority, at });
  s.queue.add({
    messageUuid,
    text: core.capText(text),
    attachments: [...attachments.refs],
    priority,
    queuedAt: at.toISOString(),
  });
  s.publishQueue();
  runtime.sentSinceStart = true;
  try {
    runtime.agent.send({ uuid: messageUuid, content: promptContent(text, attachments), priority });
  } catch (error) {
    core.log.warn({ err: error, entryId: s.id }, 'send() refused the prompt');
    if (s.queue.remove(messageUuid)) s.publishQueue();
    throw commandError('SESSION_NOT_RUNNING', { entryId: s.id, reason: 'closed' });
  }
  s.patch((e) => ({ ...e, lastActivityAt: at.toISOString() }));
  return messageUuid;
}
