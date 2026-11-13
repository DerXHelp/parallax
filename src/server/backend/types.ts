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
import type { ErrorPayload } from '@shared/errors';
import type { McpAction, ReloadTarget, SessionInfoSection, SessionInfoSectionName } from '@shared/model';
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
  /** `title`: the attachment's file name (Phase 3, WP-51 follow-up) → `DocumentBlockParam.title`. */
  | { type: 'document'; mediaType: 'application/pdf'; base64: string; title?: string };

/** SdkBackend always sets origin {kind:'human'} and parent_tool_use_id null (F.1, WP-01). */
export interface OutgoingPrompt {
  /** MessageUuid → SDKUserMessage.uuid. */
  uuid: string;
  content: OutgoingContent[];
  priority: 'next' | 'now';
  /** Phase 3 (ADR-146): pasted texts that occur verbatim in the text content → SDKUserMessage.inline_pastes. */
  inlinePastes?: string[];
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
  /** Phase 3 (ADR-146, C.11): attachment folder of the entry, appended to additionalDirectories. */
  attachmentsDir?: string | null;
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

/**
 * WP-64 (Remote Control): answer of `query.enableRemoteControl(true)` (SDK 0.3.322, internal), already
 * checked. `sessionUrl` is null when the CLI sent no https://claude.ai link.
 */
export interface RemoteControlInfo {
  bridgeSessionId: string;
  sessionUrl: string | null;
}

export interface RemoteControlRequest {
  /** Name of the remote session in the Claude app (Parallax title); null = the CLI decides. */
  name: string | null;
  /** Bridge session of the current conversation (`cse_…`) to reconnect to; null = new one. */
  reattachSessionId: string | null;
}

/**
 * Never rejects. Failures: REMOTE_CONTROL_UNAVAILABLE (method missing in SDK/CLI, unknown answer),
 * REMOTE_CONTROL_AUTH, REMOTE_CONTROL_POLICY_DISABLED, REMOTE_CONTROL_FAILED {reason, detail?}.
 * Disabling answers `info: null`.
 */
export type RemoteControlResult = { ok: true; info: RemoteControlInfo | null } | { ok: false; error: ErrorPayload };

/**
 * WP-65: answer of `query.generateSessionTitle(description, { persist })` (SDK 0.3.322, internal).
 * Never rejects: `unavailable` = the method is missing in SDK/CLI, `failed` = the request failed or
 * timed out; `title: null` = the CLI found no usable title. With `persist` the CLI writes an
 * `ai-title` into its transcript – and answers a title the session already has without a new one.
 */
export type TitleResult = { ok: true; title: string | null } | { ok: false; reason: 'unavailable' | 'failed' };

/** WP-65: one plan window of the usage query; `utilization` as a FRACTION 0–1 (like rate_limit_event). */
export interface UsageWindow {
  utilization: number;
  resetsAt: string | null;
}

/**
 * WP-65: the plan limits of `usage_EXPERIMENTAL_MAY_CHANGE_DO_NOT_RELY_ON_THIS_API_YET()` (checked,
 * normalized): only windows with a value (`five_hour`, `seven_day`, … ; codename windows without a
 * value are dropped; extra usage as `overage`); `cleared` = known windows the answer reports empty
 * (their stored value is history). No session cost, no line counts.
 */
export interface UsageLimits {
  windows: Record<string, UsageWindow>;
  cleared: string[];
}

/** WP-66: one answered question of a side-question thread (`history`, oldest first). */
export interface SideQuestionTurn {
  question: string;
  response: string;
}

/** WP-66: the answer of `query.askSideQuestion` (checked); `fallbackModel` = `refusalFallback.fallbackModel`. */
export interface SideQuestionAnswer {
  response: string;
  synthetic: boolean;
  fallbackModel: string | null;
}

/**
 * WP-66: result of a side question; never rejects. `answer: null` = the CLI could not answer (no
 * conversation state yet). Failures: `unavailable` (method missing in SDK/CLI, unknown answer shape),
 * `busy` (`side_question_busy`: the CLI already runs as many side questions/title requests as it
 * may), `cancelled` (the signal aborted), `failed` (anything else, also a closed session).
 */
export type SideQuestionResult =
  | { ok: true; answer: SideQuestionAnswer | null }
  | { ok: false; reason: 'unavailable' | 'busy' | 'cancelled' | 'failed' };

export interface SideQuestionOptions {
  history: readonly SideQuestionTurn[];
  signal: AbortSignal;
  /**
   * `system/control_request_progress api_retry` while this is the only open side question of the
   * process (the CLI's request_id is unknown to the caller, so nothing is attributed otherwise).
   */
  onRetry?: (retry: { attempt: number; maxRetries: number }) => void;
}

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
  /**
   * WP-64: switches Remote Control (always with keepSessionOnExit, so a close or server restart keeps
   * the bridge for a reattach). The live state arrives as system/bridge_state messages.
   */
  setRemoteControl(enabled: boolean, req: RemoteControlRequest): Promise<RemoteControlResult>;
  /**
   * WP-64: Claude's own setting `remoteControlAtStartup` (getSettings().effective); null when unknown
   * (method missing, not set, unreadable). Never rejects.
   */
  readRemoteControlDefault(): Promise<boolean | null>;
  /** WP-65: AI title for `description` (internal SDK method, checked at runtime). Never rejects. */
  generateTitle(description: string, opts: { persist: boolean }): Promise<TitleResult>;
  /**
   * WP-65: `backgroundTasks(toolUseId?)` – null = every foreground task (Ctrl+B). Resolves false
   * when a given tool use matched no foreground task; rejects when the request failed (also when
   * the CLI disabled background tasks or the method is missing).
   */
  backgroundTasks(toolUseId: string | null): Promise<boolean>;
  /**
   * WP-65: plan limits of the experimental usage query (`skipBehaviors`: no transcript scan); null
   * when unavailable (method missing, failed, unknown shape, no plan limits – API key). Never rejects.
   */
  readUsage(): Promise<UsageLimits | null>;
  /**
   * WP-66: side question (`query.askSideQuestion`, internal, checked at runtime) – forks the current
   * conversation state (also mid-turn), no tools, nothing written to the conversation. Never rejects.
   */
  askSideQuestion(question: string, opts: SideQuestionOptions): Promise<SideQuestionResult>;
  /**
   * WP-66: `query.cancelAsyncMessage(uuid)` (internal, checked at runtime): true = removed from the
   * CLI's queue (a `command_lifecycle cancelled` follows); false = not in the queue (already taken
   * over, or held before it – the CLI then marks it cancelled). Rejects when the request failed or
   * the method is missing.
   */
  withdrawQueued(messageUuid: string): Promise<boolean>;
  /**
   * WP-67: the data of one "Session info" tab, normalized and checked (backend/sessionInfo.ts):
   * status/memory/skills/hooks/permissions/export through internal SDK methods (checked at
   * runtime), mcp through `mcpServerStatus()`. Resolves null when this CLI cannot answer it (method
   * missing in SDK/CLI, unknown answer shape, a CLI that does not know the request); rejects when
   * the request failed (timeout, CLI error, session closed). Never logs the answer (account rows).
   */
  readInfo(section: SessionInfoSectionName): Promise<SessionInfoSection | null>;
  /** WP-67: `reconnectMcpServer(name)` / `toggleMcpServer(name, enabled)`; rejects when it failed. */
  mcpAction(server: string, action: McpAction): Promise<void>;
  /** WP-67: `reloadSkills()` / `reloadPlugins()`; rejects when it failed. */
  reload(what: ReloadTarget): Promise<void>;
  /**
   * WP-70: the project's output styles from `initializationResult()` (`output_style`,
   * `available_output_styles`; never `account`). Resolves null when unknown (method missing,
   * unknown shape, failed). Never rejects.
   */
  readOutputStyles(): Promise<OutputStyles | null>;
  /**
   * WP-70: `updateSettings('localSettings', { outputStyle })` – `<cwd>\.claude\settings.local.json`
   * of the session's project, effective from the next turn. Never rejects: CLAUDE_CONTROL_FAILED
   * {method:'updateSettings'} when the method is missing or the request failed.
   */
  setOutputStyle(style: string): Promise<{ ok: true } | { ok: false; error: ErrorPayload }>;
  /** close(), wait ≤ 5 s for exit, then taskkill /T /F (C.8). Resolves after 'exit'. */
  close(): Promise<void>;
}

