/**
 * One FakeBackend session (WP-13 §3.3): the `AgentSession` the engine sees plus the
 * `FakeSessionHandle` tests inspect. Holds the gates (input, canUseTool, control interrupt,
 * close), the UUID mapping and the answers of control/read calls; the scenario (events player or
 * script) drives it. `exit` is always the last event; afterwards the event queue ends.
 */
import type { PermissionResult } from '@anthropic-ai/claude-agent-sdk';
import { z } from 'zod';
import { nextMacrotask, realSetImmediate, toError } from '../../lib/async';
import { logger } from '../../lib/logger';
import type { FixtureEvent } from '../fixture';
import { AsyncQueue } from '../lib/asyncQueue';
import { toPermissionRequest } from '../permissionRequest';
import type {
  AgentSession,
  BackendEvent,
  OutgoingPrompt,
  PermissionRequest,
  StartSessionRequest,
} from '../types';
import {
  HANDLER_ERROR_RESULT,
  SessionStopped,
  TurnInterrupted,
  promptContent,
  promptText,
  type RecordedAnswer,
} from './common';
import { FAKE_COMMANDS, FAKE_MODELS, fakeContextUsage, resolveFakeModel } from './defaults';
import { dslContext, textTurn } from './dsl';
import type { FakeHistoryStore } from './history';
import { EventPlayer } from './player';
import type {
  FakeDiagnostic,
  FakeDiagnosticKind,
  FakeIds,
  FakeScenario,
  FakeScriptContext,
  FakeScriptState,
  FakeSessionHandle,
  FakeSessionState,
} from './types';

const log = logger.child({ module: 'fakeBackend' });

const CANCELLED_RESULT: PermissionResult = { behavior: 'deny', message: 'Cancelled.' };

interface OpenDecision {
  toolUseId: string;
  controller: AbortController;
  release(result: PermissionResult | null): void;
}

export interface FakeSessionDeps {
  n: number;
  req: StartSessionRequest;
  scenario: FakeScenario;
  pid: number;
  speed: number;
  maxDelayMs: number;
  sleep(ms: number): Promise<void>;
  now(): Date;
  history: FakeHistoryStore;
  ids: FakeIds;
  onStateChange(): void;
}

const sessionIdSchema = z.looseObject({ session_id: z.string().min(1) });
const resultSchema = z.looseObject({ type: z.literal('result') });

function errorText(error: unknown): string {
  if (typeof error === 'string') return error;
  const parsed = z.looseObject({ message: z.string() }).safeParse(error);
  return parsed.success ? parsed.data.message : JSON.stringify(error);
}

export class FakeSession implements AgentSession, FakeSessionHandle {
  readonly entryId: string;
  readonly pid: number;
  readonly scenario: string;
  readonly events = new AsyncQueue<BackendEvent>();
  readonly sent: OutgoingPrompt[] = [];
  readonly controls: { method: string; args: unknown[] }[] = [];
  readonly calls: { fn: string; args: unknown[] }[] = [];
  readonly diagnostics: FakeDiagnostic[] = [];
  /** Fixture UUID → UUID actually sent (input gates). */
  readonly uuidMap = new Map<string, string>();
  /** Last result per toolUseId (null = aborted). */
  readonly lastResults = new Map<string, PermissionResult | null>();
  readonly openDecisions = new Map<string, OpenDecision>();
  /** Played `call` answers (last one per fn) and the first one of the scenario file. */
  readonly callAnswers = new Map<string, RecordedAnswer>();
  readonly firstCallAnswers = new Map<string, RecordedAnswer>();
  private readonly controlAnswers = new Map<string, RecordedAnswer[]>();
  private readonly players: EventPlayer[] = [];
  private readonly inputs: OutgoingPrompt[] = [];
  private inputWaiter: ((prompt: OutgoingPrompt) => void) | null = null;
  private closeWaiter: (() => void) | null = null;
  private readonly stopController = new AbortController();
  private readonly exitDone = Promise.withResolvers<undefined>();
  private readonly pendingHistoryPrompts: OutgoingPrompt[] = [];
  private currentState: FakeSessionState = 'running';
  private currentSessionId: string | null;
  private exited = false;
  private closeRequested = false;
  private spawnedSent = false;
  private resultCount = 0;
  private script: ScriptContext | null = null;
  /** Events mode: registered from the start, so interrupt() before the first event finds its gate. */
  private readonly mainPlayer: EventPlayer | null = null;

