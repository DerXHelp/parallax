/**
 * Data model shared by server and web: profiles, settings, registry entries, transcript items,
 * decisions, context/rate limits, host state, session summary and detail.
 * Design (normative): docs/wp/WP-02.md §5. Persisted schemas: new fields always with a default
 * (old files load without migration); otherwise bump the schema version (§13).
 */
import { z } from 'zod';
import {
  LIMITS,
  blobIdSchema,
  claudeSessionIdSchema,
  conversationIdSchema,
  decisionIdSchema,
  decisionKindSchema,
  effortLevelSchema,
  entryIdSchema,
  isoDateTimeSchema,
  itemIdSchema,
  jsonValueSchema,
  languageSchema,
  messageUuidSchema,
  modelNameSchema,
  permissionModeSchema,
  profileIdSchema,
  promptPrioritySchema,
  ruleDestinationSchema,
  themeSchema,
} from './common';
import { errorCodeSchema, errorInfoSchema, errorPayloadSchema } from './errors';
import { runStateSchema, statusFactsSchema, turnOutcomeSchema, type NotificationKind } from './status';

export { turnInfoSchema, type TurnInfo } from './status';

// =====================================================================================
// 5.1 Profile colors / executable
// =====================================================================================

/** CSS token `--profile-<color>` (WP-14). */
export const PROFILE_COLORS = ['slate', 'blue', 'green', 'amber', 'red', 'violet', 'pink', 'teal'] as const;
export const profileColorSchema = z.enum(PROFILE_COLORS);
export type ProfileColor = z.infer<typeof profileColorSchema>;

export const profileExecutableSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('auto') }),
  z.object({ kind: z.literal('path'), path: z.string().min(1) }),
]);
export type ProfileExecutable = z.infer<typeof profileExecutableSchema>;

// =====================================================================================
// 5.8 Context and rate limits (C.1, C.5, F.12, F.13)
// =====================================================================================

export const contextGaugeSchema = z.object({
  /** 0–100+, rounded. */
  percentage: z.number().nonnegative(),
  totalTokens: z.number().int().nonnegative(),
  /** rawMaxTokens or the profile's contextWindow. */
  maxTokens: z.number().int().positive(),
  /** 'sdk' = getContextUsage after the turn; 'estimate' = during the turn from usage (C.1). */
  source: z.enum(['sdk', 'estimate']),
  model: z.string().nullable(),
  at: isoDateTimeSchema,
});
export type ContextGauge = z.infer<typeof contextGaugeSchema>;

/** Click on the gauge (getContextUsage). */
export const contextBreakdownSchema = contextGaugeSchema.extend({
  detail: z.enum(['summary', 'full']),
  categories: z.array(
    z.object({ name: z.string(), tokens: z.number(), kind: z.enum(['used', 'free', 'buffer', 'deferred']) }),
  ),
  /** Token count (not a percentage) at which the CLI compacts automatically (fixtures: 967 000). */
  autoCompactThreshold: z.number().nullable(),
  isAutoCompactEnabled: z.boolean().nullable(),
});
export type ContextBreakdown = z.infer<typeof contextBreakdownSchema>;

export const rateLimitInfoSchema = z.object({
  status: z.enum(['allowed', 'allowed_warning', 'rejected']),
  /** five_hour, seven_day … (open set). */
  rateLimitType: z.string().nullable(),
  /** The SDK sends seconds → ISO. */
  resetsAt: isoDateTimeSchema.nullable(),
  utilization: z.number().nullable(),
  /** Untyped `unifiedWindows` (F.13) for the subscription limit display (Phase 2). */
  windows: z
    .record(
      z.string(),
      z.object({ utilization: z.number().nullable(), resetsAt: isoDateTimeSchema.nullable() }),
    )
    .default({}),
  at: isoDateTimeSchema,
});
export type RateLimitInfo = z.infer<typeof rateLimitInfoSchema>;

// =====================================================================================
// 5.9 Claude install status (setup screen C.5 / B "First-Run", version rule C.7)
// =====================================================================================

export const claudeInstallStatusSchema = z.object({
  state: z.enum(['checking', 'ok', 'not_found', 'error']),
  path: z.string().nullable(),
  /** `claude --version`. */
  version: z.string().nullable(),
  /** C.7: 'too_old' (red) if the CLI is older than the SDK's package.json#claudeCodeVersion. */
  versionStatus: z.enum(['ok', 'too_old', 'unknown']),
  auth: z.object({
    state: z.enum(['unknown', 'logged_in', 'logged_out', 'error']),
    /** auth status: authMethod ('claude.ai' …). */
    method: z.string().nullable(),
    /** 'firstParty' … */
    apiProvider: z.string().nullable(),
    /** 'max' …; never e-mail/org (F.17). */
    subscriptionType: z.string().nullable(),
  }),
  error: errorPayloadSchema.nullable(),
  checkedAt: isoDateTimeSchema.nullable(),
});
export type ClaudeInstallStatus = z.infer<typeof claudeInstallStatusSchema>;

// =====================================================================================
// 5.1 Profiles (Plan "Claude-Profile", C.3, C.12; Phase 1 only "Standard")
// =====================================================================================

export const profileSchema = z.object({
  id: profileIdSchema,
  name: z.string().min(1).max(60),
  color: profileColorSchema.default('slate'),
  isDefault: z.boolean().default(false),
  /** 'standard': cannot be deleted. */
  builtin: z.boolean().default(false),
  executable: profileExecutableSchema.default({ kind: 'auto' }),
  /** → CLAUDE_CONFIG_DIR. */
  configDir: z.string().min(1).nullable().default(null),
  /** Plain text, `${env:NAME}` allowed. */
  env: z.record(z.string().min(1), z.string()).default({}),
  /** C.1 override of the context window (100k–1M). */
  contextWindow: z.number().int().min(100_000).max(1_000_000).nullable().default(null),
  /** One argument per entry, unquoted. Bypass flags are mapped by WP-11 parseProfileArgs (C.3). */
  args: z.array(z.string()).default([]),
  /** C.12 "roh durchreichen". */
  passRawArgs: z.boolean().default(false),
  defaults: z
    .object({
      model: z.string().min(1).nullable().default(null),
      /** null = omit (C.3). */
      permissionMode: permissionModeSchema.nullable().default(null),
      effort: effortLevelSchema.nullable().default(null),
    })
    .default({ model: null, permissionMode: null, effort: null }),
  createdAt: isoDateTimeSchema,
  updatedAt: isoDateTimeSchema,
});
export type Profile = z.infer<typeof profileSchema>;

export const PROFILES_SCHEMA_VERSION = 1;
/**
 * `profiles.json` (Phase 2, ADR-102): all profiles incl. "Standard"; a missing file means only the
 * built-in profile from code (written on the first save).
 */
