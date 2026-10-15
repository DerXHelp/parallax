/**
 * Valid example objects (pure factories with shallow overrides) for tests and the playground
 * (WP-10 tests, WP-14 playground, WP-15/16 component tests). Fixed ids and timestamps – never
 * Date.now() – so snapshots stay stable. Every factory is checked against its schema in
 * samples.test.ts. Design: docs/wp/WP-02.md §14.2.
 */
import { STANDARD_PROFILE_ID } from './common';
import type {
  AssistantTextItem,
  BlobRef,
  ClaudeInstallStatus,
  ContextBreakdown,
  ContextGauge,
  Conversation,
  DecisionOutcome,
  DecisionResponse,
  Entry,
  HostState,
  ModelOption,
  PermissionDecision,
  PlanDecision,
  Profile,
  ProfileSummary,
  QueuedPrompt,
  QuestionDecision,
  RateLimitInfo,
  SessionDetail,
  SessionSummary,
  Settings,
  SystemEvent,
  SystemItem,
  ThinkingItem,
  ToolCallItem,
  TurnResultItem,
  UserMessageItem,
} from './model';
import type { ClientHelloMessage, HelloMessage, PresenceState, SessionSnapshot } from './protocol';
import { INITIAL_STATUS_FACTS, type StatusFacts } from './status';

// ---- Fixed ids and times ----

/** Deterministic id `<prefix>_<n as 32 hex>` (e.g. `en_000…01`). */
export function sampleId<P extends 'en' | 'cv' | 'dc' | 'cl' | 'pf'>(prefix: P, n = 1): `${P}_${string}` {
  return `${prefix}_${n.toString(16).padStart(32, '0')}`;
}

/** Deterministic UUID (version 4 layout) `00000000-0000-4000-8000-<n as 12 hex>`. */
export function sampleUuid(n = 1): string {
  return `00000000-0000-4000-8000-${n.toString(16).padStart(12, '0')}`;
}

/** Deterministic 64-hex blob id. */
export function sampleBlobId(n = 1): string {
  return n.toString(16).padStart(64, '0');
}

export const SAMPLE_TIME = '2026-10-15T08:00:00.000Z';

/** SAMPLE_TIME + seconds, as ISO string. */
export function sampleTime(seconds = 0): string {
  return new Date(Date.parse(SAMPLE_TIME) + seconds * 1000).toISOString();
}

export const SAMPLE_IDS = {
  entry: sampleId('en'),
  conversation: sampleId('cv'),
  decision: sampleId('dc'),
  client: sampleId('cl'),
  profile: STANDARD_PROFILE_ID,
  messageUuid: sampleUuid(1),
  cmdId: sampleUuid(100),
  serverInstanceId: sampleUuid(200),
  sessionId: '9b779de6-0000-4000-8000-000000000001',
  messageId: 'msg_01SampleMessageId',
  toolUseId: 'toolu_01SampleToolUseId',
  blob: sampleBlobId(1),
} as const;

// ---- Profiles, settings, host ----

export function sampleClaudeInstallStatus(p: Partial<ClaudeInstallStatus> = {}): ClaudeInstallStatus {
  return {
    state: 'ok',
    path: 'C:\\Users\\user\\.local\\bin\\claude.exe',
    version: '2.1.300',
    versionStatus: 'ok',
    auth: { state: 'logged_in', method: 'claude.ai', apiProvider: 'firstParty', subscriptionType: 'max' },
    error: null,
    checkedAt: sampleTime(),
    ...p,
  };
}

export function sampleProfile(p: Partial<Profile> = {}): Profile {
  return {
    id: STANDARD_PROFILE_ID,
    name: 'Standard',
    color: 'slate',
    isDefault: true,
    builtin: true,
    executable: { kind: 'auto' },
    configDir: null,
    env: {},
    contextWindow: null,
    args: [],
    passRawArgs: false,
    defaults: { model: null, permissionMode: null, effort: null },
    createdAt: sampleTime(),
    updatedAt: sampleTime(),
    ...p,
  };
}