  constructor(private readonly deps: FakeSessionDeps) {
    this.entryId = deps.req.entryId;
    this.pid = deps.pid;
    this.scenario = deps.scenario.name;
    this.currentSessionId =
      deps.scenario.kind === 'script' ? (deps.req.resumeSessionId ?? deps.ids.uuid()) : null;
    const scenario = deps.scenario;
    if (scenario.kind === 'events') {
      this.mainPlayer = new EventPlayer(this, scenario.events, {
        ...(scenario.options?.crashAfterSeq === undefined
          ? {}
          : { crashAfterSeq: scenario.options.crashAfterSeq }),
        seedAnswers: true,
      });
      this.players.push(this.mainPlayer);
    } else {
      // Created now, so control calls right after start() (setModel …) already change its state.
      this.script = new ScriptContext(this, deps, this.currentSessionId ?? deps.ids.uuid());
    }
  }

  get state(): FakeSessionState {
    return this.currentState;
  }

  get sessionId(): string | null {
    return this.currentSessionId;
  }

  now(): Date {
    return this.deps.now();
  }

  /** Starts the scenario in the next macrotask (start() is synchronous). */
  begin(): void {
    realSetImmediate(() => {
      void this.run();
    });
  }

  // ---- AgentSession ----

  send(prompt: OutgoingPrompt): void {
    if (this.exited || this.closeRequested) throw new Error('session closed');
    this.sent.push(prompt);
    if (this.currentState === 'waiting-close') {
      this.diagnostic(
        'unexpected-input',
        null,
        `prompt ${prompt.uuid} sent while the scenario waits for close()`,
      );
    }
    this.script?.onSend(prompt);
    const waiter = this.inputWaiter;
    if (waiter !== null) {
      this.inputWaiter = null;
      waiter(prompt);
    } else if (prompt.priority === 'now') {
      // 'now' overtakes prompts that wait with 'next' (F.9).
      const firstNext = this.inputs.findIndex((p) => p.priority === 'next');
      this.inputs.splice(firstNext < 0 ? this.inputs.length : firstNext, 0, prompt);
    } else {
      this.inputs.push(prompt);
    }
  }

  async interrupt(): Promise<{ stillQueued: string[] }> {
    this.controls.push({ method: 'interrupt', args: [] });
    if (this.exited) throw new Error('session closed');
    for (const player of [...this.players].reverse()) {
      const answer = player.interrupt();
      if (answer !== null) return answer;
    }
    if (this.script !== null) return this.script.interrupt();
    this.diagnostic('unexpected-interrupt', null, 'interrupt() without a coming control interrupt gate');
    return Promise.resolve({ stillQueued: [] });
  }

  async setModel(model: string | null): Promise<void> {
    await this.control('setModel', [model], () => {
      if (this.script !== null) this.script.state.model = resolveFakeModel(model);
    });
  }

  async setPermissionMode(mode: Parameters<AgentSession['setPermissionMode']>[0]): Promise<void> {
    await this.control('setPermissionMode', [mode], () => {
      this.script?.setPermissionMode(mode);
    });
  }

  async applyFlagSettings(settings: Parameters<AgentSession['applyFlagSettings']>[0]): Promise<void> {
    await this.control('applyFlagSettings', [settings], () => {
      if (this.script !== null && settings.effortLevel !== undefined)
        this.script.state.effort = settings.effortLevel;
    });
  }

