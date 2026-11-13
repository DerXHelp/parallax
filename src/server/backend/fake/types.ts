/**
 * Types of the FakeBackend (WP-13 §3.3). Re-exported by `backend/fakeBackend.ts` – import them
 * from there.
 */
import type { PermissionResult } from '@anthropic-ai/claude-agent-sdk';
import type { EffortLevel, PermissionMode } from '@shared/common';
import type { FixtureEvent } from '../fixture';
import type { AgentBackend, OutgoingPrompt, RemoteControlInfo, StartSessionRequest } from '../types';
import type { FakeFiles } from './files';
import type { FakeHistoryStore } from './history';

export type FakeScenario =
  | { kind: 'events'; name: string; events: readonly FixtureEvent[]; options?: FakeEventsOptions }
  | { kind: 'script'; name: string; run(ctx: FakeScriptContext): Promise<void> };

export interface FakeEventsOptions {
  /** Emit exit{code:1, expected:false} right after the event with this seq was started. */
  crashAfterSeq?: number;
  /** What happens to send() after the last input gate: diagnostics only (default) or echo turns. */
  onExhausted?: 'idle' | 'echo';
}

/** Id factories of the script mode and the DSL (random in dev, deterministic in tests). */
export interface FakeIds {
  uuid(): string;
  messageId(): string;
  toolUseId(): string;
}

export interface FakeBackendOptions {
  /** Scenario per start; n = 0-based start counter of this backend. Default: interactiveScenario(). */
  scenario?: (req: StartSessionRequest, n: number) => FakeScenario;
  /** 0 = no waiting (tests, default), 1 = recorded timing, 0.1 = 10× faster. Delays capped at maxDelayMs. */
  speed?: number;
  /** Default 3000. */
  maxDelayMs?: number;
  /** Test seam (fake timers); default setTimeout. Zero delays always use the real setImmediate. */
  sleep?: (ms: number) => Promise<void>;
  now?: () => Date;
  /** Shared between starts (resume, readHistory). */
  history?: FakeHistoryStore;
  /** Default 40000. */
  pidBase?: number;
  /**
   * Exited sessions (and start requests) kept for inspection, oldest dropped first – a long
   * `pnpm dev`/E2E run must not grow forever (R2-12). Live sessions always stay. Default 50.
   */
  keepSessions?: number;
  /** Ids of the script mode (session ids, message ids, tool use ids); default random. */
  ids?: FakeIds;
  /**
   * Phase 3 (WP-52): folder of the real files the scripts write (plan file, task output,
   * `fake:files`), one subfolder per session id. Default `%TEMP%\parallax-fake-files`.
   */
  filesRoot?: string;
  /** WP-64: Remote Control of the fake sessions (default: available, Claude setting off). */
  remoteControl?: FakeRemoteControlOptions;
  /** WP-65: title generator, usage query and background moves of the fake sessions (default: all work). */
  overview?: FakeOverviewOptions;
}

/** WP-65: levers of the fake overview methods (tests; default 'ok' each). */
export interface FakeOverviewOptions {
  /** generateTitle: 'unavailable' = the method is missing, 'failed' = the request fails. */
  titles?: 'ok' | 'unavailable' | 'failed';
  /** readUsage: 'no-plan' = no plan limits (API key), 'unavailable' / 'failed' → null. */
  usage?: 'ok' | 'no-plan' | 'unavailable' | 'failed';
  /** backgroundTasks: 'disabled' = the CLI refuses (CLAUDE_CODE_DISABLE_BACKGROUND_TASKS). */
  backgroundTasks?: 'ok' | 'disabled';
}

/** WP-64: levers of the fake Remote Control (tests; the interactive levers are prompts, remote.ts). */
export interface FakeRemoteControlOptions {
  /** Claude's `remoteControlAtStartup` as readRemoteControlDefault() answers it; default false. */
  atStartup?: boolean | null;
  /** Answer of setRemoteControl(true): 'ok' (default) or one of the failures. */
  enable?: 'ok' | 'unavailable' | 'auth' | 'policy' | 'failed';
}