/** WP-70: output styles of a project (`initializationResult`). */
export interface OutputStyles {
  /** `output_style` (null = not reported). */
  current: string | null;
  /** `available_output_styles` (names; empty = not reported). */
  available: string[];
}

/** WP-70: a login process of one profile (no prompt, no transcript, neutral cwd). */
export interface LoginRequest {
  /** The profile's launch spec (env through buildEnv, config dir); no entry id in the env. */
  launch: LaunchSpec;
  /** Neutral working directory in the Parallax home (exists). */
  cwd: string;
}

/**
 * WP-70: answer of `claudeAuthenticate(true)` (internal): the links of the CLI's OAuth flow – the
 * CLI never opens a browser itself. `automaticUrl` only when the CLI listens on localhost for the
 * redirect (finishes without a code). Failures: LOGIN_UNAVAILABLE (method missing / unknown answer),
 * LOGIN_BLOCKED (managed settings), LOGIN_FAILED {reason}.
 */
export type LoginStartResult =
  | { ok: true; manualUrl: string; automaticUrl: string | null }
  | { ok: false; error: ErrorPayload };

/**
 * WP-70: end of the flow (`claudeOAuthCallback` / `claudeOAuthWaitForCompletion`): only the plan
 * (`account.subscriptionType`) – never e-mail or organization. Failures: LOGIN_UNAVAILABLE,
 * LOGIN_BLOCKED, LOGIN_FAILED {reason: 'expired' | 'code' | 'process' | 'failed'}.
 */