  async getContextUsage(detail: 'summary' | 'full'): Promise<unknown> {
    return this.call('getContextUsage', [{ detail }], () =>
      fakeContextUsage(this.turns(), this.script?.state.model),
    );
  }

  async supportedModels(): Promise<unknown[]> {
    const answer = await this.call('supportedModels', [], () => [...FAKE_MODELS]);
    const list = z.array(z.unknown()).safeParse(answer);
    return list.success ? list.data : [...FAKE_MODELS];
  }

  async supportedCommands(): Promise<unknown[]> {
    const answer = await this.call('supportedCommands', [], () => [...FAKE_COMMANDS]);
    const list = z.array(z.unknown()).safeParse(answer);
    return list.success ? list.data : [...FAKE_COMMANDS];
  }

  async stopTask(taskId: string): Promise<void> {
    await this.control('stopTask', [taskId]);
  }

  close(): Promise<void> {
    if (this.exited) return this.exitDone.promise;
    this.closeRequested = true;
    const waiter = this.closeWaiter;
    if (waiter !== null) {
      // The scenario waits at an exit gate: it emits the recorded exit (expected).
      this.closeWaiter = null;
      waiter();
    } else {
      this.exit(0, null, true);
    }
    return this.exitDone.promise;
  }

  // ---- FakeSessionHandle ----

  crash(code = 1): void {
    this.exit(code, null, false);
  }

  abortDecision(toolUseId?: string): void {
    const open =
      toolUseId === undefined ? this.openDecisions.values().next().value : this.openDecisions.get(toolUseId);
    if (open === undefined) {
      log.warn(
        { entryId: this.entryId, toolUseId: toolUseId ?? null },
        'abortDecision: no open canUseTool request',
      );
      return;
    }
    this.openDecisions.delete(open.toolUseId);
    this.lastResults.set(open.toolUseId, null);
    open.controller.abort();
    open.release(null);
  }

  // ---- Primitives for player and script ----

  diagnostic(
    kind: FakeDiagnosticKind,
    seq: number | null,
    message: string,
    detail: { expected?: unknown; actual?: unknown } = {},
  ): void {
    this.diagnostics.push({ kind, seq, message, ...detail });
    log.debug({ entryId: this.entryId, scenario: this.scenario, kind, seq, message }, 'fake diagnostic');
  }

  setState(state: FakeSessionState): void {
    if (this.exited || this.currentState === state) return;
    this.currentState = state;
    this.deps.onStateChange();
  }

  /** Rejects with SessionStopped when the session stops, with TurnInterrupted when `turn` aborts. */
  race<T>(promise: Promise<T>, turn?: AbortSignal): Promise<T> {
    if (this.exited) return Promise.reject(new SessionStopped());
    if (turn?.aborted === true) return Promise.reject(this.interruption(turn));
    const stop = this.stopController.signal;
    return new Promise<T>((resolve, reject) => {
      const cleanup = (): void => {
        stop.removeEventListener('abort', onStop);
        turn?.removeEventListener('abort', onTurn);
      };
      const onStop = (): void => {
        cleanup();
        reject(new SessionStopped());
      };
      const onTurn = (): void => {
        cleanup();
        reject(this.interruption(turn));
      };
      stop.addEventListener('abort', onStop, { once: true });
      turn?.addEventListener('abort', onTurn, { once: true });
      promise.then(
        (value) => {
          cleanup();
          resolve(value);
        },
        (error: unknown) => {
          cleanup();
          reject(toError(error));
        },
      );
    });
  }

  private interruption(turn: AbortSignal | undefined): TurnInterrupted {
    return new TurnInterrupted(turn?.reason === 'now' ? 'now' : 'interrupt');
  }

  /** Waits `recordedMs × speed` (≤ maxDelayMs); 0 → one real macrotask. */
  async delay(recordedMs: number, turn?: AbortSignal): Promise<void> {
    const ms = Math.min(Math.max(0, recordedMs) * this.deps.speed, this.deps.maxDelayMs);
    await this.race(ms <= 0 ? nextMacrotask() : this.deps.sleep(ms), turn);
  }