export function sampleProfileSummary(p: Partial<ProfileSummary> = {}): ProfileSummary {
  return {
    id: STANDARD_PROFILE_ID,
    name: 'Standard',
    color: 'slate',
    isDefault: true,
    builtin: true,
    allowsBypass: false,
    claude: sampleClaudeInstallStatus(),
    ...p,
  };
}

export function sampleSettings(p: Partial<Settings> = {}): Settings {
  return { language: 'en', theme: 'dark', ...p };
}

export function sampleRateLimitInfo(p: Partial<RateLimitInfo> = {}): RateLimitInfo {
  return {
    status: 'allowed_warning',
    rateLimitType: 'five_hour',
    resetsAt: sampleTime(3600),
    utilization: 0.8,
    windows: { five_hour: { utilization: 0.8, resetsAt: sampleTime(3600) } },
    at: sampleTime(),
    ...p,
  };
}

export function sampleHostState(p: Partial<HostState> = {}): HostState {
  return {
    serverVersion: '0.0.0',
    sdkVersion: '0.3.296',
    sdkClaudeCodeVersion: '2.1.296',
    platform: 'win32',
    dataDirLabel: 'dev',
    dev: true,
    backend: 'fake',
    profiles: [sampleProfileSummary()],
    defaultProfileId: STANDARD_PROFILE_ID,
    settings: sampleSettings(),
    setupRequired: false,
    warnings: [],
    accountLimits: {},
    ...p,
  };
}

// ---- Registry ----

export function sampleConversation(p: Partial<Conversation> = {}): Conversation {
  return {
    id: SAMPLE_IDS.conversation,
    sessionId: SAMPLE_IDS.sessionId,
    startedAt: sampleTime(),
    endedAt: null,
    endReason: null,
    title: null,
    resetCorrelationId: null,
    costUsd: null,
    lastOrder: 5,
    ...p,
  };
}

export function sampleEntry(p: Partial<Entry> = {}): Entry {
  return {
    id: SAMPLE_IDS.entry,
    createdAt: sampleTime(),
    profileId: STANDARD_PROFILE_ID,
    cwd: 'D:\\work\\sample',
    title: 'Sample session',
    titleSource: 'prompt',
    pinned: false,
    archived: false,
    lastActivityAt: sampleTime(60),
    conversations: [sampleConversation()],
    modelSetting: 'haiku',
    lastModel: 'claude-haiku-5-5',
    permissionMode: 'default',
    effort: null,
    fastMode: null,
    cliVersion: '2.1.300',
    apiKeySource: 'none',
    lastRunState: 'idle',
    contextPct: 3,
    lastError: null,
    lastResultExcerpt: 'OK',
    ...p,
  };
}

// ---- Status, context ----

export function sampleStatusFacts(p: Partial<StatusFacts> = {}): StatusFacts {
  return {
    ...INITIAL_STATUS_FACTS,
    decisions: { ...INITIAL_STATUS_FACTS.decisions },
    runState: 'idle',
    ...p,
  };
}

export function sampleContextGauge(p: Partial<ContextGauge> = {}): ContextGauge {
  return {
    percentage: 3,
    totalTokens: 26_702,
    maxTokens: 1_000_000,
    source: 'sdk',
    model: 'claude-haiku-5-5',
    at: sampleTime(60),
    ...p,
  };
}

export function sampleContextBreakdown(p: Partial<ContextBreakdown> = {}): ContextBreakdown {
  return {
    ...sampleContextGauge(),
    detail: 'summary',
    categories: [
      { name: 'System prompt', tokens: 20_000, kind: 'used' },
      { name: 'Messages', tokens: 6_702, kind: 'used' },
      { name: 'Free space', tokens: 973_298, kind: 'free' },
    ],
    autoCompactThreshold: null,
    isAutoCompactEnabled: true,
    ...p,
  };
}

