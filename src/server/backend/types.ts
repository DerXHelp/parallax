/**
 * Port: AgentBackend (WP-13 implements SdkBackend + FakeBackend). Types only; frozen like
 * src/shared. Raw SDK messages exist only behind this port (`BackendEvent.message: unknown`);
 * the normalizer (WP-12) parses them tolerantly. Design: docs/wp/WP-02.md §9.2.
 * Ownership: this file and fixture.ts are frozen contracts; everything else in backend/ is WP-13
 * (FakeBackend scenarios without a recorded fixture as `.ts` modules in backend/fake/, R0-06).
 */
import type {
  EffortLevel,
  PermissionMode,
  PermissionResult,
  PermissionUpdate,
} from '@anthropic-ai/claude-agent-sdk';
import type { LaunchSpec } from '../claude/ports';

/** canUseTool arguments, taken over tolerantly (F.3). */
export interface PermissionRequest {
  toolName: string;
  input: Record<string, unknown>;
  toolUseId: string;
  requestId: string;
  agentId: string | null;
  suggestions: PermissionUpdate[];
  blockedPath: string | null;
  decisionReason: string | null;
  /** Untyped in the SDK. */
  decisionReasonType: string | null;
  title: string | null;
  displayName: string | null;
  description: string | null;
  defaultToNo: boolean;
  suppressAlwaysAllowRule: boolean;
  /** Untyped (AskUserQuestion/ExitPlanMode). */
  requiresUserInteraction: boolean;
  mcpServer: { name: string; source: string } | null;
  /** All option keys except `signal`, for logging / fixtures. */
  raw: Record<string, unknown>;
}

/** Resolves when the user decided; the signal aborts when the CLI cancels the request. */
export type PermissionHandler = (req: PermissionRequest, signal: AbortSignal) => Promise<PermissionResult>;

export type OutgoingContent =
  | { type: 'text'; text: string }
  | { type: 'image'; mediaType: 'image/png' | 'image/jpeg' | 'image/webp' | 'image/gif'; base64: string }
  | { type: 'document'; mediaType: 'application/pdf'; base64: string };

/** SdkBackend always sets origin {kind:'human'} and parent_tool_use_id null (F.1, WP-01). */
export interface OutgoingPrompt {
  /** MessageUuid → SDKUserMessage.uuid. */
  uuid: string;
  content: OutgoingContent[];
  priority: 'next' | 'now';
}

export interface StartSessionRequest {
  entryId: string;
  /** Exactly as stored (B). */
  cwd: string;
  launch: LaunchSpec;
  resumeSessionId: string | null;
  model: string | null;
  /** null = omit (C.3). */
  permissionMode: PermissionMode | null;
  effort: EffortLevel | null;
  promptSuggestions: boolean;
  /** Phase 2: fast mode as flag setting (`settings.fastMode`); null/absent = the CLI decides. */
  fastMode?: boolean | null;
  canUseTool: PermissionHandler;
}

export type BackendEvent =
  /** Raw SDKMessage (also untyped ones). */
  | { type: 'message'; message: unknown; at: Date }
  | { type: 'spawned'; pid: number; at: Date }
  /** F.16: the spawn wrapper reads stderr itself. */
  | { type: 'stderr'; data: string; at: Date }
  | { type: 'error'; where: 'spawn' | 'iterator' | 'control'; name: string; message: string; at: Date }
  /** Always the last event. */
  | { type: 'exit'; code: number | null; signal: string | null; expected: boolean; at: Date };

export interface AgentSession {
  readonly entryId: string;
  readonly pid: number | null;
  /** Single consumer; ends after the 'exit' event. */
  readonly events: AsyncIterable<BackendEvent>;
  /** Throws after exit. */
  send(prompt: OutgoingPrompt): void;
  interrupt(): Promise<{ stillQueued: string[] }>;
  setModel(model: string | null): Promise<void>;
  setPermissionMode(mode: PermissionMode): Promise<void>;
  applyFlagSettings(settings: { effortLevel?: EffortLevel | null; fastMode?: boolean | null }): Promise<void>;
  /** Raw → WP-12 normalizeContextUsage. */
  getContextUsage(detail: 'summary' | 'full'): Promise<unknown>;
  supportedModels(): Promise<unknown[]>;
  supportedCommands(): Promise<unknown[]>;
  stopTask(taskId: string): Promise<void>;
  /** close(), wait ≤ 5 s for exit, then taskkill /T /F (C.8). Resolves after 'exit'. */
  close(): Promise<void>;
}

/** getSessionMessages (F.15), via a worker per configDir. */
export interface HistoryMessage {
  type: 'user' | 'assistant' | 'system';
  uuid: string;
  sessionId: string;
  message: unknown;
  parentToolUseId: string | null;
  timestamp: string | null;
  /**
   * `SessionMessage.origin` (R1-07): the backend (WP-13) fills it, the history normalizer (WP-12)
   * maps it to `user_message.origin` like the live adapter. Absent/null = unknown (taken as human).
   */
  origin?: { kind: string } | null;
}

export interface BackendSessionInfo {
  sessionId: string;
  /** SDK `summary`: custom title, else AI title, else the first prompt. */
  summary: string;
  customTitle: string | null;
  /** SDK `firstPrompt` (WP-13 §6 Nr. 2): lets the engine tell an AI title from the prompt fallback. */
  firstPrompt: string | null;
  lastModified: number;
}

export interface HistoryRequest {
  sessionId: string;
  cwd: string;
  launch: LaunchSpec;
}

export interface AgentBackend {
  readonly kind: 'sdk' | 'fake';
  /** Synchronous; failures arrive as events. */
  start(req: StartSessionRequest): AgentSession;
  /**
   * getSessionMessages including subagent messages (getSubagentMessages, with
   * `parentToolUseId`), merged by time – so history items equal the live items (A.3, R0-18).
   */
  readHistory(req: HistoryRequest): Promise<HistoryMessage[]>;
  getSessionInfo(req: HistoryRequest): Promise<BackendSessionInfo | null>;
  /** Only dormant sessions (C.6). */
  renameSession(req: HistoryRequest & { title: string }): Promise<void>;
  /** Close all sessions (server shutdown). */
  dispose(): Promise<void>;
}