export interface FakeBackend extends AgentBackend {
  readonly kind: 'fake';
  readonly starts: readonly StartSessionRequest[];
  readonly sessions: readonly FakeSessionHandle[];
  readonly history: FakeHistoryStore;
  /** Resolves when every live session waits at a gate (input/decision/control/close). */
  settle(): Promise<void>;
  /**
   * Phase 2 (WP-34, ADR-104): a turn made in the (fake) external console – one user and one
   * assistant entry with timestamp `at` appended to the fake history of `sessionId`, as the CLI
   * would write them into the transcript the engine imports on return. WP-40 calls it from the
   * fake console's `onRun`.
   */
  simulateConsoleTurn(sessionId: string, at: Date, text?: string): void;
}

export type FakeSessionState =
  'running' | 'waiting-input' | 'waiting-decision' | 'waiting-control' | 'waiting-close' | 'exited';

export type FakeDiagnosticKind =
  /** Text or priority of a sent prompt differs from the recorded input. */
  | 'input-mismatch'
  /** The engine's PermissionResult differs from the recorded decision. */
  | 'decision-mismatch'
  /** send() without a coming input gate (or while the scenario waits for close()). */
  | 'unexpected-input'
  /** interrupt() without a coming control interrupt gate. */
  | 'unexpected-interrupt'
  /** The canUseTool handler threw. */
  | 'handler-error'
  /** renameSession on a running session (C.6). */
  | 'rename-running'
  /** A fixture event could not be parsed. */
  | 'invalid-event'
  /** The scenario failed (bug in a script). */
  | 'scenario-error';

export interface FakeDiagnostic {
  kind: FakeDiagnosticKind;
  /** Fixture seq of the event, if any. */
  seq: number | null;
  message: string;
  expected?: unknown;
  actual?: unknown;
}

/** WP-64: FakeSessionHandle.remotePrompt. */
export interface FakeRemotePromptOptions {
  answer?: string;
  totalCostUsd?: number;
}

export interface FakeSessionHandle {
  readonly entryId: string;
  readonly pid: number;
  readonly scenario: string;
  readonly state: FakeSessionState;
  /** Claude session id of the latest message (null before the first one). */
  readonly sessionId: string | null;
  readonly sent: readonly OutgoingPrompt[];
  readonly controls: readonly { method: string; args: unknown[] }[];
  readonly calls: readonly { fn: string; args: unknown[] }[];
  /** Input/decision mismatches, unexpected input/control. */
  readonly diagnostics: readonly FakeDiagnostic[];
  /** Test: process dies now (exit expected:false). */
  crash(code?: number): void;
  /** Test: CLI cancels canUseTool (signal); default the oldest open request. */
  abortDecision(toolUseId?: string): void;
  /** WP-64: the connected fake bridge (null = Remote Control off). */
  readonly remoteControl: RemoteControlInfo | null;
  /** WP-64 test: emits system/bridge_state now (`failed` with failure_kind terminal also disconnects). */
  bridgeState(state: string, fields?: Record<string, unknown>): void;
  /**
   * WP-64 test: a prompt typed in the Claude app (script mode, bridge connected): its whole turn is
   * played once no other turn runs. Resolves with the foreign uuid after the turn; rejects without a bridge.
   * `answer` default "From the app: <text>"; `totalCostUsd` = the cumulative cost of its result.
   */
  remotePrompt(text: string, o?: FakeRemotePromptOptions): Promise<string>;
}

export interface FakeScriptState {
  model: string;
  permissionMode: PermissionMode;
  effort: EffortLevel | null;
  /** Phase 2: StartSessionRequest.fastMode, changed by applyFlagSettings({fastMode}); null = CLI default. */
  fastMode: boolean | null;
  turns: number;
  /**
   * V4-05 (`fake:context-high`): fixed context fill of getContextUsage and of the streamed usage
   * until `/clear` or a compaction; null = the default growth per turn.
   */
  contextTokens: number | null;
}