export function sampleSummary(p: Partial<SessionSummary> = {}): SessionSummary {
  return {
    entryId: SAMPLE_IDS.entry,
    title: 'Sample session',
    titleSource: 'prompt',
    profileId: STANDARD_PROFILE_ID,
    cwd: 'D:\\work\\sample',
    pinned: false,
    archived: false,
    createdAt: sampleTime(),
    lastActivityAt: sampleTime(60),
    status: sampleStatusFacts(),
    model: 'claude-haiku-5-5',
    modelSetting: 'haiku',
    permissionMode: 'default',
    effort: null,
    fastMode: null,
    context: sampleContextGauge(),
    sessionId: SAMPLE_IDS.sessionId,
    cliVersion: '2.1.300',
    apiKeySource: 'none',
    gitBranch: null,
    lastError: null,
    lastResultExcerpt: 'OK',
    ...p,
  };
}

// ---- Blobs ----

export function sampleBlobRef(p: Partial<BlobRef> = {}): BlobRef {
  return {
    blobId: SAMPLE_IDS.blob,
    mediaType: 'image/png',
    bytes: 1024,
    width: 32,
    height: 32,
    name: 'screenshot.png',
    ...p,
  };
}

// ---- Transcript items (one factory per kind / system event) ----

const base = (id: string, order: number) => ({ id, order, at: sampleTime(order), parentToolUseId: null });

export const sampleItems = {
  userMessage: (p: Partial<UserMessageItem> = {}): UserMessageItem => ({
    ...base(SAMPLE_IDS.messageUuid, 1),
    kind: 'user_message',
    text: { text: 'Say OK.', truncated: null },
    attachments: [],
    origin: 'human',
    slashCommand: null,
    priority: 'next',
    ...p,
  }),
  thinking: (p: Partial<ThinkingItem> = {}): ThinkingItem => ({
    ...base(`${SAMPLE_IDS.messageId}:0`, 2),
    kind: 'thinking',
    messageId: SAMPLE_IDS.messageId,
    blockIndex: 0,
    model: 'claude-haiku-5-5',
    text: { text: 'The user wants a short answer.', truncated: null },
    redacted: false,
    streaming: false,
    ...p,
  }),
  assistantText: (p: Partial<AssistantTextItem> = {}): AssistantTextItem => ({
    ...base(`${SAMPLE_IDS.messageId}:1`, 3),
    kind: 'assistant_text',
    messageId: SAMPLE_IDS.messageId,
    blockIndex: 1,
    model: 'claude-haiku-5-5',
    text: 'OK',
    streaming: false,
    aborted: false,
    localCommand: null,
    ...p,
  }),
  toolCall: (p: Partial<ToolCallItem> = {}): ToolCallItem => ({
    ...base(`${SAMPLE_IDS.messageId}:2`, 4),
    kind: 'tool_call',
    messageId: SAMPLE_IDS.messageId,
    blockIndex: 2,
    model: 'claude-haiku-5-5',
    toolUseId: SAMPLE_IDS.toolUseId,
    toolName: 'Bash',
    input: { command: 'dir', description: 'List files' },
    inputTruncated: null,
    inputPartial: null,
    status: 'done',
    result: {
      isError: false,
      content: [{ type: 'text', text: { text: 'notes.txt', truncated: null } }],
      structured: { stdout: 'notes.txt', stderr: '', interrupted: false, isImage: false },
      structuredTruncated: null,
      at: sampleTime(5),
    },
    elapsedSeconds: null,
    task: null,
    decision: null,
    ...p,
  }),
  turnResult: (p: Partial<TurnResultItem> = {}): TurnResultItem => ({
    ...base(sampleUuid(5), 5),
    kind: 'turn_result',
    outcome: 'success',
    subtype: 'success',
    terminalReason: null,
    stopReason: 'end_turn',
    durationMs: 2100,
    durationApiMs: 1900,
    numTurns: 1,
    usage: { input: 12, output: 40, cacheRead: 26_000, cacheCreation: 600 },
    costUsdTotal: 0.0021,
    costUsdTurn: 0.0021,
    permissionDenials: 0,
    errors: [],
    userMessageUuids: [SAMPLE_IDS.messageUuid],
    synthetic: false,
    ...p,
  }),
};