export type LoginResult = { ok: true; subscriptionType: string | null } | { ok: false; error: ErrorPayload };

/** WP-70: the short-lived login process. All methods never reject; the CLI's text is never logged. */
export interface LoginSession {
  readonly pid: number | null;
  /** Starts (or joins, within 10 min) the OAuth flow. */
  authenticate(): Promise<LoginStartResult>;
  /** The pasted code of the manual way; resolves when the CLI finished the flow with it. */
  submitCode(code: string, state: string): Promise<LoginResult>;
  /** Resolves when the flow ends (redirect to localhost, a submitted code, or a failure). */
  waitForCompletion(): Promise<LoginResult>;
  /** Resolves when the process has exited (also after close). */
  readonly exited: Promise<void>;
  /** close(), wait ≤ 5 s for exit, then taskkill /T /F. Resolves after exit. */
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

/**
 * WP-69: one subagent's transcript (`getSubagentMessages(sessionId, agentId)`, the CLI's
 * `agent-<agentId>.jsonl`) from message index `from` on – the engine keeps what it read before, so
 * a poll transfers only the new messages.
 */
export interface SubagentHistoryRequest extends HistoryRequest {
  /** Checked like `subagentIdSchema` (no path characters). */
  agentId: string;
  from: number;
}

export interface SubagentHistorySlice {
  /** Messages of the whole transcript now (0 = no file, or nothing in it yet). */
  total: number;
  /** uuid of message `from - 1` (null for `from` 0) – the engine checks its cache with it. */
  previousUuid: string | null;
  /** uuid of message `total - 1` (null without messages) – what the next read's `previousUuid` must be. */
  lastUuid: string | null;
  /** Messages `from … total-1`, in order. */
  messages: HistoryMessage[];
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
  /**
   * WP-69: a subagent's own transcript from message `from` on (file only, no process needed; the
   * profile's config dir like `readHistory`). A missing file is `total: 0`; rejects when the read
   * failed or timed out.
   */
  readSubagentHistory(req: SubagentHistoryRequest): Promise<SubagentHistorySlice>;
  /** Only dormant sessions (C.6). */
  renameSession(req: HistoryRequest & { title: string }): Promise<void>;
  /** WP-70: a login process of a profile (synchronous; failures arrive as results). */
  startLogin(req: LoginRequest): LoginSession;
  /** Close all sessions (server shutdown). */
  dispose(): Promise<void>;
}