export interface FakeScriptContext {
  readonly req: StartSessionRequest;
  /** resumeSessionId ?? new UUID. */
  readonly sessionId: string;
  /** Changed by the control calls (setModel, setPermissionMode, applyFlagSettings). */
  readonly state: FakeScriptState;
  readonly ids: FakeIds;
  readonly history: FakeHistoryStore;
  now(): Date;
  nextInput(): Promise<OutgoingPrompt>;
  /** Throws TurnInterrupted on interrupt() (afterwards the turn signal is fresh for the epilogue). */
  emit(messages: readonly unknown[], gapMs?: number): Promise<void>;
  canUseTool(
    toolName: string,
    input: Record<string, unknown>,
    options: Record<string, unknown>,
  ): Promise<PermissionResult>;
  /** Same player as the events mode (gates included); throws TurnInterrupted like emit. */
  play(events: readonly FixtureEvent[]): Promise<void>;
  /** Aborted by interrupt() or a prompt with priority 'now' during the turn. */
  readonly turnSignal: AbortSignal;
  crash(code?: number): Promise<never>;
  /** Phase 3 (WP-52): real files of this session under the fake files root. */
  readonly files: FakeFiles;
  /**
   * Phase 3: a background task beside the turns that `stopTask(taskId)` can end at once; its
   * `run` starts when the launching turn has ended (same order at every speed).
   */
  startTask(task: FakeBackgroundTask): void;
  /** Phase 3: messages emitted on a graceful close (exit 0), right before the exit event. */
  onClose(messages: () => readonly unknown[]): void;
  /** WP-64: the connected fake bridge (null = Remote Control off). */
  readonly remoteControl: RemoteControlInfo | null;
  /** WP-64: emits system/bridge_state now (see FakeSessionHandle.bridgeState). */
  bridgeState(state: string, fields?: Record<string, unknown>): void;
  /** WP-64: the CLI aborts canUseTool (answered elsewhere); false when no request was open. */
  abortDecision(toolUseId: string): boolean;
  /** WP-64: waits `ms × speed` (≤ maxDelayMs); settle() waits for it. */
  pause(ms: number): Promise<void>;
  /**
   * WP-65: a running foreground tool use that `backgroundTasks()` may move to the background:
   * 'background' once moved, 'done' after `ms × speed` (never at speed 0); a resting point for
   * settle(); throws TurnInterrupted like emit.
   */
  foregroundTool(toolUseId: string, ms: number): Promise<'background' | 'done'>;
}

/** What a background task may do (FakeBackgroundTask.run). */
export interface FakeTaskControl {
  /** Sleeps `ms × speed` (not capped by maxDelayMs); rejects once the task was stopped or the session ended. */
  wait(ms: number): Promise<void>;
  /** Emits raw SDK messages at once (also in the middle of a turn, like the CLI's task_* frames). */
  emit(messages: readonly unknown[]): void;
  /** The task has ended (`status` as the CLI's error text shows it); stopTask then answers "not running". */
  finish(status: string): void;
  /** Plays events once no turn runs (the CLI's follow-up turn after a task notification). */
  betweenTurns(events: readonly FixtureEvent[]): Promise<void>;
}

/**
 * A background task of the script mode (Phase 3, `fake:background`). While it runs, the
 * session holds back `session_state_changed: idle` like the CLI (idle only after the
 * background agents ended, SDKSessionStateChangedMessage).
 */
export interface FakeBackgroundTask {
  readonly taskId: string;
  /** The task's life; ends quietly when `wait` rejects because the task was stopped. */
  run(control: FakeTaskControl): Promise<void>;
  /** Messages emitted at once when stopTask(taskId) ends the running task. */
  stopped(): readonly unknown[];
}