type SystemItemOf<E extends SystemEvent> = Extract<SystemItem, { event: E }>;
type SystemItemFactories = { [E in SystemEvent]: (p?: Partial<SystemItemOf<E>>) => SystemItemOf<E> };

const sysBase = (n: number) => ({ ...base(sampleUuid(1000 + n), 10 + n), kind: 'system' as const });
const capped = (text: string) => ({ text, truncated: null });

/** One factory per system event (the mapped type enforces completeness). */
export const sampleSystemItems: SystemItemFactories = {
  compact_boundary: (p = {}) => ({
    ...sysBase(0),
    event: 'compact_boundary',
    trigger: 'auto',
    preTokens: 160_000,
    postTokens: 30_000,
    ...p,
  }),
  api_retry: (p = {}) => ({
    ...sysBase(1),
    event: 'api_retry',
    attempt: 1,
    maxRetries: 10,
    retryDelayMs: 2000,
    errorStatus: 529,
    errorCode: 'API_OVERLOADED',
    active: true,
    ...p,
  }),
  rate_limit: (p = {}) => ({ ...sysBase(2), event: 'rate_limit', info: sampleRateLimitInfo(), ...p }),
  notification: (p = {}) => ({
    ...sysBase(3),
    event: 'notification',
    key: 'sample',
    text: 'Something happened',
    priority: 'low',
    ...p,
  }),
  informational: (p = {}) => ({
    ...sysBase(4),
    event: 'informational',
    level: 'info',
    text: capped('Hook output'),
    tag: null,
    preventContinuation: false,
    ...p,
  }),
  hook: (p = {}) => ({
    ...sysBase(5),
    event: 'hook',
    hookName: 'PreToolUse:Bash',
    hookEvent: 'PreToolUse',
    outcome: 'success',
    output: capped(''),
    ...p,
  }),
  permission_denied: (p = {}) => ({
    ...sysBase(6),
    event: 'permission_denied',
    toolName: 'Bash',
    toolUseId: SAMPLE_IDS.toolUseId,
    message: 'Denied by auto mode',
    reasonType: 'classifier',
    ...p,
  }),
  memory_recall: (p = {}) => ({
    ...sysBase(7),
    event: 'memory_recall',
    mode: 'auto',
    memories: [{ path: 'CLAUDE.md', scope: 'project', content: capped('Rules') }],
    ...p,
  }),
  local_command_output: (p = {}) => ({
    ...sysBase(8),
    event: 'local_command_output',
    text: capped('Done'),
    ...p,
  }),
  model_fallback: (p = {}) => ({
    ...sysBase(9),
    event: 'model_fallback',
    originalModel: 'claude-opus-5-5',
    fallbackModel: 'claude-sonnet-5-5',
    text: 'Switched model',
    ...p,
  }),
  interrupted: (p = {}) => ({ ...sysBase(10), event: 'interrupted', forToolUse: true, ...p }),
  conversation_reset: (p = {}) => ({ ...sysBase(11), event: 'conversation_reset', trigger: 'clear', ...p }),
  task_notification: (p = {}) => ({
    ...sysBase(12),
    event: 'task_notification',
    task: {
      taskId: 'task_01',
      taskType: 'local_bash',
      status: 'completed',
      description: 'Background command',
      subagentType: null,
      isBackgrounded: true,
      summary: 'Finished',
      usage: null,
      startedAt: sampleTime(1),
      endedAt: sampleTime(30),
    },
    ...p,
  }),
  error: (p = {}) => ({
    ...sysBase(13),
    event: 'error',
    error: { code: 'CLAUDE_AUTH_FAILED', params: { reason: 'authentication_failed' } },
    ...p,
  }),
  unknown: (p = {}) => ({
    ...sysBase(14),
    event: 'unknown',
    sdkType: 'system',
    sdkSubtype: 'brand_new',
    preview: '{"type":"system","subtype":"brand_new"}',
    ...p,
  }),
};