export const profilesFileSchema = z.object({
  schemaVersion: z.literal(PROFILES_SCHEMA_VERSION),
  profiles: z.array(profileSchema),
});
export type ProfilesFile = z.infer<typeof profilesFileSchema>;

/** Strict form of `profileSchema.defaults` (profile input, summaries; Phase 2). */
export const profileDefaultsSchema = z.object({
  model: modelNameSchema.nullable(),
  permissionMode: permissionModeSchema.nullable(),
  effort: effortLevelSchema.nullable(),
});
export type ProfileDefaults = z.infer<typeof profileDefaultsSchema>;

/**
 * `profile.save` / `profile.validate` (Phase 2, ADR-102). `id` absent = new profile (the server
 * assigns `pf_…`); `standard` = the built-in profile (editable, never deletable). `isDefault` is
 * set only through `profile.setDefault`; `createdAt`/`updatedAt`/`builtin` come from the server.
 */
export const profileInputSchema = z.object({
  id: profileIdSchema.optional(),
  name: z.string().trim().min(1).max(60),
  color: profileColorSchema,
  /** `path`: absolute `.exe`, checked by the server (PROFILE_INVALID {field:'executable', reason}). */
  executable: profileExecutableSchema,
  configDir: z.string().min(1).max(LIMITS.pathChars).nullable(),
  env: z
    .record(
      z
        .string()
        .min(1)
        .max(LIMITS.profileEnvKeyChars)
        .regex(/^[^=\s][^=]*$/),
      z.string().max(LIMITS.profileEnvValueChars),
    )
    .refine((env) => Object.keys(env).length <= LIMITS.profileEnvMax, { message: 'too many variables' }),
  contextWindow: z.number().int().min(100_000).max(1_000_000).nullable(),
  args: z.array(z.string().max(LIMITS.profileArgChars)).max(LIMITS.profileArgsMax),
  passRawArgs: z.boolean(),
  defaults: profileDefaultsSchema,
});
export type ProfileInput = z.infer<typeof profileInputSchema>;

/**
 * One finding of the profile check (Phase 2, ADR-102). The server decides `level`: 'error' blocks
 * save, start and becoming default (args blocked/not allowed/invalid, PROFILE_INVALID {field,
 * reason} for executable/configDir); 'warning' (broad allowedTools, bypass, resume-no-effect,
 * PROFILE_ENV_REF_UNRESOLVED); 'info' (PROFILE_ARG_PASSED_RAW). Arg findings carry
 * ProfileArgIssueParams (`index` = line in the editor).
 */
export const profileIssueSchema = z.object({
  level: z.enum(['error', 'warning', 'info']),
  issue: errorPayloadSchema,
});
export type ProfileIssue = z.infer<typeof profileIssueSchema>;

/** What the UI sees (never env values, never args): HostState.profiles. */
export const profileSummarySchema = z.object({
  id: profileIdSchema,
  name: z.string(),
  color: profileColorSchema,
  isDefault: z.boolean(),
  builtin: z.boolean(),
  /** Derived from args (WP-11 parseProfileArgs), C.3. */
  allowsBypass: z.boolean(),
  claude: claudeInstallStatusSchema,
  /** Phase 2: pre-selection shown in the "New session" dialog (no secrets). */
  defaults: profileDefaultsSchema.default({ model: null, permissionMode: null, effort: null }),
  /** Phase 2: → CLAUDE_CONFIG_DIR (display; configDir warning). Not secret. */
  configDir: z.string().nullable().default(null),
  /** Phase 2: findings of the profile check (ADR-102). */
  issues: z.array(profileIssueSchema).default([]),
  /** Phase 2: entries bound to the profile, archived ones included (delete protection, configDir warning). */
  entryCount: z.number().int().nonnegative().default(0),
});
export type ProfileSummary = z.infer<typeof profileSummarySchema>;

// =====================================================================================
// 5.2 Settings (`settings.json`)
// =====================================================================================

export const SETTINGS_SCHEMA_VERSION = 1;

// ---- Phase 2: notifications (ADR-109), idle sleep (ADR-105), port (ADR-111), autostart (ADR-110) ----

/** Sounds the client synthesizes with Web Audio (no files, nothing from the network). */
export const SOUND_IDS = ['chime', 'ping', 'pop', 'bell', 'alert'] as const;
export const soundIdSchema = z.enum(SOUND_IDS);
export type SoundId = z.infer<typeof soundIdSchema>;

export const notificationEventSchema = z.object({
  /** OS notification (Web Notification or native toast). false = in-app hint only. */
  toast: z.boolean(),
  /** Client sound (Web Audio). */
  sound: z.boolean(),
  soundId: soundIdSchema,
});
export type NotificationEventSettings = z.infer<typeof notificationEventSchema>;

/** Defaults per event (Plan "Benachrichtigungen"). */
export const DEFAULT_NOTIFICATION_EVENTS = {
  permission: { toast: true, sound: true, soundId: 'chime' },
  question: { toast: true, sound: true, soundId: 'chime' },
  plan: { toast: true, sound: true, soundId: 'bell' },
  done: { toast: true, sound: true, soundId: 'pop' },
  error: { toast: true, sound: true, soundId: 'alert' },
  rate_limit: { toast: true, sound: false, soundId: 'alert' },
} as const satisfies Record<NotificationKind, NotificationEventSettings>;

/** Strict form (settings.update replaces `notifications` as a whole – no partial nested patch). */
const notificationSettingsFields = {
  events: z.object({
    permission: notificationEventSchema,
    question: notificationEventSchema,
    plan: notificationEventSchema,
    done: notificationEventSchema,
    error: notificationEventSchema,
    rate_limit: notificationEventSchema,
  }),
  /** 0–1, gain of the client sounds. */
  volume: z.number().min(0).max(1),
  /** No OS notifications (web or native) and no sounds; in-app hints and "(n)" in the title stay. */
  doNotDisturb: z.boolean(),
  /** A focused, visible window shows ANOTHER session: 'in_app' hint there (A.9 default) or 'system'. */
  focusedElsewhere: z.enum(['in_app', 'system']),
  /** "Done" for a focused window only after turns of at least this many seconds (B: 20–30 s). */
  doneMinSeconds: z.number().int().min(0).max(600),
  /** HKCU protocol handler `parallax:` – a click on a native toast opens the session (A.9, opt-in). */
  openOnClick: z.boolean(),
};
export const notificationSettingsPatchSchema = z.object(notificationSettingsFields);

export const DEFAULT_NOTIFICATION_SETTINGS = {
  events: DEFAULT_NOTIFICATION_EVENTS,
  volume: 0.6,
  doNotDisturb: false,
  focusedElsewhere: 'in_app',
  doneMinSeconds: 20,
  openOnClick: false,
} as const satisfies z.infer<typeof notificationSettingsPatchSchema>;

