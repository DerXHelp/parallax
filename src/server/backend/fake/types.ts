/**
 * Types of the FakeBackend (WP-13 §3.3). Re-exported by `backend/fakeBackend.ts` – import them
 * from there.
 */
import type { PermissionResult } from '@anthropic-ai/claude-agent-sdk';
import type { EffortLevel, PermissionMode } from '@shared/common';
import type { FixtureEvent } from '../fixture';
import type { AgentBackend, OutgoingPrompt, StartSessionRequest } from '../types';
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
}

export interface FakeBackend extends AgentBackend {
  readonly kind: 'fake';
  readonly starts: readonly StartSessionRequest[];
  readonly sessions: readonly FakeSessionHandle[];
  readonly history: FakeHistoryStore;
  /** Resolves when every live session waits at a gate (input/decision/control/close). */
  settle(): Promise<void>;
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
}

export interface FakeScriptState {
  model: string;
  permissionMode: PermissionMode;
  effort: EffortLevel | null;
  turns: number;
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
}