// ---- Decisions, responses, outcomes ----

const decisionBase = (n: number) => ({
  id: sampleId('dc', n),
  entryId: SAMPLE_IDS.entry,
  conversationId: SAMPLE_IDS.conversation,
  toolUseId: `toolu_01Decision${String(n)}`,
  requester: { kind: 'main' as const },
  createdAt: sampleTime(n),
  state: 'open' as const,
});

export const sampleDecisions = {
  permission: (p: Partial<PermissionDecision> = {}): PermissionDecision => ({
    ...decisionBase(1),
    toolName: 'Bash',
    kind: 'permission',
    input: { command: 'mkdir build', description: 'Create build folder' },
    inputTruncated: null,
    title: null,
    displayName: 'Bash',
    description: 'Create build folder',
    decisionReason: null,
    decisionReasonType: 'other',
    blockedPath: null,
    mcpServer: null,
    offer: {
      rules: [{ toolName: 'Bash', ruleContent: 'mkdir build' }],
      directories: [],
      ruleDestinations: ['session', 'localSettings', 'projectSettings', 'userSettings'],
      acceptEdits: true,
      defaultToNo: false,
    },
    ...p,
  }),
  question: (p: Partial<QuestionDecision> = {}): QuestionDecision => ({
    ...decisionBase(2),
    toolName: 'AskUserQuestion',
    kind: 'question',
    questions: [
      {
        question: 'Which color should the button be?',
        header: 'Color',
        multiSelect: false,
        options: [
          { label: 'Red', description: 'A red button', preview: null },
          { label: 'Blue', description: 'A blue button', preview: '```\nblue\n```' },
        ],
      },
    ],
    ...p,
  }),
  plan: (p: Partial<PlanDecision> = {}): PlanDecision => ({
    ...decisionBase(3),
    toolName: 'ExitPlanMode',
    kind: 'plan',
    plan: '# Plan\n\n1. Create hello.txt',
    planFilePath: 'C:\\Users\\user\\.claude\\plans\\sample.md',
    version: 1,
    previousVersionPlan: null,
    approveModes: ['default', 'acceptEdits', 'auto'],
    ...p,
  }),
};

/** One example per response variant. */
export const sampleResponses = {
  permissionAllowOnce: {
    kind: 'permission',
    response: { behavior: 'allow', remember: null, acceptEdits: false },
  },
  permissionAllowRemember: {
    kind: 'permission',
    response: { behavior: 'allow', remember: 'session', acceptEdits: true },
  },
  permissionDeny: {
    kind: 'permission',
    response: { behavior: 'deny', message: 'Not now', interrupt: false },
  },
  questionAnswer: {
    kind: 'question',
    response: {
      behavior: 'answer',
      answers: [
        { question: 'Which color should the button be?', selected: ['Blue'], otherText: null, notes: null },
      ],
    },
  },
  questionDecline: { kind: 'question', response: { behavior: 'decline', message: '' } },
  planApprove: { kind: 'plan', response: { behavior: 'approve', mode: 'acceptEdits', editedPlan: null } },
  planRevise: { kind: 'plan', response: { behavior: 'revise', feedback: 'Also add tests.' } },
  planApproveFresh: { kind: 'plan', response: { behavior: 'approve_fresh_context', mode: 'auto' } },
} satisfies Record<string, DecisionResponse>;

type OutcomeOf<T extends DecisionOutcome['type']> = Extract<DecisionOutcome, { type: T }>;