/** Persisted form: every field with a default (a missing field loads without migration). */
export const notificationSettingsSchema = z.object({
  events: z
    .object({
      permission: notificationEventSchema.default(DEFAULT_NOTIFICATION_EVENTS.permission),
      question: notificationEventSchema.default(DEFAULT_NOTIFICATION_EVENTS.question),
      plan: notificationEventSchema.default(DEFAULT_NOTIFICATION_EVENTS.plan),
      done: notificationEventSchema.default(DEFAULT_NOTIFICATION_EVENTS.done),
      error: notificationEventSchema.default(DEFAULT_NOTIFICATION_EVENTS.error),
      rate_limit: notificationEventSchema.default(DEFAULT_NOTIFICATION_EVENTS.rate_limit),
    })
    .default(DEFAULT_NOTIFICATION_EVENTS),
  volume: notificationSettingsFields.volume.default(DEFAULT_NOTIFICATION_SETTINGS.volume),
  doNotDisturb: z.boolean().default(false),
  focusedElsewhere: notificationSettingsFields.focusedElsewhere.default('in_app'),
  doneMinSeconds: notificationSettingsFields.doneMinSeconds.default(
    DEFAULT_NOTIFICATION_SETTINGS.doneMinSeconds,
  ),
  openOnClick: z.boolean().default(false),
});
export type NotificationSettings = z.infer<typeof notificationSettingsSchema>;

/** Leerlauf-Schlaf (ADR-105): the engine closes an idle process after `minutes` (canSleep rules). */
export const idleSleepSchema = z.object({
  enabled: z.boolean(),
  minutes: z.number().int().min(5).max(1440),
});
export const DEFAULT_IDLE_SLEEP = { enabled: true, minutes: 30 } as const satisfies z.infer<
  typeof idleSleepSchema
>;

/** Autostart shortcut (ADR-110; only on the productive server, HostState.systemIntegration). */
export const autostartSchema = z.object({
  enabled: z.boolean(),
  /** At logon also open an app window (else only the server; native toasts still work). */
  openWindow: z.boolean(),
});
export const DEFAULT_AUTOSTART = { enabled: false, openWindow: true } as const satisfies z.infer<
  typeof autostartSchema
>;

/** Port of the productive server without flag, env or setting (ADR-111; server and settings page). */
export const DEFAULT_PORT = 4711;

/** null = `DEFAULT_PORT`; takes effect after a server restart (ADR-111). */
export const portSettingSchema = z.number().int().min(1024).max(65535).nullable();

/** Fields without defaults: the base of the patch schema (a patch must never inject defaults). */
const settingsFields = {
  language: languageSchema,
  theme: themeSchema,
  notifications: notificationSettingsPatchSchema,
  idleSleep: idleSleepSchema,
  /** SDK `promptSuggestions` (one extra request per turn, B; ADR-117) – from the next process start. */
  promptSuggestions: z.boolean(),
  port: portSettingSchema,
  autostart: autostartSchema,
};

export const settingsSchema = z.object({
  language: settingsFields.language.default('en'),
  theme: settingsFields.theme.default('dark'),
  notifications: notificationSettingsSchema.default(DEFAULT_NOTIFICATION_SETTINGS),
  idleSleep: idleSleepSchema.default(DEFAULT_IDLE_SLEEP),
  promptSuggestions: z.boolean().default(false),
  port: portSettingSchema.default(null),
  autostart: autostartSchema.default(DEFAULT_AUTOSTART),
});
export type Settings = z.infer<typeof settingsSchema>;

/**
 * `settings.update` patch: only the given TOP-LEVEL fields change, each replaced as a whole (nested
 * objects too, no defaults applied).
 */
export const settingsPatchSchema = z.object(settingsFields).partial();
export type SettingsPatch = z.infer<typeof settingsPatchSchema>;

export const settingsFileSchema = z.object({
  schemaVersion: z.literal(SETTINGS_SCHEMA_VERSION),
  settings: settingsSchema,
});
export type SettingsFile = z.infer<typeof settingsFileSchema>;

// =====================================================================================
// 5.9 Host state
// =====================================================================================

export const hostWarningSchema = z.object({
  id: z.string(),
  error: errorPayloadSchema,
  at: isoDateTimeSchema,
});
export type HostWarning = z.infer<typeof hostWarningSchema>;

export const hostStateSchema = z.object({
  /** package.json version. */
  serverVersion: z.string(),
  /** 0.3.296 */
  sdkVersion: z.string(),
  /** Minimum CLI according to the SDK manifest. */
  sdkClaudeCodeVersion: z.string(),
  /** 'win32' */
  platform: z.string(),
  /** Display only, e.g. '%LOCALAPPDATA%\\Parallax' or 'dev'. */
  dataDirLabel: z.string(),
  dev: z.boolean(),
  backend: z.enum(['sdk', 'fake']),
  profiles: z.array(profileSummarySchema).min(1),
  defaultProfileId: profileIdSchema,
  settings: settingsSchema,
  /** True when the default profile cannot run sessions (claude missing / not logged in) → setup screen. */
  setupRequired: z.boolean(),
  /** E.g. STORE_CORRUPT_QUARANTINED. */
  warnings: z.array(hostWarningSchema).default([]),
  /** Last rate-limit info per profile (subscription display, Phase 2). */
  accountLimits: z.record(z.string(), rateLimitInfoSchema).default({}),
  /**
   * WP22-03/-15 (additive, default false): the server shows native Windows toasts (PowerShell
   * helper, Plan A.9) when no window is open or the target window cannot show Web Notifications –
   * the client then needs no "Enable notifications" hint.
   */
  nativeNotifications: z.boolean().default(false),
  /** Phase 2: actual listening port (null before listen); `settings.port` takes effect after a restart. */
  port: z.number().int().min(0).max(65535).nullable().default(null),
  /**
   * Phase 2 (ADR-110): autostart and the protocol handler are available – only the productive
   * server (default data directory, SDK backend, not --dev; `--system-integration=on` forces it).
   * The UI disables both otherwise.
   */
  systemIntegration: z.boolean().default(false),
});
export type HostState = z.infer<typeof hostStateSchema>;

// =====================================================================================
// 5.3 Conversations and entries (Plan "Registry", B "Persistenz", F.7)
// =====================================================================================

export const conversationEndReasonSchema = z.enum([
  'clear',
  'plan_mode_exit',
  'fresh_session',
  'onboarding',
  'fork',
  'unknown',
  /** Phase 2 (ADR-107): left by session.switchConversation (new value → registry schema v2). */
  'switched',
]);
export type ConversationEndReason = z.infer<typeof conversationEndReasonSchema>;