  spawned(): void {
    if (this.spawnedSent) return;
    this.spawnedSent = true;
    this.push({ type: 'spawned', pid: this.pid, at: this.deps.now() });
  }

  push(event: BackendEvent): void {
    if (this.exited) return;
    this.events.push(event);
  }

  /** A raw SDK message: session id, history, event. */
  emitMessage(raw: unknown): void {
    if (this.exited) return;
    const id = sessionIdSchema.safeParse(raw);
    if (id.success) {
      this.currentSessionId = id.data.session_id;
      this.flushHistoryPrompts();
    }
    if (resultSchema.safeParse(raw).success) this.resultCount += 1;
    if (this.currentSessionId !== null) this.deps.history.record(this.currentSessionId, raw);
    this.push({ type: 'message', message: raw, at: this.deps.now() });
  }

  /** The prompt as user message of the history (once the session id is known). */
  recordPrompt(prompt: OutgoingPrompt): void {
    this.pendingHistoryPrompts.push(prompt);
    this.flushHistoryPrompts();
  }

  private flushHistoryPrompts(): void {
    const sessionId = this.currentSessionId;
    if (sessionId === null) return;
    while (this.pendingHistoryPrompts.length > 0) {
      const prompt = this.pendingHistoryPrompts.shift();
      if (prompt === undefined) break;
      this.deps.history.record(sessionId, {
        type: 'user',
        uuid: prompt.uuid,
        message: { role: 'user', content: promptContent(prompt) },
        parent_tool_use_id: null,
        timestamp: this.deps.now().toISOString(),
        origin: { kind: 'human' },
      });
    }
  }

  /** Input gate: the next sent prompt (buffered ones first). */
  async waitInput(turn?: AbortSignal): Promise<OutgoingPrompt> {
    const buffered = this.inputs.shift();
    if (buffered !== undefined) return buffered;
    this.setState('waiting-input');
    try {
      return await this.race(
        new Promise<OutgoingPrompt>((resolve) => {
          this.inputWaiter = resolve;
        }),
        turn,
      );
    } finally {
      this.inputWaiter = null;
      this.setState('running');
    }
  }

  /** Exit gate: resolves on close(). */
  async waitClose(): Promise<void> {
    if (this.closeRequested) return;
    this.setState('waiting-close');
    await this.race(
      new Promise<void>((resolve) => {
        this.closeWaiter = resolve;
      }),
    );
  }

  /** Blocks in `state` until `promise` settles (or the session stops). */
  async blockOn<T>(state: FakeSessionState, promise: Promise<T>): Promise<T> {
    this.setState(state);
    try {
      return await this.race(promise);
    } finally {
      this.setState('running');
    }
  }

  /**
   * canUseTool → engine. Resolves with the engine's result, null when the request was aborted
   * (abortDecision / `abort` event / exit); a throwing handler answers like the SdkBackend (deny).
   */
  startDecision(request: PermissionRequest, seq: number | null): Promise<PermissionResult | null> {
    const controller = new AbortController();
    const gate = Promise.withResolvers<PermissionResult | null>();
    const open: OpenDecision = { toolUseId: request.toolUseId, controller, release: gate.resolve };
    this.openDecisions.set(request.toolUseId, open);
    let answer: Promise<PermissionResult>;
    try {
      answer = this.deps.req.canUseTool(request, controller.signal);
    } catch (error) {
      answer = Promise.reject(toError(error));
    }
    answer.then(
      (result) => {
        gate.resolve(result);
      },
      (error: unknown) => {
        const message = error instanceof Error ? error.message : String(error);
        this.diagnostic('handler-error', seq, `canUseTool handler threw: ${message}`);
        this.push({ type: 'error', where: 'control', name: 'Error', message, at: this.deps.now() });
        gate.resolve(HANDLER_ERROR_RESULT);
      },
    );
    return gate.promise.then((result) => {
      if (this.openDecisions.get(request.toolUseId) === open) this.openDecisions.delete(request.toolUseId);
      if (!this.lastResults.has(request.toolUseId) || result !== null)
        this.lastResults.set(request.toolUseId, result);
      return result;
    });
  }