/** One example per outcome type (the mapped type enforces completeness). */
export const sampleOutcomes: { [T in DecisionOutcome['type']]: OutcomeOf<T> } = {
  allowed: { type: 'allowed', remember: 'localSettings', acceptEdits: false },
  denied: { type: 'denied', withMessage: true, interrupt: false },
  answered: { type: 'answered' },
  declined: { type: 'declined' },
  plan_approved: { type: 'plan_approved', mode: 'acceptEdits', edited: true },
  plan_revised: { type: 'plan_revised' },
  cancelled: { type: 'cancelled', reason: 'signal_aborted' },
  expired: { type: 'expired' },
};

// ---- Session detail, snapshot, handshake ----

export function sampleModelOption(p: Partial<ModelOption> = {}): ModelOption {
  return {
    value: 'haiku',
    displayName: 'Haiku',
    description: 'Fast',
    supportsEffort: true,
    supportedEffortLevels: ['low', 'medium', 'high'],
    supportsFastMode: false,
    supportsAutoMode: true,
    ...p,
  };
}

export function sampleQueuedPrompt(p: Partial<QueuedPrompt> = {}): QueuedPrompt {
  return {
    messageUuid: sampleUuid(2),
    text: { text: 'And now the tests.', truncated: null },
    attachments: [],
    priority: 'next',
    state: 'queued',
    queuedAt: sampleTime(10),
    ...p,
  };
}

export function sampleDetail(p: Partial<SessionDetail> = {}): SessionDetail {
  return {
    entryId: SAMPLE_IDS.entry,
    conversationId: SAMPLE_IDS.conversation,
    conversations: [sampleConversation()],
    init: {
      sessionId: SAMPLE_IDS.sessionId,
      cwd: 'D:\\work\\sample',
      model: 'claude-haiku-5-5',
      permissionMode: 'default',
      apiKeySource: 'none',
      cliVersion: '2.1.300',
      tools: ['Bash', 'PowerShell', 'Read', 'Write', 'Edit', 'AskUserQuestion', 'ExitPlanMode', 'Agent'],
      slashCommands: ['clear', 'rename', 'compact'],
      terminalSlashCommands: [],
      mcpServers: [],
      skills: [],
      agents: ['general-purpose'],
      plugins: [],
      capabilities: ['msg_lifecycle_v1'],
      outputStyle: 'default',
      fastModeState: null,
      effort: null,
    },
    models: [sampleModelOption()],
    commands: null,
    queue: [],
    backgroundTasks: [],
    promptSuggestion: null,
    rateLimit: null,
    unknownCounts: {},
    ...p,
  };
}

export function sampleSessionSnapshot(p: Partial<SessionSnapshot> = {}): SessionSnapshot {
  return {
    type: 'session.snapshot',
    entryId: SAMPLE_IDS.entry,
    seq: 5,
    items: [
      sampleItems.userMessage(),
      sampleItems.thinking(),
      sampleItems.assistantText(),
      sampleItems.toolCall(),
      sampleItems.turnResult(),
    ],
    hasEarlier: false,
    decisions: [],
    detail: sampleDetail(),
    ...p,
  };
}

export function samplePresence(p: Partial<PresenceState> = {}): PresenceState {
  return { focused: true, visible: true, viewingEntryId: SAMPLE_IDS.entry, typing: false, ...p };
}

export function sampleHello(p: Partial<HelloMessage> = {}): HelloMessage {
  return {
    type: 'hello',
    protocolVersion: 1,
    buildId: 'dev',
    serverInstanceId: SAMPLE_IDS.serverInstanceId,
    serverVersion: '0.0.0',
    serverStartedAt: sampleTime(),
    ...p,
  };
}

export function sampleClientHello(p: Partial<ClientHelloMessage> = {}): ClientHelloMessage {
  return {
    type: 'clientHello',
    protocolVersion: 1,
    buildId: 'dev',
    clientId: SAMPLE_IDS.client,
    presence: samplePresence(),
    ...p,
  };
}