export const conversationSchema = z.object({
  id: conversationIdSchema,
  /** Claude session id; null until the first `init` of this conversation (F.7: comes from the next init). */
  sessionId: claudeSessionIdSchema.nullable().default(null),
  startedAt: isoDateTimeSchema,
  endedAt: isoDateTimeSchema.nullable().default(null),
  endReason: conversationEndReasonSchema.nullable().default(null),
  /** Title at the time the conversation ended. */
  title: z.string().max(LIMITS.titleChars).nullable().default(null),
  /** `new_conversation_id` of the conversation_reset that started it – correlation only (F.7). */
  resetCorrelationId: z.string().nullable().default(null),
  /**
   * Cumulative cost of this conversation, summed over its query segments (WP22-10: since CLI
   * 2.1.300 `total_cost_usd` starts at 0 after a resume – F.14 no longer holds).
   */
  costUsd: z.number().nonnegative().nullable().default(null),
  /** Highest item `order` written so far (the normalizer continues from here, §5.6). */
  lastOrder: z.number().int().nonnegative().default(0),
});
export type Conversation = z.infer<typeof conversationSchema>;

/** Phase 2 (ADR-104): the entry is open in an external console. */
export const externalHandoffSchema = z.object({
  /** claude.exe of the console; null = unknown. */
  pid: z.number().int().positive().nullable(),
  /** Exact process start time (PID-reuse check, like ADR-081); null = unknown. */
  processStartedAt: isoDateTimeSchema.nullable(),
  since: isoDateTimeSchema,
  /** Conversation whose session id was resumed in the console. */
  conversationId: conversationIdSchema,
});
export type ExternalHandoff = z.infer<typeof externalHandoffSchema>;

/** Replaces `titleIsCustom` (= 'custom'); only 'custom' is never overwritten automatically. */
export const titleSourceSchema = z.enum(['none', 'prompt', 'ai', 'custom']);
export type TitleSource = z.infer<typeof titleSourceSchema>;

export const entrySchema = z.object({
  id: entryIdSchema,
  createdAt: isoDateTimeSchema,
  profileId: profileIdSchema,
  /** Exactly as given, never normalized (B). */
  cwd: z.string().min(1),
  title: z.string().max(LIMITS.titleChars).default(''),
  titleSource: titleSourceSchema.default('none'),
  pinned: z.boolean().default(false),
  archived: z.boolean().default(false),
  lastActivityAt: isoDateTimeSchema,
  /** All conversations, oldest first; the last one is the current one (`currentSessionId` = last.sessionId). */
  conversations: z.array(conversationSchema).min(1),
  /** Model selected by the user/profile (alias as given, e.g. 'haiku'); passed to setModel/resume. */
  modelSetting: z.string().min(1).nullable().default(null),
  /** Last model actually seen on an assistant message (F.6: per message, not init.model). */
  lastModel: z.string().nullable().default(null),
  /** Last ACTUAL permission mode (init/status); passed on resume (C.3). */
  permissionMode: permissionModeSchema.nullable().default(null),
  effort: effortLevelSchema.nullable().default(null),
  fastMode: z.boolean().nullable().default(null),
  /** Per session (B Claude-Auflösung). */
  cliVersion: z.string().nullable().default(null),
  /** init.apiKeySource ('none' = subscription). */
  apiKeySource: z.string().nullable().default(null),
  lastRunState: runStateSchema.default('sleeping'),
  /** Plan B field; always `context?.percentage ?? null` (the engine writes both). */
  contextPct: z.number().nonnegative().nullable().default(null),
  lastError: errorInfoSchema.nullable().default(null),
  /** Short excerpt of the last result text for dormant entries (A.5). */
  lastResultExcerpt: z.string().max(500).nullable().default(null),
  /** R0-17: a finished, unseen session keeps its "done" dot across a server restart. */
  unread: z.boolean().default(false),
  /** R0-17: last gauge, so sleeping sessions still show their context fill after a restart. */
  context: contextGaugeSchema.nullable().default(null),
  /** Phase 2 (ADR-113): last git branch (null = no repo/unknown); shown for dormant entries too. */
  gitBranch: z.string().max(200).nullable().default(null),
  /** Phase 2 (ADR-104): open in an external console; null = not handed off. */
  external: externalHandoffSchema.nullable().default(null),
  /** Phase 2 (ADR-112): scheduled "continue" after a rate limit (→ StatusFacts.wakeupAt). */
  continueAt: isoDateTimeSchema.nullable().default(null),
});
export type Entry = z.infer<typeof entrySchema>;

/** 1 → 2 (Phase 2, ADR-107): conversation end reason 'switched'; the migration is the identity. */
export const REGISTRY_SCHEMA_VERSION = 2;
/** `sessions.json`. */
export const registryFileSchema = z.object({
  schemaVersion: z.literal(REGISTRY_SCHEMA_VERSION),
  entries: z.array(entrySchema),
});
export type RegistryFile = z.infer<typeof registryFileSchema>;

/** The current (last) conversation of an entry. */
export function currentConversation(entry: Entry): Conversation {
  const last = entry.conversations.at(-1);
  if (last === undefined) throw new Error(`entry ${entry.id} has no conversation`);
  return last;
}

/** Claude session id of the current conversation (Plan registry field, derived). */
export function currentSessionId(entry: Entry): string | null {
  return currentConversation(entry).sessionId;
}

/** Claude session ids of all earlier conversations, oldest first (Plan registry field, derived). */
export function previousSessionIds(entry: Entry): string[] {
  return entry.conversations
    .slice(0, -1)
    .map((c) => c.sessionId)
    .filter((id): id is string => id !== null);
}

// =====================================================================================
// 5.5 Capped texts, blobs, attachments (B "Speicher", Plan "Anhänge")
// =====================================================================================

/** Where a capped value went: full length and the blob with the full content (`GET /api/blob/<id>`). */
export const truncationSchema = z.object({ totalChars: z.number().int().positive(), blobId: blobIdSchema });
export type Truncation = z.infer<typeof truncationSchema>;

/** Text that may have been capped at LIMITS.itemTextChars; the full text lives in a blob. */
export const cappedTextSchema = z.object({
  text: z.string(),
  truncated: truncationSchema.nullable().default(null),
});
export type CappedText = z.infer<typeof cappedTextSchema>;

export const blobRefSchema = z.object({
  blobId: blobIdSchema,
  /** image/png, application/pdf, text/plain, application/json … */
  mediaType: z.string().min(1).max(100),
  bytes: z.number().int().nonnegative(),
  width: z.number().int().positive().nullable().default(null),
  height: z.number().int().positive().nullable().default(null),
  name: z.string().max(260).nullable().default(null),
});
export type BlobRef = z.infer<typeof blobRefSchema>;

// =====================================================================================
// 5.7 Decision outcome (needed by tool_call items)
// =====================================================================================

export const CANCEL_REASONS = [
  'signal_aborted',
  'interrupted',
  'process_exit',
  'conversation_reset',
] as const;