  queueControlAnswer(method: string, answer: RecordedAnswer): void {
    const list = this.controlAnswers.get(method) ?? [];
    list.push(answer);
    this.controlAnswers.set(method, list);
  }

  pushPlayer(player: EventPlayer): void {
    if (!this.players.includes(player)) this.players.push(player);
  }

  popPlayer(player: EventPlayer): void {
    const index = this.players.lastIndexOf(player);
    if (index >= 0) this.players.splice(index, 1);
  }

  /** Ends the process: exit event (always last), queue end, stop; open signals abort afterwards. */
  exit(code: number | null, signal: string | null, expected: boolean): void {
    if (this.exited) return;
    this.events.push({ type: 'exit', code, signal, expected, at: this.deps.now() });
    this.events.end();
    this.exited = true;
    this.currentState = 'exited';
    const open = [...this.openDecisions.values()];
    this.openDecisions.clear();
    for (const decision of open) decision.release(null);
    // The engine cancels open decisions with `process_exit` when it sees the exit; the CLI's
    // signals abort only afterwards (one macrotask later), like a process that is gone.
    realSetImmediate(() => {
      for (const decision of open) decision.controller.abort();
    });
    this.stopController.abort();
    this.exitDone.resolve(undefined);
    this.deps.onStateChange();
  }

  // ---- internals ----

  private turns(): number {
    return this.script?.state.turns ?? this.resultCount;
  }

  private async control(method: string, args: unknown[], apply?: () => void): Promise<unknown> {
    this.controls.push({ method, args });
    if (this.exited) throw new Error('session closed');
    const answer = this.controlAnswers.get(method)?.shift();
    if (answer?.error !== undefined) throw new Error(errorText(answer.error));
    apply?.();
    return Promise.resolve(answer?.result);
  }

  private async call(fn: string, args: unknown[], fallback: () => unknown): Promise<unknown> {
    this.calls.push({ fn, args });
    if (this.exited) throw new Error('session closed');
    const answer = this.callAnswers.get(fn) ?? this.firstCallAnswers.get(fn);
    if (answer === undefined) return Promise.resolve(fallback());
    if (answer.error !== undefined) throw new Error(errorText(answer.error));
    return Promise.resolve(structuredClone(answer.result));
  }

  private async run(): Promise<void> {
    const scenario = this.deps.scenario;
    try {
      if (scenario.kind === 'events') {
        if (!scenario.events.some((e) => e.kind === 'spawn')) this.spawned();
        await this.mainPlayer?.play();
        await this.exhausted(scenario.options?.onExhausted ?? 'idle');
      } else if (this.script !== null) {
        this.spawned();
        await scenario.run(this.script);
        this.script = null;
        await this.exhausted('idle');
      }
    } catch (error) {
      if (error instanceof SessionStopped || this.exited) return;
      const message = error instanceof Error ? error.message : String(error);
      log.error({ err: error, entryId: this.entryId, scenario: this.scenario }, 'fake scenario failed');
      this.diagnostic('scenario-error', null, message);
      this.push({
        type: 'error',
        where: 'iterator',
        name: error instanceof Error ? error.name : 'Error',
        message,
        at: this.deps.now(),
      });
      this.exit(1, null, false);
    }
  }

  /** After the last event: wait like a real CLI; later prompts → diagnostics or echo turns. */
  private async exhausted(mode: 'idle' | 'echo'): Promise<void> {
    for (;;) {
      const prompt = await this.waitInput();
      if (mode === 'idle') {
        this.diagnostic('unexpected-input', null, `no input gate left for prompt ${prompt.uuid}`, {
          actual: promptText(prompt),
        });
        continue;
      }
      this.recordPrompt(prompt);
      const c = dslContext({
        sessionId: this.currentSessionId ?? this.deps.ids.uuid(),
        ids: this.deps.ids,
        timestamp: () => this.deps.now().toISOString(),
      });
      await new EventPlayer(
        this,
        textTurn(c, { prompt: prompt.uuid, text: `Echo: ${promptText(prompt)}` }),
      ).play();
    }
  }
}