/** What happened; in the decision.resolved op, tool_call.decision and decisions.json. */
export const decisionOutcomeSchema = z.discriminatedUnion('type', [
  z.object({
    type: z.literal('allowed'),
    remember: ruleDestinationSchema.nullable(),
    acceptEdits: z.boolean(),
  }),
  z.object({ type: z.literal('denied'), withMessage: z.boolean(), interrupt: z.boolean() }),
  z.object({ type: z.literal('answered') }),
  z.object({ type: z.literal('declined') }),
  z.object({ type: z.literal('plan_approved'), mode: permissionModeSchema, edited: z.boolean() }),
  z.object({ type: z.literal('plan_revised') }),
  z.object({ type: z.literal('cancelled'), reason: z.enum(CANCEL_REASONS) }),
  /** After a restart (A.10). */
  z.object({ type: z.literal('expired') }),
]);
export type DecisionOutcome = z.infer<typeof decisionOutcomeSchema>;

// =====================================================================================
// 5.6 Transcript items (A.2, A.3, B "Message-Routing", F.4, F.6, F.9–F.13)
// =====================================================================================

const itemBase = {
  id: itemIdSchema,
  /** Strictly increasing per conversation, assigned once, never changed; clients sort only by it. */
  order: z.number().int().positive(),
  /** SDK timestamp if present, else receive time (F.15: history has timestamps). */
  at: isoDateTimeSchema,
  /** Non-null when produced inside a subagent (B Message-Routing): the UI nests it under that tool_call. */
  parentToolUseId: z.string().nullable().default(null),
};

export const userMessageItemSchema = z.object({
  ...itemBase,
  kind: z.literal('user_message'),
  text: cappedTextSchema,
  /** Images/documents of the message. */
  attachments: z.array(blobRefSchema).default([]),
  /** 'other' = channel/peer/synthetic. */
  origin: z.enum(['human', 'other']).default('human'),
  /** '/clear', '/rename' … when the text starts with '/'. */
  slashCommand: z.string().nullable().default(null),
  /** As sent. */
  priority: promptPrioritySchema.nullable().default(null),
});
export type UserMessageItem = z.infer<typeof userMessageItemSchema>;

export const assistantTextItemSchema = z.object({
  ...itemBase,
  kind: z.literal('assistant_text'),
  messageId: z.string(),
  blockIndex: z.number().int().nonnegative(),
  /** F.6: per message; '<synthetic>' for local commands. */
  model: z.string().nullable(),
  /** Assistant text is never capped. */
  text: z.string(),
  streaming: z.boolean(),
  aborted: z.boolean().default(false),
  /** F.8 (`local_command_run`). */
  localCommand: z.object({ command: z.string(), args: z.string() }).nullable().default(null),
});
export type AssistantTextItem = z.infer<typeof assistantTextItemSchema>;

export const thinkingItemSchema = z.object({
  ...itemBase,
  kind: z.literal('thinking'),
  messageId: z.string(),
  blockIndex: z.number().int().nonnegative(),
  model: z.string().nullable(),
  text: cappedTextSchema,
  redacted: z.boolean().default(false),
  streaming: z.boolean(),
});
export type ThinkingItem = z.infer<typeof thinkingItemSchema>;

export const TOOL_CALL_STATUSES = [
  'streaming_input',
  'pending',
  'awaiting_decision',
  'running',
  'background',
  'done',
  'error',
  'denied',
  'interrupted',
] as const;
export const toolCallStatusSchema = z.enum(TOOL_CALL_STATUSES);
export type ToolCallStatus = z.infer<typeof toolCallStatusSchema>;

export const toolResultContentSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('text'), text: cappedTextSchema }),
  z.object({ type: z.literal('image'), image: blobRefSchema }),
]);
export type ToolResultContent = z.infer<typeof toolResultContentSchema>;

export const toolResultSchema = z.object({
  isError: z.boolean(),
  /** tool_result content: text parts (capped) and images (blobs). */
  content: z.array(toolResultContentSchema),
  /** Live `tool_use_result` (capped JSON); null in history (F.15) – renderers must not rely on it (A.3). */
  structured: jsonValueSchema.nullable().default(null),
  structuredTruncated: truncationSchema.nullable().default(null),
  at: isoDateTimeSchema,
});
export type ToolResult = z.infer<typeof toolResultSchema>;

/** F.11: Agent / background tasks. */
export const taskInfoSchema = z.object({
  taskId: z.string(),
  /** 'local_agent', 'local_bash', … (open set). */
  taskType: z.string().nullable().default(null),
  /** started|running|completed|failed|stopped|killed (open set). */
  status: z.string(),
  description: z.string().default(''),
  subagentType: z.string().nullable().default(null),
  isBackgrounded: z.boolean().default(false),
  summary: z.string().nullable().default(null),
  usage: z
    .object({ totalTokens: z.number(), toolUses: z.number(), durationMs: z.number() })
    .nullable()
    .default(null),
  startedAt: isoDateTimeSchema.nullable().default(null),
  endedAt: isoDateTimeSchema.nullable().default(null),
});
export type TaskInfo = z.infer<typeof taskInfoSchema>;

/** Link from a tool call to the decision that gated it (set by the engine via normalizer.attachDecision). */
export const toolDecisionRefSchema = z.object({
  decisionId: decisionIdSchema,
  kind: decisionKindSchema,
  planVersion: z.number().int().positive().nullable().default(null),
  /** null while open. */
  outcome: decisionOutcomeSchema.nullable().default(null),
});
export type ToolDecisionRef = z.infer<typeof toolDecisionRefSchema>;

export const toolCallItemSchema = z.object({
  ...itemBase,
  kind: z.literal('tool_call'),
  messageId: z.string(),
  blockIndex: z.number().int().nonnegative(),
  model: z.string().nullable(),
  toolUseId: z.string(),
  /** Open set: Edit, Write, Bash, PowerShell, Agent, mcp__… */
  toolName: z.string(),
  /** Input JSON; long string values capped in place (Write.content …). */
  input: jsonValueSchema,
  inputTruncated: truncationSchema.nullable().default(null),
  /** Raw partial JSON while streaming (input_json_delta, B); null when final. */
  inputPartial: z.string().nullable().default(null),
  status: toolCallStatusSchema,
  result: toolResultSchema.nullable().default(null),
  /** tool_progress. */
  elapsedSeconds: z.number().nonnegative().nullable().default(null),
  /** Agent / background Bash. */
  task: taskInfoSchema.nullable().default(null),
  decision: toolDecisionRefSchema.nullable().default(null),
});
export type ToolCallItem = z.infer<typeof toolCallItemSchema>;

const systemBase = z.object({ ...itemBase, kind: z.literal('system') });

/** System items (`kind: 'system'`, sub-discriminator `event`). */
export const systemItemSchema = z.discriminatedUnion('event', [
  systemBase.extend({
    event: z.literal('compact_boundary'),
    trigger: z.enum(['manual', 'auto']),
    preTokens: z.number().nullable(),
    postTokens: z.number().nullable(),
  }),
  /** One item per retry series, counted up via upsert. */
  systemBase.extend({
    event: z.literal('api_retry'),
    attempt: z.number().int(),
    maxRetries: z.number().int(),
    retryDelayMs: z.number(),
    errorStatus: z.number().nullable(),
    errorCode: errorCodeSchema,
    active: z.boolean(),
  }),
  /** Only allowed_warning / rejected (C.5). */
  systemBase.extend({ event: z.literal('rate_limit'), info: rateLimitInfoSchema }),
  /** system/notification. */
  systemBase.extend({
    event: z.literal('notification'),
    key: z.string(),
    text: z.string(),
    priority: z.string(),
  }),
  systemBase.extend({
    event: z.literal('informational'),
    level: z.string(),
    text: cappedTextSchema,
    tag: z.string().nullable(),
    preventContinuation: z.boolean(),
  }),
  /** hook_started/progress/response, upsert per hook_id. */
  systemBase.extend({
    event: z.literal('hook'),
    hookName: z.string(),
    hookEvent: z.string(),
    outcome: z.string().nullable(),
    output: cappedTextSchema,
  }),
  systemBase.extend({
    event: z.literal('permission_denied'),
    toolName: z.string(),
    toolUseId: z.string(),
    message: z.string(),
    reasonType: z.string().nullable(),
  }),
  systemBase.extend({
    event: z.literal('memory_recall'),
    mode: z.string(),
    memories: z.array(
      z.object({ path: z.string(), scope: z.string(), content: cappedTextSchema.nullable() }),
    ),
  }),
  systemBase.extend({ event: z.literal('local_command_output'), text: cappedTextSchema }),
  /** model_refusal_fallback; retracted items → item.remove. */
  systemBase.extend({
    event: z.literal('model_fallback'),
    originalModel: z.string(),
    fallbackModel: z.string(),
    text: z.string(),
  }),
  /** User texts "[Request interrupted by user(…)]" (F.10). */
  systemBase.extend({ event: z.literal('interrupted'), forToolUse: z.boolean() }),
  /** First item of the NEW conversation. */
  systemBase.extend({ event: z.literal('conversation_reset'), trigger: z.string().nullable() }),
  /** Only tasks without a matching tool_call. */
  systemBase.extend({ event: z.literal('task_notification'), task: taskInfoSchema }),
  /** assistant.error, crash, startup failure, result errors. */
  systemBase.extend({ event: z.literal('error'), error: errorPayloadSchema }),
  /** Phase 2 (ADR-104): handed off to / returned from an external console. */
  systemBase.extend({
    event: z.literal('handoff'),
    phase: z.enum(['external', 'returned']),
    /** 'returned': items imported from the CLI transcript (turns made in the console). */
    importedItems: z.number().int().nonnegative().default(0),
  }),
  /** Tolerant parsing. */
  systemBase.extend({
    event: z.literal('unknown'),
    sdkType: z.string(),
    sdkSubtype: z.string().nullable(),
    preview: z.string().max(2000),
  }),
]);
export type SystemItem = z.infer<typeof systemItemSchema>;
export type SystemEvent = SystemItem['event'];

/** Turn footer (Plan "Chat-Ansicht"). */
export const turnResultItemSchema = z.object({
  ...itemBase,
  kind: z.literal('turn_result'),
  /** interrupted: terminal_reason aborted_* (F.3, F.10). */
  outcome: turnOutcomeSchema,
  /** success | error_during_execution | error_max_turns … */
  subtype: z.string(),
  terminalReason: z.string().nullable(),
  stopReason: z.string().nullable(),
  durationMs: z.number().nonnegative(),
  durationApiMs: z.number().nonnegative().nullable(),
  numTurns: z.number().int().nonnegative(),
  usage: z.object({
    input: z.number(),
    output: z.number(),
    cacheRead: z.number(),
    cacheCreation: z.number(),
  }),
  /** Cumulative per query segment. */
  costUsdTotal: z.number().nonnegative().nullable(),
  /** Difference to the previous result of the same query. */
  costUsdTurn: z.number().nonnegative().nullable(),
  permissionDenials: z.number().int().nonnegative(),
  errors: z.array(z.string()).default([]),
  userMessageUuids: z.array(z.string()).default([]),
  /** num_turns 0 (/rename, /clear: F.7, F.8) – the UI hides it. */
  synthetic: z.boolean().default(false),
});
export type TurnResultItem = z.infer<typeof turnResultItemSchema>;

/** Discriminator `kind`; system items additionally by `event`. */
export const transcriptItemSchema = z.discriminatedUnion('kind', [
  userMessageItemSchema,
  assistantTextItemSchema,
  thinkingItemSchema,
  toolCallItemSchema,
  systemItemSchema,
  turnResultItemSchema,
]);
export type TranscriptItem = z.infer<typeof transcriptItemSchema>;
export type TranscriptItemKind = TranscriptItem['kind'];

// =====================================================================================
// 5.7 Decisions (PermissionBroker, A.2, A.6, A.10, C.4, F.3, F.5, F.6)
// =====================================================================================

export const requesterSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('main') }),
  z.object({
    kind: z.literal('subagent'),
    agentId: z.string(),
    description: z.string().nullable().default(null),
    parentToolUseId: z.string().nullable().default(null),
  }),
]);
export type Requester = z.infer<typeof requesterSchema>;

export const decisionStateSchema = z.enum(['open', 'expired']);
export type DecisionState = z.infer<typeof decisionStateSchema>;

const decisionBase = {
  id: decisionIdSchema,
  entryId: entryIdSchema,
  conversationId: conversationIdSchema,
  toolUseId: z.string(),
  toolName: z.string(),
  requester: requesterSchema,
  createdAt: isoDateTimeSchema,
  /** open → resolved | cancelled; open → expired (server restart, A.10). Snapshots carry open + expired. */
  state: decisionStateSchema,
};

export const permissionOfferSchema = z.object({
  /** Rules the CLI suggested (addRules, merged); empty → no "remember" option. */
  rules: z.array(z.object({ toolName: z.string(), ruleContent: z.string().nullable() })),
  /** addDirectories suggestions. */
  directories: z.array(z.string()),
  /** Allowed destinations for remembering (ADR-012); [] when suppressAlwaysAllowRule or nothing to remember. */
  ruleDestinations: z.array(ruleDestinationSchema),
  /** suggestions contained setMode acceptEdits and the current mode is not acceptEdits/auto/bypass. */
  acceptEdits: z.boolean(),
  defaultToNo: z.boolean(),
});
export type PermissionOffer = z.infer<typeof permissionOfferSchema>;