/** FakeScriptContext of one script run. */
class ScriptContext implements FakeScriptContext {
  readonly req: StartSessionRequest;
  readonly state: FakeScriptState;
  readonly ids: FakeIds;
  readonly history: FakeHistoryStore;
  private turn = new AbortController();
  private inTurn = false;

  constructor(
    private readonly session: FakeSession,
    private readonly deps: FakeSessionDeps,
    readonly sessionId: string,
  ) {
    this.req = deps.req;
    this.ids = deps.ids;
    this.history = deps.history;
    this.state = {
      model: resolveFakeModel(deps.req.model),
      permissionMode: deps.req.permissionMode ?? 'default',
      effort: deps.req.effort,
      turns: 0,
    };
  }

  get turnSignal(): AbortSignal {
    return this.turn.signal;
  }

  now(): Date {
    return this.deps.now();
  }

  async nextInput(): Promise<OutgoingPrompt> {
    this.inTurn = false;
    const prompt = await this.session.waitInput();
    this.turn = new AbortController();
    this.inTurn = true;
    this.session.recordPrompt(prompt);
    return prompt;
  }

  async emit(messages: readonly unknown[], gapMs = 0): Promise<void> {
    try {
      for (const message of messages) {
        await this.session.delay(gapMs, this.turn.signal);
        this.session.emitMessage(message);
      }
    } catch (error) {
      this.freshTurnAfter(error);
      throw error;
    }
  }

  async canUseTool(
    toolName: string,
    input: Record<string, unknown>,
    options: Record<string, unknown>,
  ): Promise<PermissionResult> {
    const request = toPermissionRequest(toolName, input, options);
    const result = await this.session.blockOn('waiting-decision', this.session.startDecision(request, null));
    return result ?? CANCELLED_RESULT;
  }

  async play(events: readonly FixtureEvent[]): Promise<void> {
    try {
      await new EventPlayer(this.session, events, { turnSignal: this.turn.signal }).play();
    } catch (error) {
      this.freshTurnAfter(error);
      throw error;
    }
  }

  async crash(code = 1): Promise<never> {
    this.session.crash(code);
    return Promise.reject(new SessionStopped());
  }

  /** interrupt() in the script mode: aborts the running turn (idle: no-op, F.10). */
  interrupt(): Promise<{ stillQueued: string[] }> {
    if (this.inTurn) this.turn.abort('interrupt');
    return Promise.resolve({ stillQueued: [] });
  }

  onSend(prompt: OutgoingPrompt): void {
    if (!this.inTurn) return;
    if (prompt.priority === 'now') {
      this.turn.abort('now');
      return;
    }
    // Like the CLI: a prompt sent during a turn is queued at once (F.9).
    this.session.emitMessage({
      type: 'command_lifecycle',
      command_uuid: prompt.uuid,
      state: 'queued',
      uuid: this.ids.uuid(),
      session_id: this.session.sessionId ?? this.sessionId,
    });
  }

  /** F.2: in a turn the CLI reports the new mode with system/status; idle → only the next init. */
  setPermissionMode(mode: FakeScriptState['permissionMode']): void {
    this.state.permissionMode = mode;
    if (!this.inTurn) return;
    this.session.emitMessage({
      type: 'system',
      subtype: 'status',
      status: null,
      permissionMode: mode,
      uuid: this.ids.uuid(),
      session_id: this.session.sessionId ?? this.sessionId,
    });
  }

  /** After TurnInterrupted the epilogue of the same turn must still be playable. */
  private freshTurnAfter(error: unknown): void {
    if (error instanceof TurnInterrupted) this.turn = new AbortController();
  }
}