export const permissionDecisionSchema = z.object({
  ...decisionBase,
  kind: z.literal('permission'),
  /** Capped like tool_call.input. */
  input: jsonValueSchema,
  inputTruncated: truncationSchema.nullable().default(null),
  /** options.title (primary text if present). */
  title: z.string().nullable(),
  displayName: z.string().nullable(),
  description: z.string().nullable(),
  decisionReason: z.string().nullable(),
  /** Untyped (F.3). */
  decisionReasonType: z.string().nullable(),
  blockedPath: z.string().nullable(),
  mcpServer: z.object({ name: z.string(), source: z.string() }).nullable(),
  offer: permissionOfferSchema,
});
export type PermissionDecision = z.infer<typeof permissionDecisionSchema>;

/** AskUserQuestion (F.5). */
export const questionDecisionSchema = z.object({
  ...decisionBase,
  kind: z.literal('question'),
  questions: z
    .array(
      z.object({
        question: z.string(),
        header: z.string().default(''),
        multiSelect: z.boolean().default(false),
        options: z.array(
          z.object({
            label: z.string(),
            description: z.string().default(''),
            preview: z.string().nullable().default(null),
          }),
        ),
      }),
    )
    .min(1),
});
export type QuestionDecision = z.infer<typeof questionDecisionSchema>;

/** ExitPlanMode (F.6, C.4). */
export const planDecisionSchema = z.object({
  ...decisionBase,
  kind: z.literal('plan'),
  /** input.plan (Markdown, never capped). */
  plan: z.string(),
  /** input.planFilePath (C.4: always from here). */
  planFilePath: z.string().nullable(),
  /**
   * v1, v2 … per ENTRY, monotonic across conversations (`/clear` does not restart it): the files
   * `entries/<entryId>/plans/v<N>.md` and `DecisionStore.savePlan(entryId, version)` know no
   * conversation, so a per-conversation count would overwrite older plans (WP-13 §6 Nr. 4).
   */
  version: z.number().int().positive(),
  /** Text of v(n-1) of the same conversation, for "Was hat sich geändert?" (Phase 3). */
  previousVersionPlan: z.string().nullable(),
  /** Modes offered for "approve"; always explicit (C.4). The server decides (bypass only if the profile allows). */
  approveModes: z.array(permissionModeSchema).min(1),
});
export type PlanDecision = z.infer<typeof planDecisionSchema>;

export const decisionSchema = z.discriminatedUnion('kind', [
  permissionDecisionSchema,
  questionDecisionSchema,
  planDecisionSchema,
]);
export type Decision = z.infer<typeof decisionSchema>;

// ---- Responses (client → server, inside decision.respond): intents, never raw updatedPermissions ----

export const permissionResponseSchema = z.discriminatedUnion('behavior', [
  z.object({
    behavior: z.literal('allow'),
    /** Remember rules + directories at this destination (ADR-012); must be in offer.ruleDestinations. */
    remember: ruleDestinationSchema.nullable().default(null),
    /** Additionally setMode acceptEdits (destination always 'session'). */
    acceptEdits: z.boolean().default(false),
  }),
  z.object({
    behavior: z.literal('deny'),
    message: z.string().max(LIMITS.decisionMessageChars).default(''),
    interrupt: z.boolean().default(false),
  }),
]);
export type PermissionResponse = z.infer<typeof permissionResponseSchema>;

export const questionResponseSchema = z.discriminatedUnion('behavior', [
  z.object({
    behavior: z.literal('answer'),
    answers: z
      .array(
        z.object({
          /** Key = question text (F.5); must be a question of the decision (server checks, R0-09). */
          question: z.string().max(LIMITS.questionChars),
          /** Labels ⊆ the question's option labels; multi-select → comma-separated (server). */
          selected: z.array(z.string().max(LIMITS.answerChars)).max(LIMITS.selectedMax),
          /** "Andere" free text. */
          otherText: z.string().max(LIMITS.answerChars).nullable().default(null),
          /** → annotations[q].notes */
          notes: z.string().max(LIMITS.answerChars).nullable().default(null),
        }),
      )
      .min(1)
      .max(LIMITS.answersMax),
  }),
  z.object({
    behavior: z.literal('decline'),
    message: z.string().max(LIMITS.decisionMessageChars).default(''),
  }),
]);
export type QuestionResponse = z.infer<typeof questionResponseSchema>;

export const planResponseSchema = z.discriminatedUnion('behavior', [
  z.object({
    behavior: z.literal('approve'),
    /** Must be in decision.approveModes (server checks, R0-09). */
    mode: permissionModeSchema,
    editedPlan: z.string().max(LIMITS.planChars).nullable().default(null),
  }),
  /** deny + message. */
  z.object({ behavior: z.literal('revise'), feedback: z.string().min(1).max(LIMITS.planFeedbackChars) }),
  /** C.4 fallback, Phase 3 → NOT_IMPLEMENTED. */
  z.object({ behavior: z.literal('approve_fresh_context'), mode: permissionModeSchema }),
]);
export type PlanResponse = z.infer<typeof planResponseSchema>;

export const decisionResponseSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('permission'), response: permissionResponseSchema }),
  z.object({ kind: z.literal('question'), response: questionResponseSchema }),
  z.object({ kind: z.literal('plan'), response: planResponseSchema }),
]);
export type DecisionResponse = z.infer<typeof decisionResponseSchema>;

// ---- Persisted metadata (A.3 "Metadaten werden persistiert", A.10) ----

export const decisionRecordSchema = z.object({
  id: decisionIdSchema,
  kind: decisionKindSchema,
  conversationId: conversationIdSchema,
  toolUseId: z.string(),
  toolName: z.string(),
  requester: requesterSchema,
  createdAt: isoDateTimeSchema,
  resolvedAt: isoDateTimeSchema.nullable(),
  /** null = was still open when persisted. */
  outcome: decisionOutcomeSchema.nullable(),
  planVersion: z.number().int().positive().nullable(),
  planFilePath: z.string().nullable(),
  /**
   * R0-07: the decision as created (capped like on the wire), kept ONLY while it is open
   * (`outcome` null) and set to null on resolution. After a restart the engine restores it with
   * `state: 'expired'` (A.10: read-only card). Records without it (null) are closed as expired
   * without a card and only counted.
   */
  decision: decisionSchema.nullable().default(null),
});
export type DecisionRecord = z.infer<typeof decisionRecordSchema>;

export const DECISIONS_SCHEMA_VERSION = 1;
/** `entries/<entryId>/decisions.json`. */
export const decisionRecordsFileSchema = z.object({
  schemaVersion: z.literal(DECISIONS_SCHEMA_VERSION),
  records: z.array(decisionRecordSchema),
});
export type DecisionRecordsFile = z.infer<typeof decisionRecordsFileSchema>;

// =====================================================================================
// 5.10 Session summary (channel 1, A.2)
// =====================================================================================

/** Facts, not a finished display: server and UI call deriveDisplayStatus(facts, now) (A.4). */
export const sessionSummarySchema = z.object({
  entryId: entryIdSchema,
  title: z.string(),
  titleSource: titleSourceSchema,
  profileId: profileIdSchema,
  cwd: z.string(),
  pinned: z.boolean(),
  archived: z.boolean(),
  createdAt: isoDateTimeSchema,
  lastActivityAt: isoDateTimeSchema,
  status: statusFactsSchema,
  /** lastModel (F.6). */
  model: z.string().nullable(),
  modelSetting: z.string().nullable(),
  /** Actual mode (C.3). */
  permissionMode: permissionModeSchema.nullable(),
  effort: effortLevelSchema.nullable(),
  fastMode: z.boolean().nullable(),
  context: contextGaugeSchema.nullable(),
  /** Tooltip. */
  sessionId: claudeSessionIdSchema.nullable(),
  cliVersion: z.string().nullable(),
  apiKeySource: z.string().nullable(),
  /** Phase 2 (Plan "Git-Branch"). */
  gitBranch: z.string().nullable().default(null),
  lastError: errorInfoSchema.nullable(),
  lastResultExcerpt: z.string().nullable(),
  /**
   * Phase 2 (ADR-104): external console; null = not handed off. `running: false` = the console
   * ended, the return is pending.
   */
  external: z
    .object({
      since: isoDateTimeSchema,
      pid: z.number().int().positive().nullable(),
      running: z.boolean(),
    })
    .nullable()
    .default(null),
});
export type SessionSummary = z.infer<typeof sessionSummarySchema>;

// =====================================================================================
// 5.11 Session detail (channel 2, subscribers only)
// =====================================================================================

/** B "Gequeuete Nachrichten", F.9. */
export const queuedPromptSchema = z.object({
  messageUuid: messageUuidSchema,
  text: cappedTextSchema,
  attachments: z.array(blobRefSchema).default([]),
  priority: promptPrioritySchema,
  /** 'sending' = accepted by Parallax, not yet acknowledged by the CLI; 'queued' = command_lifecycle queued. */
  state: z.enum(['sending', 'queued']),
  queuedAt: isoDateTimeSchema,
});
export type QueuedPrompt = z.infer<typeof queuedPromptSchema>;

/** background_tasks_changed (REPLACE semantics). */
export const backgroundTaskSchema = z.object({
  taskId: z.string(),
  taskType: z.string(),
  description: z.string(),
  subagentType: z.string().nullable(),
  parentTaskId: z.string().nullable(),
  ambient: z.boolean(),
});
export type BackgroundTask = z.infer<typeof backgroundTaskSchema>;

/** system/init (every turn: update, not reset; C.5). */
export const sessionInitInfoSchema = z.object({
  sessionId: claudeSessionIdSchema,
  cwd: z.string(),
  model: z.string(),
  /** null = unknown mode of a newer CLI (`parsePermissionMode` + `unknownEnumCountKey`, R0-05). */
  permissionMode: permissionModeSchema.nullable(),
  apiKeySource: z.string(),
  cliVersion: z.string(),
  tools: z.array(z.string()),
  slashCommands: z.array(z.string()),
  terminalSlashCommands: z.array(z.string()),
  mcpServers: z.array(z.object({ name: z.string(), status: z.string(), source: z.string().nullable() })),
  skills: z.array(z.string()),
  agents: z.array(z.string()),
  /** Without paths. */
  plugins: z.array(z.object({ name: z.string(), version: z.string().nullable() })),
  capabilities: z.array(z.string()),
  outputStyle: z.string().nullable(),
  fastModeState: z.string().nullable(),
  /** null also for an unknown level (`parseEffortLevel`). */
  effort: effortLevelSchema.nullable(),
});
export type SessionInitInfo = z.infer<typeof sessionInitInfoSchema>;

/** supportedModels() (F.12). */
export const modelOptionSchema = z.object({
  value: z.string(),
  displayName: z.string(),
  description: z.string(),
  supportsEffort: z.boolean(),
  /** Producer drops unknown levels of a newer CLI (`parseEffortLevels`, R0-05). */
  supportedEffortLevels: z.array(effortLevelSchema),
  supportsFastMode: z.boolean(),
  supportsAutoMode: z.boolean(),
});
export type ModelOption = z.infer<typeof modelOptionSchema>;

/** supportedCommands(), Phase 2. */
export const slashCommandInfoSchema = z.object({
  name: z.string(),
  description: z.string(),
  argumentHint: z.string(),
  aliases: z.array(z.string()).default([]),
  builtin: z.boolean().default(false),
});
export type SlashCommandInfo = z.infer<typeof slashCommandInfoSchema>;

/** Fields without top-level defaults: the base of the patch schema (a patch must never inject defaults). */
const sessionDetailFields = {
  conversationId: conversationIdSchema,
  /** "Frühere Unterhaltungen". */
  conversations: z.array(conversationSchema),
  init: sessionInitInfoSchema.nullable(),
  models: z.array(modelOptionSchema).nullable(),
  commands: z.array(slashCommandInfoSchema).nullable(),
  queue: z.array(queuedPromptSchema),
  backgroundTasks: z.array(backgroundTaskSchema),
  promptSuggestion: z.string().nullable(),
  rateLimit: rateLimitInfoSchema.nullable(),
  /** Tolerant-parsing counters (dev display, SDK upgrade process B). */
  unknownCounts: z.record(z.string(), z.number().int()),
};

export const sessionDetailSchema = z.object({
  entryId: entryIdSchema,
  ...sessionDetailFields,
  unknownCounts: sessionDetailFields.unknownCounts.default({}),
});
export type SessionDetail = z.infer<typeof sessionDetailSchema>;

/** `detail.patch`: replaces exactly the given fields (arrays are not merged, no defaults applied). */
export const sessionDetailPatchSchema = z.object(sessionDetailFields).partial();
export type SessionDetailPatch = z.infer<typeof sessionDetailPatchSchema>;

// =====================================================================================
// 5.12 Folder browser (Phase 2, ADR-119)
// =====================================================================================

export const fsEntrySchema = z.object({
  name: z.string(),
  /** Absolute path (listed path + name) – usable as session.create.cwd as is. */
  path: z.string(),
  /** 'drive' and 'home' only in the roots; 'link' = junction/symlink to a directory. */
  kind: z.enum(['drive', 'home', 'directory', 'link']),
  /** Heuristic: name starts with '.' or is a known system folder ($Recycle.Bin, System Volume Information …). */
  hidden: z.boolean(),
});
export type FsEntry = z.infer<typeof fsEntrySchema>;

export const fsListingSchema = z.object({
  /** null = the roots (drives + user folder). */
  path: z.string().nullable(),
  /** null at a drive root and for the roots. */
  parent: z.string().nullable(),
  /** Directories only, sorted case-insensitively by name. */
  entries: z.array(fsEntrySchema),
  /** More than LIMITS.fsListMax directories. */
  truncated: z.boolean(),
});
export type FsListing = z.infer<typeof fsListingSchema>;
