/**
 * Data model shared by server and web: profiles, settings, registry entries, transcript items,
 * decisions, context/rate limits, host state, session summary and detail.
 * Design (normative): docs/wp/WP-02.md §5. Persisted schemas: new fields always with a default
 * (old files load without migration); otherwise bump the schema version (§13).
 */
import { z } from 'zod';
import {
  LIMITS,
  LOCAL_HOST_ID,
  blobIdSchema,
  claudeSessionIdSchema,
  clientIdSchema,
  conversationIdSchema,
  decisionIdSchema,
  decisionKindSchema,
  effortLevelSchema,
  entryIdSchema,
  hostIdSchema,
  isoDateTimeSchema,
  paramsSchema,
  itemIdSchema,
  jsonValueSchema,
  languageSchema,
  messageUuidSchema,
  modelNameSchema,
  permissionModeSchema,
  profileIdSchema,
  promptPrioritySchema,
  ruleDestinationSchema,
  terminalIdSchema,
  themeSchema,
} from './common';
import { errorCodeSchema, errorInfoSchema, errorPayloadSchema } from './errors';
import {
  WIN32_PATHS,
  isSafeWindowsPath,
  pathFlavorOfShape,
  pathRules,
  type PathFlavor,
  type PathRules,
} from './paths';
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
  /**
   * WP-63: token count (not a percentage) at which the CLI compacts automatically (fixtures:
   * 967 000) – from `getContextUsage('summary')` after each turn; an estimate during the turn keeps
   * the last known value. null = unknown (older gauges, no measurement yet).
   */
  autoCompactThreshold: z.number().int().nonnegative().nullable().default(null),
  /** WP-63: the CLI compacts automatically (null = unknown). */
  isAutoCompactEnabled: z.boolean().nullable().default(null),
});
export type ContextGauge = z.infer<typeof contextGaugeSchema>;

/** Click on the gauge (getContextUsage); the autocompact fields come from the gauge (WP-63). */
export const contextBreakdownSchema = contextGaugeSchema.extend({
  detail: z.enum(['summary', 'full']),
  categories: z.array(
    z.object({
      name: z.string(),
      tokens: z.number(),
      kind: z.enum(['used', 'free', 'buffer', 'deferred']),
      /**
       * Phase 3 (SDK 0.3.322): stable category id – 'system_prompt', 'system_tools', 'mcp_tools',
       * 'memory_files', 'skills', 'messages' … (open set); null from older CLIs.
       */
      id: z.string().nullable().default(null),
    }),
  ),
});
export type ContextBreakdown = z.infer<typeof contextBreakdownSchema>;

export const rateLimitInfoSchema = z.object({
  status: z.enum(['allowed', 'allowed_warning', 'rejected']),
  /** five_hour, seven_day … (open set). */
  rateLimitType: z.string().nullable(),
  /** The SDK sends seconds → ISO. */
  resetsAt: isoDateTimeSchema.nullable(),
  /**
   * Share of the window used as a FRACTION 0–1 – here and in `windows` (WP-65: one unit; the usage
   * query reports 0–100 and the server divides by 100 before it stores anything).
   */
  utilization: z.number().nullable(),
  /**
   * Untyped `unifiedWindows` (F.13) for the subscription limit display (Phase 2); since WP-65 also
   * the windows of the usage query (`five_hour`, `seven_day`, …), merged into the last info.
   */
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
  /**
   * WP-62: the claude version last checked with Parallax (`pnpm cli-check --accept`, CLI profile in
   * the repo); null = unknown. The UI hints (no error) when `version` is newer.
   */
  testedVersion: z.string().nullable().default(null),
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

/**
 * WP-70: the login of a profile from Parallax (the CLI's OAuth flow in a short-lived `claude` of the
 * profile; writer: the login service). `idle` = none since the server start; `starting` = process
 * and flow are being set up; `waiting` = the link is open in the browser, the CLI waits for the
 * redirect or the pasted code; `verifying` = a pasted code is being checked; `done` = signed in
 * (`subscriptionType`, e.g. `max`); `failed` = `error` (LOGIN_UNAVAILABLE/LOGIN_FAILED/LOGIN_BLOCKED).
 * Never the account's e-mail or organization. Runtime only, not persisted.
 */
export const PROFILE_LOGIN_STATES = ['idle', 'starting', 'waiting', 'verifying', 'done', 'failed'] as const;
export const profileLoginStateSchema = z.enum(PROFILE_LOGIN_STATES);
export type ProfileLoginState = z.infer<typeof profileLoginStateSchema>;

export const profileLoginSchema = z.object({
  state: profileLoginStateSchema,
  /** The link opened in the browser (`automaticUrl`, else `manualUrl`); set while waiting/verifying. */
  url: z.string().refine(isHttpUrl, { message: 'not an http(s) link' }).nullable(),
  /** The link whose page shows a code to paste (works on any device); set while waiting/verifying. */
  manualUrl: z.string().refine(isHttpUrl, { message: 'not an http(s) link' }).nullable(),
  /** `done`: the plan the CLI reported (`max`, `pro`, …; null = not reported). */
  subscriptionType: z.string().max(40).nullable(),
  error: errorPayloadSchema.nullable(),
  /** Last change of the state (null while idle). */
  at: isoDateTimeSchema.nullable(),
});
export type ProfileLogin = z.infer<typeof profileLoginSchema>;

export const IDLE_PROFILE_LOGIN: ProfileLogin = {
  state: 'idle',
  url: null,
  manualUrl: null,
  subscriptionType: null,
  error: null,
  at: null,
};

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
  /** WP-70: the login from Parallax (runtime only; default idle). */
  login: profileLoginSchema.default(IDLE_PROFILE_LOGIN),
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

// ---- Editor for "Open in editor" (Phase 3, ADR-144; WP-30 F1) ----

/**
 * Editor presets. Windows: Notepad++, VS Code; Linux (102e, WP-100 §5.6): VS Code, VSCodium, Zed,
 * Sublime Text, Kate, GNOME Text Editor, gedit – each found on `PATH` (`files/editors.ts`). `custom`
 * and `system` (the default program) on both. Which ones a host offers: `editorPresetsFor`.
 */
export const EDITOR_PRESETS = [
  'notepadpp',
  'vscode',
  'custom',
  'system',
  'vscodium',
  'zed',
  'sublime',
  'kate',
  'gnome_text_editor',
  'gedit',
] as const;
export const editorPresetSchema = z.enum(EDITOR_PRESETS);
export type EditorPreset = z.infer<typeof editorPresetSchema>;

/** Presets with a detected program and fixed arguments (everything but `custom` and `system`). */
export type EditorProgramPreset = Exclude<EditorPreset, 'custom' | 'system'>;

/** Argument templates of the presets; placeholders {file} {line} {col} (a missing line/col is 1). */
export const EDITOR_PRESET_ARGS = {
  notepadpp: ['-n{line}', '-c{col}', '{file}'],
  vscode: ['--goto', '{file}:{line}:{col}'],
  vscodium: ['--goto', '{file}:{line}:{col}'],
  zed: ['{file}:{line}:{col}'],
  sublime: ['{file}:{line}:{col}'],
  kate: ['--line', '{line}', '--column', '{col}', '{file}'],
  // GNOME Text Editor documents no line argument: the file only.
  gnome_text_editor: ['{file}'],
  gedit: ['+{line}:{col}', '{file}'],
} as const satisfies Record<EditorProgramPreset, readonly string[]>;

const WINDOWS_EDITOR_PRESETS = ['notepadpp', 'vscode', 'custom', 'system'] as const;
const POSIX_EDITOR_PRESETS = [
  'vscode',
  'vscodium',
  'zed',
  'sublime',
  'kate',
  'gnome_text_editor',
  'gedit',
  'custom',
  'system',
] as const;

/** 102e: the presets a host of this path flavor offers, in display order. */
export function editorPresetsFor(flavor: PathFlavor): readonly EditorPreset[] {
  return flavor === 'win32' ? WINDOWS_EDITOR_PRESETS : POSIX_EDITOR_PRESETS;
}

/**
 * Never accepted as editor executable (base name, case-insensitive): shells, script hosts, LOLBins –
 * and GUI programs that execute or import the file they are given (R5-03: help files with script,
 * installers, snap-ins, `.reg` imports, control panel items, diagnostics packages, ISE).
 */
export const EDITOR_BLOCKED_EXECUTABLES = [
  'cmd.exe',
  'powershell.exe',
  'pwsh.exe',
  'wscript.exe',
  'cscript.exe',
  'mshta.exe',
  'rundll32.exe',
  'regsvr32.exe',
  'conhost.exe',
  'wsl.exe',
  'bash.exe',
  'explorer.exe',
  'hh.exe',
  'msiexec.exe',
  'mmc.exe',
  'regedit.exe',
  'control.exe',
  'msdt.exe',
  'powershell_ise.exe',
] as const;

/** "Open with default program" (`explorer.exe <file>`) only for these extensions (C.10, ADR-144). */
export const DEFAULT_PROGRAM_EXTENSIONS = [
  'txt',
  'md',
  'markdown',
  'json',
  'log',
  'csv',
  'png',
  'jpg',
  'jpeg',
  'gif',
  'webp',
  'bmp',
  'pdf',
] as const;

/**
 * Linux counterpart of `EDITOR_BLOCKED_EXECUTABLES` (WP-102, base name, case-insensitive, a trailing
 * version like `python3.12` ignored): shells, interpreters, wrappers that run another program, terminal
 * emulators and openers that hand the file to whatever program the desktop picks.
 */
export const EDITOR_BLOCKED_POSIX_EXECUTABLES = [
  // shells
  'sh',
  'bash',
  'dash',
  'zsh',
  'fish',
  'ksh',
  'mksh',
  'csh',
  'tcsh',
  'pwsh',
  'busybox',
  // interpreters
  'python',
  'perl',
  'ruby',
  'node',
  'nodejs',
  'deno',
  'bun',
  'php',
  'lua',
  'tclsh',
  'wish',
  'awk',
  'gawk',
  'mawk',
  'nawk',
  // wrappers that run another program
  'env',
  'sudo',
  'su',
  'doas',
  'pkexec',
  'runuser',
  'setsid',
  'nohup',
  'nice',
  'timeout',
  'xargs',
  'script',
  'ssh',
  'systemd-run',
  'flatpak',
  'snap',
  // terminal emulators
  'x-terminal-emulator',
  'gnome-terminal',
  'kgx',
  'ptyxis',
  'konsole',
  'xterm',
  'xfce4-terminal',
  'mate-terminal',
  'lxterminal',
  'tilix',
  'terminator',
  'kitty',
  'alacritty',
  'wezterm',
  'foot',
  'urxvt',
  'rxvt',
  // openers
  'xdg-open',
  'gio',
  'gnome-open',
  'kde-open',
  'kde-open5',
  'exo-open',
] as const;

/** The server checks the requested AND the resolved path (ADR-144); `rules` = those of the host. */
export function isDefaultProgramAllowed(path: string, rules: PathRules = WIN32_PATHS): boolean {
  return (DEFAULT_PROGRAM_EXTENSIONS as readonly string[]).includes(rules.extension(path));
}

export type EditorExecutableIssue = 'path' | 'not_exe' | 'blocked';

/**
 * Why an editor executable is not acceptable, or null. Windows: absolute `.exe`, not on the block list.
 * POSIX (WP-102): absolute and safe, not on the POSIX block list. `rules` = those of the host.
 */
export function editorExecutableIssue(
  executable: string,
  rules: PathRules = WIN32_PATHS,
): EditorExecutableIssue | null {
  if (!rules.isSafe(executable)) return 'path';
  const base = rules.baseName(executable).toLowerCase();
  if (rules.flavor === 'win32') {
    if (!/\.exe$/i.test(executable)) return 'not_exe';
    return (EDITOR_BLOCKED_EXECUTABLES as readonly string[]).includes(base) ? 'blocked' : null;
  }
  const unversioned = base.replace(/[\d.]+$/, '');
  const blocked = EDITOR_BLOCKED_POSIX_EXECUTABLES as readonly string[];
  return blocked.includes(base) || blocked.includes(unversioned) ? 'blocked' : null;
}

export const editorSettingsSchema = z
  .object({
    preset: editorPresetSchema,
    /** notepadpp/vscode: optional override of the detected exe; custom: required; system: ignored. */
    executable: z.string().min(1).max(LIMITS.pathChars).nullable(),
    /** custom only: one argument per element; at least one contains {file}. */
    args: z.array(z.string().min(1).max(LIMITS.profileArgChars)).max(LIMITS.editorArgsMax),
  })
  .superRefine((editor, ctx) => {
    if (editor.executable !== null) {
      // Shared by both kinds of host: the rules of the path's own shape; the host checks again with its
      // rules when saving (`settings.update`) and the UI with the rules of the host it edits (WP-102).
      const rules = pathRules(pathFlavorOfShape(editor.executable));
      const issue = editorExecutableIssue(editor.executable, rules);
      if (issue !== null) ctx.addIssue({ code: 'custom', path: ['executable'], message: issue });
    }
    if (editor.preset === 'custom') {
      if (editor.executable === null) {
        ctx.addIssue({ code: 'custom', path: ['executable'], message: 'required' });
      }
      if (!editor.args.some((arg) => arg.includes('{file}'))) {
        ctx.addIssue({ code: 'custom', path: ['args'], message: 'file_placeholder' });
      }
    }
  });
export type EditorSettings = z.infer<typeof editorSettingsSchema>;

/** Notepad++ (Plan "Dateien", WP-30 F1), detected exe, no custom arguments. */
export function defaultEditorSettings(): EditorSettings {
  return { preset: 'notepadpp', executable: null, args: [] };
}

// ---- Shell in the project folder (WP-97, ADR-238) ----

/** Shells on Windows (WP-97): cmd, Windows PowerShell 5.1, Git Bash. */
export const WINDOWS_SHELL_KINDS = ['cmd', 'powershell', 'gitbash'] as const;
/**
 * Shells on Linux (WP-102, WP-100 §5.4): `login` = the user's login shell (`$SHELL`, else the
 * passwd entry), plus bash, zsh, fish and PowerShell 7 (`pwsh`) where installed (`shell.detect`).
 */
export const POSIX_SHELL_KINDS = ['login', 'bash', 'zsh', 'fish', 'pwsh'] as const;
/** Every shell kind on the wire ("Open shell in folder", WP-97; embedded terminal, WP-99). */
export const SHELL_KINDS = [...WINDOWS_SHELL_KINDS, ...POSIX_SHELL_KINDS] as const;
export const shellKindSchema = z.enum(SHELL_KINDS);
export type ShellKind = z.infer<typeof shellKindSchema>;

/** The shell kinds a host of this flavor can offer (the installed ones come from `shell.detect`). */
export function shellKindsFor(flavor: PathFlavor): readonly ShellKind[] {
  return flavor === 'win32' ? WINDOWS_SHELL_KINDS : POSIX_SHELL_KINDS;
}

/** Default shell of a fresh host of this flavor (the settings default `cmd` is replaced on Linux). */
export function defaultShellFor(flavor: PathFlavor): ShellKind {
  return flavor === 'win32' ? 'cmd' : 'login';
}

/**
 * Window of Git Bash: `mintty` = `git-bash.exe` (like the Start menu shortcut "Git Bash"),
 * `terminal` = `bin\bash.exe` in the default terminal of Windows (Windows Terminal or the console host).
 */
export const GIT_BASH_WINDOWS = ['mintty', 'terminal'] as const;
export const gitBashWindowSchema = z.enum(GIT_BASH_WINDOWS);
export type GitBashWindow = z.infer<typeof gitBashWindowSchema>;

/** Settings "Console" (WP-97): a patch replaces the whole object – send every field. */
export const consoleSettingsSchema = z.object({
  defaultShell: shellKindSchema,
  gitBashWindow: gitBashWindowSchema,
  /**
   * Folder of Git for Windows (holds `git-bash.exe`); null = detected (shell.detect). Windows only:
   * stays Windows-strict, a Linux host keeps it null (WP-102).
   */
  gitDir: z
    .string()
    .min(1)
    .max(LIMITS.pathChars)
    .refine((value) => isSafeWindowsPath(value), 'path')
    .nullable(),
  /**
   * 102e: terminal emulator for the shell window and the external console on Linux (absolute path,
   * e.g. `/usr/bin/kitty`); null = detected (`xdg-terminal-exec`, `x-terminal-emulator`, known ones).
   * Checked by the rules of its own shape like the editor, but without the block list (terminal
   * emulators are exactly what is meant); the host checks again with its rules. Windows ignores it.
   */
  terminalEmulator: z
    .string()
    .min(1)
    .max(LIMITS.pathChars)
    .refine((value) => pathRules(pathFlavorOfShape(value)).isSafe(value), 'path')
    .nullable()
    .default(null),
});
export type ConsoleSettings = z.infer<typeof consoleSettingsSchema>;
export const DEFAULT_CONSOLE_SETTINGS = {
  defaultShell: 'cmd',
  gitBashWindow: 'mintty',
  gitDir: null,
  terminalEmulator: null,
} as const satisfies ConsoleSettings;

// ---- Remote Control (WP-64) ----

/**
 * Remote Control for NEW sessions: `follow_claude` = like `remoteControlAtStartup` in the user's
 * Claude settings (read after the first `init`, `HostState.remoteControlDefault`), `on`, `off`.
 * Existing sessions keep their own wish (`Entry.remoteControlWanted`).
 */
export const REMOTE_CONTROL_NEW_SESSIONS = ['follow_claude', 'on', 'off'] as const;
export const remoteControlNewSessionsSchema = z.enum(REMOTE_CONTROL_NEW_SESSIONS);
export type RemoteControlNewSessions = z.infer<typeof remoteControlNewSessionsSchema>;

export const remoteControlSettingsSchema = z.object({ newSessions: remoteControlNewSessionsSchema });
export type RemoteControlSettings = z.infer<typeof remoteControlSettingsSchema>;
export const DEFAULT_REMOTE_CONTROL_SETTINGS = { newSessions: 'follow_claude' } as const satisfies z.infer<
  typeof remoteControlSettingsSchema
>;

/**
 * A session link of the bridge (`session_url`): only `https://claude.ai/…` (or a subdomain) – the
 * UI opens nothing else, the server drops anything else (WP-64).
 */
export function isClaudeSessionUrl(value: string): boolean {
  return value.length <= 2000 && /^https:\/\/(?:[a-z0-9-]+\.)*claude\.ai(?:[/?#]\S*)?$/i.test(value);
}

export const claudeSessionUrlSchema = z
  .string()
  .refine(isClaudeSessionUrl, { message: 'not a claude.ai link' });

/**
 * WP-65 (1.6b): an absolute `http:`/`https:` URL (with a host) – the only links Parallax opens in the
 * default browser (`link.open`). Checked again by the server before anything starts.
 */
export function isHttpUrl(value: string): boolean {
  return value.length <= HTTP_URL_CHARS && HTTP_URL.test(value);
}

const HTTP_URL_CHARS = 4000;
/** Scheme, a host (no user info, no backslash), then path/query/fragment – no whitespace anywhere. */
const HTTP_URL = /^https?:\/\/[^\s/\\?#@]+(?:[/?#]\S*)?$/i;

export const httpUrlSchema = z.string().refine(isHttpUrl, { message: 'not an http(s) link' });

/** WP-65 (1.6): transcript view – `compact` groups the work steps (WP-63), `all` shows every step. */
export const TRANSCRIPT_VIEWS = ['compact', 'all'] as const;
export const transcriptViewSchema = z.enum(TRANSCRIPT_VIEWS);
export type TranscriptView = z.infer<typeof transcriptViewSchema>;

/**
 * WP-69 (1.3): which hook runs the transcript shows – `all` (every run; successful ones are work
 * steps), `failed` (default: only runs that did not succeed, blocking ones included) or `off` (none;
 * failed SessionStart/Setup hooks stay visible – start problems are never hidden).
 */
export const HOOK_DISPLAYS = ['all', 'failed', 'off'] as const;
export const hookDisplaySchema = z.enum(HOOK_DISPLAYS);
export type HookDisplay = z.infer<typeof hookDisplaySchema>;

/**
 * WP-92 (ADR-233): zoom of every window in percent – the root font size of the web UI (rem), the
 * steps Chrome offers between 50 and 200 %. Ctrl+wheel and Ctrl+Plus/Minus move one step, Ctrl+0
 * goes back to 100. Values between two steps are allowed (they snap to a step on the next move).
 */
export const ZOOM_LEVELS = [50, 67, 75, 80, 90, 100, 110, 125, 150, 175, 200] as const;
export const DEFAULT_ZOOM = 100;
export const MIN_ZOOM = 50;
export const MAX_ZOOM = 200;
export const zoomSchema = z.number().int().min(MIN_ZOOM).max(MAX_ZOOM);

/**
 * WP-87: npm registry for the Agent SDK of an update (e.g. a company mirror): https only (http only on
 * 127.0.0.1/localhost, a local test registry), no credentials in the URL – they stay in `~/.npmrc`
 * (auth for exactly that host, install/npmrc.ts), never in settings.json.
 */
const NPM_REGISTRY_URL =
  /^(?:https:\/\/[^/?#@\s]+|http:\/\/(?:127\.0\.0\.1|localhost)(?::\d{1,5})?)(?:[/?#]\S*)?$/iu;
export const npmRegistryUrlSchema = z
  .string()
  .trim()
  .pipe(
    z
      .url()
      .max(2048)
      .refine((value) => NPM_REGISTRY_URL.test(value), 'https URL without credentials'),
  );

/**
 * WP-87: `check` – look for new releases (start + every 12 h, only in a package; "Check now" works
 * anyway); `registry` – where updates fetch the Agent SDK, null = the npm configuration (`~/.npmrc`,
 * `NPM_CONFIG_REGISTRY`). Send both fields on every update (a missing `registry` means null).
 */
export const updateSettingsSchema = z.object({
  check: z.boolean(),
  registry: npmRegistryUrlSchema.nullable().default(null),
});
export const DEFAULT_UPDATE_SETTINGS = { check: true, registry: null } as const satisfies z.infer<
  typeof updateSettingsSchema
>;

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
  /** Phase 3 (ADR-144): takes effect at the next `file.open`. */
  editor: editorSettingsSchema,
  /** WP-64: Remote Control for new sessions (existing ones keep their own wish). */
  remoteControl: remoteControlSettingsSchema,
  /** WP-65: transcript view of every window (was localStorage `parallax.transcript.view`, WP-63). */
  transcriptView: transcriptViewSchema,
  /** WP-69: hook runs in the transcript of every window. */
  hookDisplay: hookDisplaySchema,
  /** WP-87: automatic update check; a patch replaces the whole object. */
  updates: updateSettingsSchema,
  /** WP-92: zoom of every window in percent (ZOOM_LEVELS). */
  zoom: zoomSchema,
  /** WP-97: "Open shell in folder" – default shell, window of Git Bash, Git folder. */
  console: consoleSettingsSchema,
};

export const settingsSchema = z.object({
  language: settingsFields.language.default('en'),
  theme: settingsFields.theme.default('dark'),
  notifications: notificationSettingsSchema.default(DEFAULT_NOTIFICATION_SETTINGS),
  idleSleep: idleSleepSchema.default(DEFAULT_IDLE_SLEEP),
  promptSuggestions: z.boolean().default(false),
  port: portSettingSchema.default(null),
  autostart: autostartSchema.default(DEFAULT_AUTOSTART),
  editor: editorSettingsSchema.default(defaultEditorSettings),
  remoteControl: remoteControlSettingsSchema.default(DEFAULT_REMOTE_CONTROL_SETTINGS),
  transcriptView: transcriptViewSchema.default('compact'),
  hookDisplay: hookDisplaySchema.default('failed'),
  updates: updateSettingsSchema.default(DEFAULT_UPDATE_SETTINGS),
  zoom: settingsFields.zoom.default(DEFAULT_ZOOM),
  console: consoleSettingsSchema.default(DEFAULT_CONSOLE_SETTINGS),
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
// 5.8b Several computers (WP-75/76, docs/wp/WP-76.md §C; ADR-205 … 211, 224 … 226)
// =====================================================================================

/**
 * `off` (default) – `share`: this computer can be controlled by exactly one other computer –
 * `control`: this computer controls others. Exclusive (ADR-224): the server refuses a switch between
 * `share` and `control` while the old role still has a coupling (REMOTE_ROLE_CONFLICT).
 */
export const MULTI_HOST_ROLES = ['off', 'share', 'control'] as const;
export const multiHostRoleSchema = z.enum(MULTI_HOST_ROLES);
export type MultiHostRole = z.infer<typeof multiHostRoleSchema>;

/** Default TCP port of the remote-access listener of a sharing computer. */
export const REMOTE_ACCESS_DEFAULT_PORT = 4713;

/**
 * `PARALLAX_HOME/multi-host.json` (not part of settings.json: only `multiHost.configure` changes it,
 * never `settings.update`). `port`/`bindAddress` only matter for `share`; `0.0.0.0` = every IPv4
 * address of this computer.
 */
export const multiHostConfigSchema = z.object({
  role: multiHostRoleSchema.default('off'),
  port: z.number().int().min(1024).max(65535).default(REMOTE_ACCESS_DEFAULT_PORT),
  bindAddress: z.ipv4().default('0.0.0.0'),
});
export type MultiHostConfig = z.infer<typeof multiHostConfigSchema>;
export const DEFAULT_MULTI_HOST_CONFIG: MultiHostConfig = multiHostConfigSchema.parse({});

export const MULTI_HOST_SCHEMA_VERSION = 1;
export const multiHostFileSchema = z.object({
  schemaVersion: z.literal(MULTI_HOST_SCHEMA_VERSION),
  config: multiHostConfigSchema,
});
export type MultiHostFile = z.infer<typeof multiHostFileSchema>;

/** Colors of computers (badge, group header); the web maps them to design tokens. */
export const HOST_COLORS = ['blue', 'green', 'amber', 'violet', 'rose', 'teal', 'orange', 'slate'] as const;
export const hostColorSchema = z.enum(HOST_COLORS);
export type HostColor = z.infer<typeof hostColorSchema>;

/** Host id of another computer (the client-side `hostId` of its sessions); never `local`. */
export const remoteHostIdSchema = hostIdSchema.refine((id) => id !== LOCAL_HOST_ID, { message: 'reserved' });

/** Display name of a computer (user input; also the unverified name in a pairing request). */
export const hostNameSchema = z.string().trim().min(1).max(LIMITS.hostNameChars);
/** Computer name, IPv4 or IPv6 as typed – no scheme, no port, no path, no whitespace. */
export const hostAddressSchema = z
  .string()
  .trim()
  .min(1)
  .max(LIMITS.hostAddressChars)
  .regex(/^[A-Za-z0-9.:%[\]-]+$/u);
export const remotePortSchema = z.number().int().min(1).max(65535);

/** SHA-384 over the SPKI DER of a public key (WP-76 §B.4), lower-case hex. */
export const keyPinSchema = z.string().regex(/^[0-9a-f]{96}$/u);
/** A DER certificate, base64 (ML-DSA-87 certificates are ~7.4 KB). */
export const certificateDerSchema = z
  .string()
  .max(20_000)
  .regex(/^[A-Za-z0-9+/]+={0,2}$/u);
/** A DPAPI ciphertext (WP-76 §B.5), base64 – never the plaintext. */
export const protectedSecretSchema = z
  .string()
  .max(100_000)
  .regex(/^[A-Za-z0-9+/]+={0,2}$/u);

// ---- controlling computer ----

export const REMOTE_HOST_STATUSES = [
  'connecting',
  'connected',
  'unreachable',
  'incompatible',
  'revoked',
] as const;
export const remoteHostStatusSchema = z.enum(REMOTE_HOST_STATUSES);
export type RemoteHostStatus = z.infer<typeof remoteHostStatusSchema>;

/** `HostState.remoteHosts[]` of a controlling computer (never keys, pins or certificates). */
export const remoteHostSchema = z.object({
  /** Client-side host id of its sessions (`hostId:entryId`); never `local`. */
  hostId: remoteHostIdSchema,
  name: hostNameSchema,
  color: hostColorSchema,
  address: hostAddressSchema,
  port: remotePortSchema,
  status: remoteHostStatusSchema,
  /** Parallax version of the other computer (last health answer); null = not known yet. */
  appVersion: z.string().max(64).nullable(),
  protocolVersion: z.number().int().positive().nullable(),
  lastError: errorPayloadSchema.nullable(),
  lastConnectedAt: isoDateTimeSchema.nullable(),
  addedAt: isoDateTimeSchema,
});
export type RemoteHost = z.infer<typeof remoteHostSchema>;

/** One computer of `PARALLAX_HOME/hosts.json`; its coupling key is a key file (`keyFileSchema`). */
export const hostRecordSchema = z.object({
  hostId: remoteHostIdSchema,
  name: hostNameSchema,
  color: hostColorSchema,
  address: hostAddressSchema,
  port: remotePortSchema,
  peerPin: keyPinSchema,
  peerCertificate: certificateDerSchema,
  /** DPAPI(kAuth) – the coupling secret of the connection proof (WP-76 §B.9), purpose `auth:<hostId>`. */
  authKey: protectedSecretSchema,
  addedAt: isoDateTimeSchema,
  lastConnectedAt: isoDateTimeSchema.nullable().default(null),
});
export type HostRecord = z.infer<typeof hostRecordSchema>;

export const HOSTS_SCHEMA_VERSION = 1;
export const hostsFileSchema = z.object({
  schemaVersion: z.literal(HOSTS_SCHEMA_VERSION),
  /** In display order (sidebar groups after this computer). */
  hosts: z.array(hostRecordSchema).max(LIMITS.hostsMax),
});
export type HostsFile = z.infer<typeof hostsFileSchema>;

// ---- sharing computer ----

/**
 * Checks shown when "Share" is switched on (WP-75 §4.2); the UI translates `id` + `status`. No
 * firewall check (ADR-228): the Windows Firewall is the user's to set up, the UI only hints at it.
 */
export const REMOTE_ACCESS_CHECK_IDS = ['port', 'keys', 'keystore', 'tls', 'addresses'] as const;
export const remoteAccessCheckSchema = z.object({
  id: z.enum(REMOTE_ACCESS_CHECK_IDS),
  status: z.enum(['ok', 'warning', 'error']),
  params: paramsSchema.default({}),
});
export type RemoteAccessCheck = z.infer<typeof remoteAccessCheckSchema>;

/**
 * Level of the one coupling (WP-102, WP-76 §B.13): `control` = sessions, files, terminal (as before);
 * `manage` = also settings, profiles, updates, server, role and the coupling itself
 * (`REMOTE_MANAGE_COMMANDS`). Chosen on site when the pairing window opens; never raised remotely.
 */
export const REMOTE_PEER_LEVELS = ['control', 'manage'] as const;
export const remotePeerLevelSchema = z.enum(REMOTE_PEER_LEVELS);
export type RemotePeerLevel = z.infer<typeof remotePeerLevelSchema>;

/** The coupled controlling computer as the sharing computer shows it. */
export const remotePeerSchema = z.object({
  name: hostNameSchema,
  /** WP-102: what it may do here (default for older servers: `control`). */
  level: remotePeerLevelSchema.default('control'),
  pairedAt: isoDateTimeSchema,
  /** At least one connection of it is open. */
  connected: z.boolean(),
  connections: z.number().int().nonnegative(),
  lastSeenAt: isoDateTimeSchema.nullable(),
  lastAddress: z.string().max(64).nullable(),
  /** Parallax version it sent with its last request; null = not seen yet. */
  appVersion: z.string().max(64).nullable(),
  /** False when its version or protocol differs (it is refused until both match). */
  compatible: z.boolean(),
});
export type RemotePeer = z.infer<typeof remotePeerSchema>;

/** `HostState.remoteAccess` of a sharing computer (null for the other roles). */
export const remoteAccessStateSchema = z.object({
  listening: z.boolean(),
  port: remotePortSchema.nullable(),
  /** Detected IPv4 addresses of this computer (display for the pairing). */
  addresses: z.array(z.string().max(64)).max(32),
  /** Windows computer name (display for the pairing). */
  hostName: z.string().max(LIMITS.hostAddressChars),
  checks: z.array(remoteAccessCheckSchema),
  peer: remotePeerSchema.nullable(),
  /** End of an open pairing window; the code itself only goes to the asking window (ack). */
  pairingExpiresAt: isoDateTimeSchema.nullable(),
  /** Rejected connection attempts since the log was last marked seen. */
  unseenRejected: z.number().int().nonnegative(),
  /** Why the listener is not running (REMOTE_ACCESS_FAILED, REMOTE_KEYSTORE_UNAVAILABLE …). */
  error: errorPayloadSchema.nullable(),
});
export type RemoteAccessState = z.infer<typeof remoteAccessStateSchema>;

/** `PARALLAX_HOME/remote/peer.json`: the one coupled computer (WP-76 §B.7 step 7). */
export const REMOTE_PEER_SCHEMA_VERSION = 1;
export const remotePeerRecordSchema = z.object({
  name: hostNameSchema,
  pin: keyPinSchema,
  certificate: certificateDerSchema,
  /** DPAPI(kAuth) – the coupling secret of the connection proof (WP-76 §B.9), purpose `auth:peer`. */
  authKey: protectedSecretSchema,
  /** WP-102: level bound to the pairing window; couplings from before WP-102 are `control`. */
  level: remotePeerLevelSchema.default('control'),
  pairedAt: isoDateTimeSchema,
  lastSeenAt: isoDateTimeSchema.nullable().default(null),
  lastAddress: z.string().max(64).nullable().default(null),
});
export type RemotePeerRecord = z.infer<typeof remotePeerRecordSchema>;
export const remotePeerFileSchema = z.object({
  schemaVersion: z.literal(REMOTE_PEER_SCHEMA_VERSION),
  peer: remotePeerRecordSchema.nullable(),
  /** Pins of the last revoked couplings (connection log `revoked_key` instead of `unknown_key`). */
  revoked: z.array(keyPinSchema).max(8).default([]),
});
export type RemotePeerFile = z.infer<typeof remotePeerFileSchema>;

/** Connection log of a sharing computer (WP-75 §3.7, ADR-225). */
export const REMOTE_EVENT_KINDS = [
  'pair_ok',
  'pair_failed',
  'pair_expired',
  'pair_rate_limited',
  'unknown_key',
  'revoked_key',
  'bad_certificate',
  'proof_failed',
  'tls_failed',
  'rate_limited',
  'browser_rejected',
  'version_mismatch',
  'connected',
  'disconnected',
  'unpaired',
  // WP-102 (WP-76 §B.13): level change, a command of the level `manage`, a terminal started remotely.
  'level_changed',
  'manage_command',
  'terminal_opened',
] as const;
export const remoteEventKindSchema = z.enum(REMOTE_EVENT_KINDS);
export type RemoteEventKind = z.infer<typeof remoteEventKindSchema>;

/** The kinds that count as a rejected attempt ("only rejected", header hint). */
export const REJECTED_REMOTE_EVENT_KINDS = [
  'pair_failed',
  'pair_expired',
  'pair_rate_limited',
  'unknown_key',
  'revoked_key',
  'bad_certificate',
  'proof_failed',
  'tls_failed',
  'rate_limited',
  'browser_rejected',
  'version_mismatch',
] as const satisfies readonly RemoteEventKind[];

export const remoteEventSchema = z.object({
  id: z.string().min(1).max(64),
  kind: remoteEventKindSchema,
  /** First occurrence; equal kinds from one address within a minute raise `count` and `lastAt`. */
  at: isoDateTimeSchema,
  lastAt: isoDateTimeSchema,
  count: z.number().int().positive(),
  /** Remote IP address. */
  address: z.string().max(64),
  port: z.number().int().min(0).max(65535).nullable(),
  /** Name the other side gave (pairing request); unverified unless the kind is `pair_ok`. */
  claimedName: hostNameSchema.nullable(),
  /**
   * WP-102: what happened, without content – `manage_command`: the command name; `level_changed`:
   * `control>manage` / `manage>control`. Rows merge only with an equal detail.
   */
  detail: z.string().max(64).nullable().default(null),
  rejected: z.boolean(),
});
export type RemoteEvent = z.infer<typeof remoteEventSchema>;

export const REMOTE_EVENTS_SCHEMA_VERSION = 1;
export const remoteEventsFileSchema = z.object({
  schemaVersion: z.literal(REMOTE_EVENTS_SCHEMA_VERSION),
  /** Newest last; at most LIMITS.remoteEventsMax, none older than LIMITS.remoteEventsDays. */
  events: z.array(remoteEventSchema).max(LIMITS.remoteEventsMax),
  /** `remoteAccess.eventsSeen`: rejected events after this count as unseen. */
  seenAt: isoDateTimeSchema.nullable().default(null),
});
export type RemoteEventsFile = z.infer<typeof remoteEventsFileSchema>;

/**
 * A private key protected by the key store (WP-76 §B.5, DPAPI CurrentUser): `purpose` `identity`
 * (sharing computer) or `coupling:<hostId>` (controlling computer); `protected` = DPAPI ciphertext of
 * the PKCS#8 DER (base64); `certificate` = the own self-signed certificate (public).
 */
export const KEY_FILE_SCHEMA_VERSION = 1;
export const keyPurposeSchema = z.string().regex(/^(?:identity|coupling:[a-z0-9][a-z0-9-]{0,31})$/u);
export const keyFileSchema = z.object({
  schemaVersion: z.literal(KEY_FILE_SCHEMA_VERSION),
  purpose: keyPurposeSchema,
  algorithm: z.literal('ml-dsa-87'),
  protected: protectedSecretSchema,
  certificate: certificateDerSchema,
  createdAt: isoDateTimeSchema,
});
export type KeyFile = z.infer<typeof keyFileSchema>;

// =====================================================================================
// 5.9 Host state
// =====================================================================================

export const hostWarningSchema = z.object({
  id: z.string(),
  error: errorPayloadSchema,
  at: isoDateTimeSchema,
});
export type HostWarning = z.infer<typeof hostWarningSchema>;

// ---- WP-87: updates in the app (docs/wp/WP-87.md §1.1, ADR-220) ----

/** A release version `X.Y.Z` or `X.Y.Z-rc.N` (tag `v<version>`); launcher/release.ts uses it. */
export const appVersionSchema = z.string().regex(/^\d+\.\d+\.\d+(?:-rc\.\d+)?$/u);
export type AppVersion = z.infer<typeof appVersionSchema>;

/** The running Parallax. */
export const appInfoSchema = z.object({
  /** package.json version (in a package the version of release.json). */
  version: z.string().min(1).max(64),
  buildId: z.string().min(1).max(LIMITS.buildIdChars),
  /** release.json next to dist/ and `--install-root` (an installation); false = checkout, dev. */
  packaged: z.boolean(),
});
export type AppInfo = z.infer<typeof appInfoSchema>;

/**
 * `unsupported` = no installation (checkout, dev: updates via git); `ready` = prepared in the
 * version folder, a restart switches; `restarting` = the orchestrator took over (the server exits).
 */
export const UPDATE_STATUSES = [
  'unsupported',
  'idle',
  'checking',
  'available',
  'downloading',
  'preparing',
  'ready',
  'restarting',
] as const;
export const updateStatusSchema = z.enum(UPDATE_STATUSES);
export type UpdateStatus = z.infer<typeof updateStatusSchema>;

/** A version the user can switch to: offered by the releases or uploaded from a file. */
export const updateReleaseSchema = z.object({
  version: appVersionSchema,
  /** `github` = latest.json of the releases; `file` = "Install from file" (WP-83 §9.6). */
  source: z.enum(['github', 'file']),
  /** Zip bytes (github); null for a file. */
  size: z.number().int().nonnegative().nullable(),
  createdAt: isoDateTimeSchema,
  /** Older than the running version (only from a file). */
  downgrade: z.boolean(),
  /** Older AND other store schema hashes: only with the backup, data since then are lost (WP-83 §9.4). */
  needsRestore: z.boolean(),
  /** createdAt of that backup; null = none. */
  backupAt: isoDateTimeSchema.nullable(),
});
export type UpdateRelease = z.infer<typeof updateReleaseSchema>;

/** `current.json` `previous` with an intact version folder ("Back to <version>"). */
export const updatePreviousSchema = updateReleaseSchema.pick({
  version: true,
  needsRestore: true,
  backupAt: true,
});
export type UpdatePrevious = z.infer<typeof updatePreviousSchema>;

export const updateStateSchema = z.object({
  status: updateStatusSchema.default('unsupported'),
  /** 0…1 while downloading/preparing; null = unknown or idle. */
  progress: z.number().min(0).max(1).nullable().default(null),
  checkedAt: isoDateTimeSchema.nullable().default(null),
  available: updateReleaseSchema.nullable().default(null),
  previous: updatePreviousSchema.nullable().default(null),
  /** After a version change (update, rollback, install.cmd) until update.dismiss or the next start. */
  justUpdated: z
    .object({ from: appVersionSchema.nullable(), to: appVersionSchema, at: isoDateTimeSchema })
    .nullable()
    .default(null),
  /** The last switch failed and the orchestrator went back; `log` = absolute path, local display only. */
  failedUpdate: z
    .object({
      version: appVersionSchema,
      restoredTo: appVersionSchema,
      at: isoDateTimeSchema,
      error: errorPayloadSchema,
      log: z.string().max(LIMITS.pathChars).nullable(),
    })
    .nullable()
    .default(null),
  /** Last failure of check/prepare/upload/apply (an automatic check never shows a hint for it). */
  error: errorPayloadSchema.nullable().default(null),
  /** The header hint for this version was dismissed (update-state.json in the data directory). */
  dismissedVersion: appVersionSchema.nullable().default(null),
});
export type UpdateState = z.infer<typeof updateStateSchema>;
export const DEFAULT_UPDATE_STATE: UpdateState = updateStateSchema.parse({});

/**
 * What the host's desktop can do (WP-102, WP-100 §3.3): the UI shows desktop actions only where
 * the host has them – a Linux server without a desktop has none of these. Session features
 * (transcript, files, terminal) are not listed here (`terminalAvailable`, `fileOpenAvailable`, …).
 */
export const hostCapabilitiesSchema = z.object({
  /** A local desktop session (Chrome window, notifications, programs). False in server mode. */
  desktop: z.boolean(),
  /** "Open in external console" (`session.openExternal`). */
  externalConsole: z.boolean(),
  /** "Open shell in folder" as a window (`session.openShell`, WP-97). */
  shellWindow: z.boolean(),
  /** Open files in an editor / the default program (`file.open`). */
  editor: z.boolean(),
  /** "Show in folder" (Explorer, file manager). */
  fileManager: z.boolean(),
  /** Start with the user's login (Windows shortcut, XDG autostart or the systemd user service). */
  autostart: z.boolean(),
  /** `parallax:` links. */
  protocolHandler: z.boolean(),
});
export type HostCapabilities = z.infer<typeof hostCapabilitiesSchema>;
/** Default for servers that do not send capabilities: every one of them runs on Windows with a desktop. */
export const WINDOWS_HOST_CAPABILITIES = {
  desktop: true,
  externalConsole: true,
  shellWindow: true,
  editor: true,
  fileManager: true,
  autostart: true,
  protocolHandler: true,
} as const satisfies HostCapabilities;

export const hostStateSchema = z.object({
  /** package.json version. */
  serverVersion: z.string(),
  /** 0.3.296 */
  sdkVersion: z.string(),
  /** Minimum CLI according to the SDK manifest. */
  sdkClaudeCodeVersion: z.string(),
  /** `process.platform` of the host ('win32', 'linux'); picks the path rules (`pathFlavorOf`, WP-102). */
  platform: z.string(),
  /** WP-102: desktop actions of this host; absent (older servers, all Windows) → everything available. */
  capabilities: hostCapabilitiesSchema.default(WINDOWS_HOST_CAPABILITIES),
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
  /**
   * WP-64: `remoteControlAtStartup` of the default profile's Claude settings as the CLI reported it
   * (`getSettings`, read after a session's `init`); null = not read yet / not available. Shown next
   * to the setting `remoteControl.newSessions: follow_claude`.
   */
  remoteControlDefault: z.boolean().nullable().default(null),
  /** WP-87: the running Parallax; null = an older host. */
  app: appInfoSchema.nullable().default(null),
  /** WP-87: update check, preparation and the outcome of the last switch. */
  update: updateStateSchema.default(DEFAULT_UPDATE_STATE),
  /** WP-76: role and listener settings of "Several computers" (multi-host.json). */
  multiHost: multiHostConfigSchema.default(DEFAULT_MULTI_HOST_CONFIG),
  /** WP-76: the computers this one controls (role `control`), in display order; [] otherwise. */
  remoteHosts: z.array(remoteHostSchema).max(LIMITS.hostsMax).default([]),
  /** WP-76: remote access of a sharing computer (role `share`); null otherwise. */
  remoteAccess: remoteAccessStateSchema.nullable().default(null),
  /**
   * WP-99 (ADR-239): the embedded terminal works on this computer (ConPTY through `node:ffi` on
   * Windows, a POSIX pty on Linux). The panel tab "Terminal" appears only when true – for sessions of
   * this computer and, through the relay, of a paired one (ADR-244).
   */
  terminalAvailable: z.boolean().default(false),
  /**
   * 102e: home folder of the host's user (`os.homedir()`, only if safe by the host's path rules), so
   * the web resolves `~/…` in the transcript outside the `cwd`; null = unknown (older hosts).
   */
  homeDir: z.string().min(1).max(LIMITS.pathChars).nullable().default(null),
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
  /**
   * WP-64: Remote Control bridge session of this conversation (`bridge_session_id`, e.g.
   * `cse_…`) – passed as `reattachSessionId` on the next start, so the Claude app keeps ONE entry.
   * null = never connected. A new conversation (/clear, fresh context) takes the live one over.
   */
  bridgeSessionId: z.string().min(1).max(200).nullable().default(null),
  /** WP-64: its link in claude.ai / the Claude app (`https://claude.ai/code/session_…`). */
  sessionUrl: claudeSessionUrlSchema.nullable().default(null),
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
  /**
   * 102e "Continue in terminal" (`session.openInTerminal`): the embedded terminal running `claude`;
   * null = a visible console (`session.openExternal`). Watched through the terminal service: an
   * unknown terminal (closed, server restarted) counts as ended.
   */
  terminalId: terminalIdSchema.nullable().default(null),
});
export type ExternalHandoff = z.infer<typeof externalHandoffSchema>;

/**
 * WP-65: the summary of the last turn – from the CLI (`system/post_turn_summary`, only while a Remote
 * Control bridge is connected; English text as sent) or Parallax's fallback (first meaningful line of
 * the last answer). `category` = the CLI's `status_category` (open set, e.g. `completed`);
 * `needsAction` = the CLI says the user has to act. Persisted, kept until the next turn replaces it.
 */
export const turnSummarySchema = z.object({
  source: z.enum(['claude', 'parallax']),
  text: z.string().max(500),
  category: z.string().max(100).nullable(),
  needsAction: z.boolean(),
  at: isoDateTimeSchema,
});
export type TurnSummary = z.infer<typeof turnSummarySchema>;

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
  /**
   * WP-73: the model the entry runs on while `modelSetting` is null – the profile's `--model`, else
   * what Claude's own settings name (`ANTHROPIC_MODEL`, settings `model`, e.g. 'opusplan'); read
   * after each readiness and model refresh. null = none named (the CLI default) or not read yet.
   */
  claudeModel: modelNameSchema.nullable().default(null),
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
  /**
   * WP-64: the user wants Remote Control for this session. A running process is switched at once,
   * otherwise at the next start/resume/wake-up (with the conversation's `bridgeSessionId`).
   */
  remoteControlWanted: z.boolean().default(false),
  /** WP-65: summary of the last turn (CLI or fallback); null before the first turn. */
  turnSummary: turnSummarySchema.nullable().default(null),
  /**
   * WP-65: when a visible window last stopped showing the entry (presence ended) – or the moment of
   * a prompt/answer from the Claude app (Remote Control: who answers there has seen it). Unchanged
   * while a window shows it; null = never left a window since this field exists.
   */
  lastSeenAt: isoDateTimeSchema.nullable().default(null),
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
  z.object({
    type: z.literal('plan_approved'),
    mode: permissionModeSchema,
    edited: z.boolean(),
    /** Phase 3 (ADR-147): implemented in a fresh session (new conversation). */
    freshContext: z.boolean().default(false),
  }),
  z.object({ type: z.literal('plan_revised') }),
  z.object({ type: z.literal('cancelled'), reason: z.enum(CANCEL_REASONS) }),
  /** After a restart (A.10). */
  z.object({ type: z.literal('expired') }),
  /**
   * WP-64: answered in the Claude app (Remote Control connected, the CLI aborted the request and no
   * local answer came) – the following tool_result shows what was decided.
   */
  z.object({ type: z.literal('answered_elsewhere') }),
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
  /** 'other' = not typed by the user (channel, another session, coordinator, automatic notification). */
  origin: z.enum(['human', 'other']).default('human'),
  /**
   * WP-72: the SDK's `origin.kind` of a message with `origin: 'other'` ('peer', 'coordinator',
   * 'task-notification', 'channel' …; free text, the UI names the known kinds); null for the user's own
   * messages, messages without an origin and older items.
   */
  originKind: z.string().nullable().default(null),
  /** '/clear', '/rename' … when the text starts with '/'. */
  slashCommand: z.string().nullable().default(null),
  /** As sent. */
  priority: promptPrioritySchema.nullable().default(null),
  /**
   * WP-64: where the prompt was typed – `remote` = in claude.ai / the Claude app (Remote Control:
   * a replayed `user` with `origin.kind 'human'` and a uuid Parallax never sent).
   */
  source: z.enum(['local', 'remote']).default('local'),
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
  /** Phase 3: `task_notification.output_file` / `AgentOutput.outputFile` (absolute; '' → null). */
  outputFile: z.string().nullable().default(null),
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
  /**
   * WP-95: the CLI's automatic permission check (auto-mode classifier) has kept the call waiting
   * longer than usual (`system/permission_check_status` 'checking' until its 'done'). Most checks
   * answer within about four seconds and never set it. Says nothing about the outcome.
   */
  permissionCheck: z.boolean().default(false),
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
  /**
   * WP-63: only `rejected` (C.5) – older logs may still hold `allowed_warning` items; the UI does
   * not render them (the limit bar shows every value).
   */
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
    /** WP-69: `hook_response.exit_code` (2 = blocking); null while running or unknown (older logs). */
    exitCode: z.number().int().nullable().default(null),
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
  /**
   * WP-95: `system/file_attachments_missing` – files a message sent by reference (Remote Control,
   * Claude Code Remote) did not arrive where Claude can read them; the turn runs on without them.
   */
  systemBase.extend({
    event: z.literal('attachments_missing'),
    /** Well-formed file references of that message. */
    sentCount: z.number().int().nonnegative(),
    /** Distinct files that did not arrive. */
    missingCount: z.number().int().nonnegative(),
  }),
  /**
   * WP-95: `system/peer_message_hold` – a message from another session that the receive-side policy
   * held instead of queueing; one item per message, upserted when the hold resolves.
   */
  systemBase.extend({
    event: z.literal('peer_message_hold'),
    /** held | released | dropped (open set). */
    state: z.string(),
    /** Sender address as the CLI reports it (session or agent id, free text). */
    from: z.string(),
    /** Display name of the sender; null = not reported. */
    fromName: z.string().nullable(),
    /** Why it is held (`explicit-setting`, `managed-setting`, `mode-mismatch` …, open set); null = not reported. */
    cause: z.string().nullable(),
    /** Only for `dropped`: `expired`, `refused`, `dropped`, `discarded` (open set); null otherwise. */
    outcome: z.string().nullable(),
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

export const SIDE_QUESTION_STATUSES = ['pending', 'answered', 'failed', 'cancelled'] as const;
export const sideQuestionStatusSchema = z.enum(SIDE_QUESTION_STATUSES);
export type SideQuestionStatus = z.infer<typeof sideQuestionStatusSchema>;

/**
 * WP-66: a side question (`/btw`, the CLI's internal `askSideQuestion`): asked from the current
 * conversation state, answered without tools and never part of the conversation (Parallax keeps it
 * in its own transcript log only). Created by the ENGINE (not the normalizer); follow-ups of a thread
 * share `threadId` = the item id of the thread's first question.
 */
export const sideQuestionItemSchema = z.object({
  ...itemBase,
  kind: z.literal('side_question'),
  threadId: itemIdSchema,
  question: z.string().min(1).max(LIMITS.sideQuestionChars),
  status: sideQuestionStatusSchema,
  /** The answer (Markdown, never capped like assistant text); null while pending, on failure or no answer. */
  response: z.string().nullable().default(null),
  /** The CLI had no real answer (e.g. no conversation yet, or a synthetic reply). */
  synthetic: z.boolean().default(false),
  /** `refusalFallback.fallbackModel`: another model answered after a refusal. */
  fallbackModel: z.string().nullable().default(null),
  /** Retry of the request while pending (`control_request_progress api_retry`); null otherwise. */
  retry: z
    .object({ attempt: z.number().int().nonnegative(), maxRetries: z.number().int().nonnegative() })
    .nullable()
    .default(null),
  /** Why it failed (`failed`): SESSION_BUSY, CLAUDE_CONTROL_FAILED, the process ended … */
  error: errorPayloadSchema.nullable().default(null),
  answeredAt: isoDateTimeSchema.nullable().default(null),
});
export type SideQuestionItem = z.infer<typeof sideQuestionItemSchema>;

/** Discriminator `kind`; system items additionally by `event`. */
export const transcriptItemSchema = z.discriminatedUnion('kind', [
  userMessageItemSchema,
  assistantTextItemSchema,
  thinkingItemSchema,
  toolCallItemSchema,
  systemItemSchema,
  turnResultItemSchema,
  sideQuestionItemSchema,
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

/** WP-93 (ADR-234): a comment on a passage, or "strike" (the passage should go; the comment is the reason). */
export const PLAN_ANNOTATION_KINDS = ['comment', 'strike'] as const;
export const planAnnotationKindSchema = z.enum(PLAN_ANNOTATION_KINDS);
export type PlanAnnotationKind = z.infer<typeof planAnnotationKindSchema>;

/**
 * WP-93 (ADR-234): one annotation of a plan version, made in the plan tab. Anchored to a block of the
 * plan text (the web splits it like the plan tab renders it) and – for a marked passage – to the
 * rendered text of that block (`quote` plus the text around it, which finds the right occurrence).
 * `quote` '' = the whole block. The server only stores and returns annotations; the window builds
 * the feedback of "Keep planning" from them.
 */
export const planAnnotationSchema = z.object({
  /** Made by the window (`pa_…`), unique within the decision. */
  id: z.string().min(1).max(64),
  kind: planAnnotationKindSchema,
  /** Index of the block in the plan text (0-based). */
  block: z.number().int().nonnegative().max(1_000_000),
  /** The marked text as rendered; '' = the whole block. */
  quote: z.string().max(LIMITS.planAnnotationQuoteChars),
  /** Up to 32 characters of the block's text right before / after the quote. */
  prefix: z.string().max(LIMITS.planAnnotationContextChars).default(''),
  suffix: z.string().max(LIMITS.planAnnotationContextChars).default(''),
  /** The comment; for `strike` the optional reason (''). */
  comment: z.string().max(LIMITS.planAnnotationChars),
  createdAt: isoDateTimeSchema,
});
export type PlanAnnotation = z.infer<typeof planAnnotationSchema>;

export const planAnnotationsSchema = z.array(planAnnotationSchema).max(LIMITS.planAnnotations);

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
  /**
   * WP-93 (ADR-234): the annotations of this version so far (`decision.annotatePlan` replaces them,
   * every window gets the new state as `decision.upsert`). They stay in the record after the answer
   * (`plan.read`).
   */
  annotations: planAnnotationsSchema.default([]),
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
  /**
   * Phase 3 (ADR-147): deny + interrupt the open request, close the process, start a new
   * conversation in `mode` with the plan (or `editedPlan`) as its first prompt.
   */
  z.object({
    behavior: z.literal('approve_fresh_context'),
    mode: permissionModeSchema,
    editedPlan: z.string().max(LIMITS.planChars).nullable().default(null),
  }),
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
  /**
   * WP-93 (ADR-234): annotations of a plan decision while it is open; after the answer kept only
   * when it was "Keep planning" (`plan_revised`, the snapshot above is dropped then), so `plan.read`
   * still knows what was sent with it; any other answer empties the list.
   */
  annotations: planAnnotationsSchema.default([]),
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

/**
 * WP-64: Remote Control bridge state of the running process. `off` = not connected (no process, or
 * not wanted); `connecting` = switched on, the bridge is not up yet; `reconnecting` = it was up and
 * reconnects; `failed` = switching on failed or the connection is lost (`error`).
 */
export const REMOTE_CONTROL_STATES = ['off', 'connecting', 'connected', 'reconnecting', 'failed'] as const;
export const remoteControlStateSchema = z.enum(REMOTE_CONTROL_STATES);
export type RemoteControlState = z.infer<typeof remoteControlStateSchema>;

export const remoteControlSummarySchema = z.object({
  state: remoteControlStateSchema,
  /** Link of the current conversation's bridge session; null while not wanted or never connected. */
  sessionUrl: claudeSessionUrlSchema.nullable(),
  /** REMOTE_CONTROL_* while `failed`, else null. */
  error: errorPayloadSchema.nullable(),
  /**
   * `Entry.remoteControlWanted` (the menu toggles it; a dormant session connects at its next
   * start). Additive to the approved shape (WP-64 report).
   */
  wanted: z.boolean().default(false),
});
export type RemoteControlSummary = z.infer<typeof remoteControlSummarySchema>;

export const DEFAULT_REMOTE_CONTROL_SUMMARY = {
  state: 'off',
  sessionUrl: null,
  error: null,
  wanted: false,
} as const satisfies RemoteControlSummary;

/** States in which the bridge is (or is about to be) up – such a session never sleeps (ADR-105, WP-64). */
export function isRemoteControlActive(state: RemoteControlState): boolean {
  return state === 'connecting' || state === 'connected' || state === 'reconnecting';
}

/**
 * WP-65: what a working session does right now (runtime only, never persisted; the engine changes
 * it at most every ~2 s). `claude` = the CLI's live sentence (`system/task_summary`, only with a
 * connected Remote Control bridge; English as sent); otherwise Parallax's fallback: the running tool
 * call of the main thread (`target` = file name, command … – the UI words it like `ToolCallRow`) or
 * thinking. null = not working.
 */
export const sessionActivitySchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('claude'), text: z.string().max(300) }),
  z.object({ kind: z.literal('tool'), tool: z.string().max(200), target: z.string().max(300).nullable() }),
  z.object({ kind: z.literal('thinking') }),
]);
export type SessionActivity = z.infer<typeof sessionActivitySchema>;

/**
 * WP-71: the kind of a task (`taskKind` in `tasks.ts`): agent (`local_agent`/`remote_agent`), shell
 * (`local_bash`), workflow (`local_workflow`), anything else.
 */
export const TASK_KINDS = ['agent', 'bash', 'workflow', 'other'] as const;
export const taskKindSchema = z.enum(TASK_KINDS);
export type TaskKind = z.infer<typeof taskKindSchema>;

/** WP-71: at most this many running tasks are named in `SessionSummary.runningTasks.items`. */
export const RUNNING_TASK_ITEMS_MAX = 5;
/** WP-71: `RunningTaskItem.label` limit (chars). */
export const RUNNING_TASK_LABEL_MAX = 120;

/** WP-71: one running task for the sidebar's tooltip: kind, subagent type, short description. */
export const runningTaskItemSchema = z.object({
  kind: taskKindSchema,
  subagentType: z.string().max(100).nullable(),
  /** Agents: the progress summary (`task.summary`) when there is one, else the description. */
  label: z.string().max(RUNNING_TASK_LABEL_MAX),
});
export type RunningTaskItem = z.infer<typeof runningTaskItemSchema>;

/**
 * WP-71: what runs in a session (counted like the task panel, `tasks.ts`): agents, shells and the
 * rest (workflows, unknown kinds), plus the first running tasks (oldest start first).
 */
export const runningTasksSchema = z.object({
  agents: z.number().int().nonnegative(),
  shells: z.number().int().nonnegative(),
  other: z.number().int().nonnegative(),
  items: z.array(runningTaskItemSchema).max(RUNNING_TASK_ITEMS_MAX),
});
export type RunningTasks = z.infer<typeof runningTasksSchema>;

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
  /** WP-73: Entry.claudeModel – what "Default" (modelSetting null) means for this entry. */
  claudeModel: z.string().nullable().default(null),
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
   * ended, the return is pending. 102e: `terminalId` = "Continue in terminal" (the panel shows it).
   */
  external: z
    .object({
      since: isoDateTimeSchema,
      pid: z.number().int().positive().nullable(),
      running: z.boolean(),
      terminalId: terminalIdSchema.nullable().default(null),
    })
    .nullable()
    .default(null),
  /** WP-64: Remote Control (bridge to claude.ai / the Claude app). */
  remoteControl: remoteControlSummarySchema.default(DEFAULT_REMOTE_CONTROL_SUMMARY),
  /** WP-65: live sentence of a working session (runtime only). */
  activity: sessionActivitySchema.nullable().default(null),
  /** WP-65: `Entry.turnSummary`. */
  turnSummary: turnSummarySchema.nullable().default(null),
  /** WP-65: `Entry.lastSeenAt` – the transcript's "since you were last here" card starts there. */
  lastSeenAt: isoDateTimeSchema.nullable().default(null),
  /**
   * WP-70: the output style of the session's project (`system/init.output_style` of the last turn,
   * `initializationResult`, or the style just set; runtime only, null = not known yet).
   */
  outputStyle: z.string().max(100).nullable().default(null),
  /**
   * WP-71: running agents, shells and other tasks of the current conversation (runtime only, never
   * persisted; the engine recounts at most every ~2 s); null = nothing runs or no process.
   */
  runningTasks: runningTasksSchema.nullable().default(null),
  /** WP-76/77: the entry has a synchronized draft (`SessionDetail.draft` not null) – sidebar hint. */
  hasDraft: z.boolean().default(false),
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
  /** WP-73: a row of Claude's `modelPicker` setting (the user's curated list, in the CLI's order). */
  curated: z.boolean().default(false),
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

// ---- Phase 3: task list and plan file (ADR-148, ADR-149) ----

export const TODO_STATUSES = ['pending', 'in_progress', 'completed'] as const;
export const todoStatusSchema = z.enum(TODO_STATUSES);
export type TodoStatus = z.infer<typeof todoStatusSchema>;

export const todoItemSchema = z.object({
  /** TodoWrite: the index as string; Task tools: the taskId. */
  id: z.string(),
  content: z.string().max(2000),
  status: todoStatusSchema,
  activeForm: z.string().max(2000).nullable(),
});
export type TodoItem = z.infer<typeof todoItemSchema>;

/** The pinned task list (writer: engine – last TodoWrite or the TaskCreate/TaskUpdate calls). */
export const todoListSchema = z.object({
  source: z.enum(['todo_write', 'tasks']),
  items: z.array(todoItemSchema).max(LIMITS.todoItemsMax),
  updatedAt: isoDateTimeSchema,
  toolUseId: z.string().nullable(),
});
export type TodoList = z.infer<typeof todoListSchema>;

/** The plan file of the current conversation (writer: engine, ADR-148). */
export const planFileRefSchema = z.object({
  path: z.string(),
  /** Time of the last finished Write/Edit of the file. */
  updatedAt: isoDateTimeSchema,
  toolUseId: z.string().nullable(),
});
export type PlanFileRef = z.infer<typeof planFileRefSchema>;

/**
 * WP-76/77 (ADR-210): the composer draft of an entry, kept by the server so every window – also one
 * of another computer – sees the same draft. Last writer wins in the order the server accepts
 * `session.setDraft`; `rev` counts every accepted change; `clientId` = the window that wrote it (echo
 * detection), null after a migration from localStorage. Sending a prompt clears it (→ null).
 */
/**
 * `session.setDraft` input. The total (text + pastes ≤ LIMITS.draftTotalChars) is checked by the
 * engine (DRAFT_TOO_LARGE), not here – see `draftTotalChars()`.
 */
export const draftInputSchema = z.object({
  text: z.string().max(LIMITS.draftChars),
  /** Pasted texts that occur verbatim in `text` (like PromptInput.pastes). */
  pastes: z.array(z.string().min(1).max(LIMITS.promptChars)).max(LIMITS.pastesMax).default([]),
});
export type DraftInput = z.infer<typeof draftInputSchema>;

/** Size of a draft as LIMITS.draftTotalChars counts it. */
export function draftTotalChars(draft: { text: string; pastes: readonly string[] }): number {
  return draft.pastes.reduce((sum, paste) => sum + paste.length, draft.text.length);
}

export const draftSchema = z.object({
  text: z.string().max(LIMITS.draftChars),
  pastes: z.array(z.string().min(1).max(LIMITS.promptChars)).max(LIMITS.pastesMax),
  rev: z.number().int().positive(),
  updatedAt: isoDateTimeSchema,
  clientId: clientIdSchema.nullable(),
});
export type Draft = z.infer<typeof draftSchema>;

/** `PARALLAX_HOME/entries/<entryId>/draft.json` (WP-77). */
export const DRAFT_SCHEMA_VERSION = 1;
export const draftFileSchema = z.object({
  schemaVersion: z.literal(DRAFT_SCHEMA_VERSION),
  draft: draftSchema.nullable(),
});
export type DraftFile = z.infer<typeof draftFileSchema>;

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
  /** Phase 3 (ADR-149; writer: engine): pinned task list of the current conversation. */
  todos: todoListSchema.nullable(),
  /** Phase 3 (ADR-148; writer: engine): plan file of the current conversation. */
  planFile: planFileRefSchema.nullable(),
  /** Phase 3 (ADR-148; writer: engine): highest stored plan version of the entry. */
  latestPlanVersion: z.number().int().positive().nullable(),
  /**
   * WP-70 (writer: engine): the output styles the CLI offers in this project
   * (`initializationResult().available_output_styles`; empty = not known yet).
   */
  availableOutputStyles: z.array(z.string().max(100)).max(200),
  /** WP-76/77 (ADR-210; writer: engine): the synchronized composer draft; null = none. */
  draft: draftSchema.nullable(),
};

export const sessionDetailSchema = z.object({
  entryId: entryIdSchema,
  ...sessionDetailFields,
  unknownCounts: sessionDetailFields.unknownCounts.default({}),
  todos: sessionDetailFields.todos.default(null),
  planFile: sessionDetailFields.planFile.default(null),
  latestPlanVersion: sessionDetailFields.latestPlanVersion.default(null),
  availableOutputStyles: sessionDetailFields.availableOutputStyles.default([]),
  draft: sessionDetailFields.draft.default(null),
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

// =====================================================================================
// 5.13 Files (Phase 3, ADR-141 … ADR-146)
// =====================================================================================

export const FILE_KINDS = ['text', 'markdown', 'image', 'pdf', 'binary', 'directory'] as const;
export const fileKindSchema = z.enum(FILE_KINDS);
export type FileKind = z.infer<typeof fileKindSchema>;

/** Source encoding of a text file; GET /api/file always answers UTF-8 (ADR-142). */
export const TEXT_ENCODINGS = ['utf-8', 'utf-16le', 'utf-16be', 'windows-1252'] as const;
export const textEncodingSchema = z.enum(TEXT_ENCODINGS);
export type TextEncoding = z.infer<typeof textEncodingSchema>;

/** Why the path may be read (ADR-141): below a root, or listed in the session file index. */
export const FILE_ACCESS = ['cwd', 'additional', 'attachments', 'session'] as const;
export const fileAccessSchema = z.enum(FILE_ACCESS);
export type FileAccess = z.infer<typeof fileAccessSchema>;

export const fileInfoSchema = z.object({
  /** As requested (absolute) – used for display and actions. */
  path: z.string(),
  /** After links (realpath); equals `path` without links. */
  realPath: z.string(),
  kind: fileKindSchema,
  /** Content-Type of GET /api/file (text/markdown: 'text/plain; charset=utf-8'); null = not served. */
  mediaType: z.string().nullable(),
  bytes: z.number().int().nonnegative(),
  mtimeMs: z.number().nonnegative(),
  encoding: textEncodingSchema.nullable(),
  /** The viewer can show it (text/markdown always, image/pdf up to LIMITS.fileBinaryBytes). */
  previewable: z.boolean(),
  /** Text larger than LIMITS.fileTextBytes: GET /api/file sends the first part (cut at a line end). */
  truncated: z.boolean(),
  access: fileAccessSchema,
});
export type FileInfo = z.infer<typeof fileInfoSchema>;

/** One answer of file.statMany – never throws per path. */
export const fileStatResultSchema = z.discriminatedUnion('ok', [
  z.object({ path: z.string(), ok: z.literal(true), file: fileInfoSchema }),
  z.object({ path: z.string(), ok: z.literal(false), error: errorPayloadSchema }),
]);
export type FileStatResult = z.infer<typeof fileStatResultSchema>;

/** file.open targets (ADR-144). */
export const FILE_OPEN_TARGETS = ['editor', 'explorer', 'default'] as const;
export const fileOpenTargetSchema = z.enum(FILE_OPEN_TARGETS);
export type FileOpenTarget = z.infer<typeof fileOpenTargetSchema>;

/** "Dateien dieser Session" (ADR-145). */
export const SESSION_FILE_OPS = ['read', 'written', 'edited', 'plan', 'output', 'attached'] as const;
export const sessionFileOpSchema = z.enum(SESSION_FILE_OPS);
export type SessionFileOp = z.infer<typeof sessionFileOpSchema>;

export const sessionFileSchema = z.object({
  path: z.string(),
  /** Distinct, in first-seen order. */
  ops: z.array(sessionFileOpSchema).min(1),
  count: z.number().int().positive(),
  firstAt: isoDateTimeSchema,
  lastAt: isoDateTimeSchema,
  /** Last tool call that touched it (jump to the transcript row); null for attachments. */
  lastToolUseId: z.string().nullable(),
  conversationId: conversationIdSchema.nullable(),
});
export type SessionFile = z.infer<typeof sessionFileSchema>;

export const SESSION_FILES_SCHEMA_VERSION = 1;

/** `entries/<entryId>/files.json` (only the file service writes it, ADR-145). */
export const sessionFilesFileSchema = z.object({
  schemaVersion: z.literal(SESSION_FILES_SCHEMA_VERSION),
  /** The history before the index existed was read once from the transcript logs. */
  backfilled: z.boolean().default(false),
  files: z.array(sessionFileSchema).max(LIMITS.sessionFilesMax),
});
export type SessionFilesFile = z.infer<typeof sessionFilesFileSchema>;

// =====================================================================================
// 5.14 Plan versions (Phase 3, ADR-148; task list and plan file: see 5.11)
// =====================================================================================

export const planVersionInfoSchema = z.object({
  version: z.number().int().positive(),
  decisionId: decisionIdSchema,
  conversationId: conversationIdSchema,
  createdAt: isoDateTimeSchema,
  resolvedAt: isoDateTimeSchema.nullable(),
  outcome: decisionOutcomeSchema.nullable(),
  planFilePath: z.string().nullable(),
  /** plans/v<N>.md exists (false: the write failed or an older install). */
  stored: z.boolean(),
});
export type PlanVersionInfo = z.infer<typeof planVersionInfoSchema>;

// =====================================================================================
// 5.15 Session info (WP-67): the data of the CLI's terminal dialogs, normalized for display
// =====================================================================================

/**
 * The tabs of "Session info" that ask the running CLI (`session.info`): `/status`, `/memory`
 * (CLAUDE.md files), `/skills`, `/hooks`, `/permissions`, the MCP servers and `/export`. Only on
 * request (a tab opens, "Refresh") – never polled, never cached by the server.
 */
export const SESSION_INFO_SECTIONS = [
  'status',
  'memory',
  'skills',
  'hooks',
  'permissions',
  'mcp',
  'export',
] as const;
export const sessionInfoSectionNameSchema = z.enum(SESSION_INFO_SECTIONS);
export type SessionInfoSectionName = z.infer<typeof sessionInfoSectionNameSchema>;

/** `session.mcpAction`: reconnect a server, or switch it on/off (`toggleMcpServer`). */
export const MCP_ACTIONS = ['reconnect', 'enable', 'disable'] as const;
export const mcpActionSchema = z.enum(MCP_ACTIONS);
export type McpAction = z.infer<typeof mcpActionSchema>;

/** `session.reload`: `reloadSkills()` or `reloadPlugins()`. */
export const RELOAD_TARGETS = ['skills', 'plugins'] as const;
export const reloadTargetSchema = z.enum(RELOAD_TARGETS);
export type ReloadTarget = z.infer<typeof reloadTargetSchema>;

/** Caps of the normalized data: the producer (server) cuts, the schemas check the same bounds. */
export const SESSION_INFO_LIMITS = {
  /** Rows per list (skills, hooks, rules, files, servers …); beyond it `truncated: true`. */
  listMax: 1000,
  /** Characters of one text field (a hook command, a rule, a description …). */
  textChars: 8000,
  /** Characters of the export text (larger conversations: `truncated`, the rest via `/export`). */
  exportChars: 2_000_000,
  /** Characters of the suggested export file name. */
  fileNameChars: 120,
} as const;

const infoText = z.string().max(SESSION_INFO_LIMITS.textChars);
const infoList = <T extends z.ZodType>(item: T) => z.array(item).max(SESSION_INFO_LIMITS.listMax);

/**
 * One "label: value" row – the `/status` rows (values already rendered as text by the CLI) and the
 * generic fallback: scalar top-level fields a newer CLI adds show as rows (`extra`) instead of being
 * lost. `label: null` = a row that is a sentence on its own.
 */
export const infoRowSchema = z.object({ label: infoText.nullable(), value: infoText });
export type InfoRow = z.infer<typeof infoRowSchema>;

/** A settings file the CLI skipped (parse/validation error) – its rules/hooks are not in effect. */
export const infoSettingsErrorSchema = z.object({
  file: infoText.nullable(),
  path: infoText,
  message: infoText,
});
export type InfoSettingsError = z.infer<typeof infoSettingsErrorSchema>;

const infoCommon = {
  /** Unknown scalar top-level fields of the answer as rows (newer CLI). */
  extra: infoList(infoRowSchema),
};

/** `/status`: the screen's sections in its order (Session, Environment, …), every value as text. */
export const statusInfoSchema = z.object({
  section: z.literal('status'),
  groups: infoList(z.object({ title: infoText, rows: infoList(infoRowSchema) })),
  ...infoCommon,
});

/** `/memory` file kinds; anything newer is `other`. */
export const MEMORY_FILE_KINDS = ['user', 'project', 'project-alt', 'local', 'other'] as const;
export const memoryFileKindSchema = z.enum(MEMORY_FILE_KINDS);
export type MemoryFileKind = z.infer<typeof memoryFileKindSchema>;

/**
 * `/memory`: the instruction files (CLAUDE.md of the user, the project, the local one, imported
 * ones), the memory folders, the saved auto memories and the two switches (display only – the host
 * opens files itself).
 */
export const memoryInfoSchema = z.object({
  section: z.literal('memory'),
  files: infoList(
    z.object({
      kind: memoryFileKindSchema,
      /** Absolute path on the session's file system. */
      path: infoText,
      label: infoText,
      description: infoText,
      exists: z.boolean(),
    }),
  ),
  folders: infoList(z.object({ kind: infoText, path: infoText, label: infoText, description: infoText })),
  memories: infoList(
    z.object({
      name: infoText,
      path: infoText,
      description: infoText.nullable(),
      type: infoText.nullable(),
      modifiedAt: isoDateTimeSchema.nullable(),
    }),
  ),
  /** `Auto-memory:` row (null = the CLI sent none). */
  autoMemory: z.object({ enabled: z.boolean(), toggleable: z.boolean(), status: infoText }).nullable(),
  /** `Auto-dream:` row (null = the CLI sent none). */
  autoDream: z
    .object({
      shown: z.boolean(),
      enabled: z.boolean(),
      toggleable: z.boolean(),
      status: infoText,
      detail: infoText,
    })
    .nullable(),
  truncated: z.boolean(),
  ...infoCommon,
});

/** Skill states of `/skills` the UI translates; any other value is shown as the CLI sent it. */
export const SKILL_STATES = ['on', 'name-only', 'user-invocable-only', 'off'] as const;

/** `/skills`: each skill with source, token estimate, effective state and what locks it (read-only). */
export const skillsInfoSchema = z.object({
  section: z.literal('skills'),
  skills: infoList(
    z.object({
      name: infoText,
      displayName: infoText,
      description: infoText,
      /** 'user', 'project', 'plugin', 'built-in', … as the menu shows it. */
      source: infoText,
      /** Token estimate of the skill's listing in the system prompt; null = unknown. */
      tokens: z.number().nonnegative().nullable(),
      /** One of SKILL_STATES, or a newer value (shown raw). */
      state: infoText,
      /** 'author', 'plugin', 'policy', 'flag', 'reserved-name', … or null (not locked). */
      lockedBy: infoText.nullable(),
    }),
  ),
  truncated: z.boolean(),
  ...infoCommon,
});

/** `/hooks`: hooks of settings files, session and plugins by event and matcher, display-ready. */
export const hooksInfoSchema = z.object({
  section: z.literal('hooks'),
  /** Events with at least one hook, in the lifecycle order of the CLI. */
  events: infoList(
    z.object({
      name: infoText,
      summary: infoText,
      matcherSupported: z.boolean(),
      count: z.number().int().nonnegative(),
    }),
  ),
  hooks: infoList(
    z.object({
      event: infoText,
      /** '' = no matcher; control characters revealed by the CLI. */
      matcher: infoText,
      source: infoText,
      sourceLabel: infoText,
      pluginName: infoText.nullable(),
      /** command, prompt, agent, http, mcp_tool, … */
      type: infoText,
      displayText: infoText,
      /** The literal command/prompt/URL that runs (control characters as the CLI reveals them). */
      command: infoText,
      /** Label of `command` (Command, Prompt, URL, …). */
      contentLabel: infoText,
      condition: infoText.nullable(),
      timeoutSec: z.number().nonnegative().nullable(),
      statusMessage: infoText.nullable(),
      once: z.boolean(),
      background: z.boolean(),
      /** The session's mode or policy keeps this hook from running. */
      disabled: z.boolean(),
    }),
  ),
  policy: z
    .object({
      disabledByPolicy: z.boolean(),
      managedOnly: z.boolean(),
      pluginOnly: z.boolean(),
      allDisabled: z.boolean(),
      policyHookCount: z.number().int().nonnegative(),
      policyUnreadable: z.boolean(),
    })
    .nullable(),
  /** Present under `--safe-mode`. */
  safeMode: z.object({ managedHooksStillApply: z.boolean(), exitHint: infoText }).nullable(),
  /** Present under `--bare` (settings, flag, policy and plugin hooks never fire). */
  bareMode: z.object({ exitHint: infoText }).nullable(),
  errors: infoList(infoSettingsErrorSchema),
  truncated: z.boolean(),
  ...infoCommon,
});

export const PERMISSION_BEHAVIORS = ['allow', 'ask', 'deny'] as const;
export const permissionBehaviorSchema = z.enum(PERMISSION_BEHAVIORS);
export type PermissionBehavior = z.infer<typeof permissionBehaviorSchema>;

/** `/permissions`: the live rules with their source, the working directories (read-only). */
export const permissionsInfoSchema = z.object({
  section: z.literal('permissions'),
  rules: infoList(
    z.object({
      behavior: permissionBehaviorSchema,
      /** userSettings, projectSettings, localSettings, session, cliArg, policySettings, … */
      source: infoText,
      /** Verbatim as the session holds it (may carry invisible characters – escape at display). */
      rule: infoText,
      /** The CLI's plain-language reading ("Any Bash command starting with" + **npm run**). */
      description: z
        .object({ prefix: infoText, emphasis: infoText.nullable(), suffix: infoText.nullable() })
        .nullable(),
      /** persistent, session, readonly, … */
      editability: infoText,
      /** Ignored by the session (managed settings allow policy rules only). */
      notInEffect: z.boolean(),
    }),
  ),
  /** Additional working directories (`--add-dir`, `/add-dir`, settings). */
  directories: infoList(z.object({ path: infoText, source: infoText })),
  /** The session's original working directory (null = not reported). */
  cwd: infoText.nullable(),
  /** Managed settings allow policy rules only. */
  managedOnly: z.boolean(),
  errors: infoList(infoSettingsErrorSchema),
  truncated: z.boolean(),
  ...infoCommon,
});

/** MCP servers (`mcpServerStatus()`): status, error, origin, tools – never the configuration. */
export const mcpInfoSchema = z.object({
  section: z.literal('mcp'),
  servers: infoList(
    z.object({
      name: infoText,
      /** connected, failed, needs-auth, pending, disabled – or a newer value (shown raw). */
      status: infoText,
      /** Error text of the CLI (status failed). */
      error: infoText.nullable(),
      /** Configuration scope (project, user, local, claudeai, managed …). */
      scope: infoText.nullable(),
      /** sdk, plugin or the config scope. */
      source: infoText.nullable(),
      /** stdio, http, sse, … (`config.type`). */
      transport: infoText.nullable(),
      /** `serverInfo` of a connected server ("name version"). */
      serverVersion: infoText.nullable(),
      /** Tool names of a connected server. */
      tools: infoList(infoText),
    }),
  ),
  truncated: z.boolean(),
  ...infoCommon,
});

/** `/export`: the conversation as plain text with the file name the terminal would offer. */
export const exportInfoSchema = z.object({
  section: z.literal('export'),
  text: z.string().max(SESSION_INFO_LIMITS.exportChars),
  /** Windows-safe file name ending in `.txt`. */
  filename: z.string().min(1).max(SESSION_INFO_LIMITS.fileNameChars),
  /** Characters of the whole export (> text.length when truncated). */
  totalChars: z.number().int().nonnegative(),
  truncated: z.boolean(),
});

/** The data of one tab (answer of `session.info`), discriminated by `section`. */
export const sessionInfoSectionSchema = z.discriminatedUnion('section', [
  statusInfoSchema,
  memoryInfoSchema,
  skillsInfoSchema,
  hooksInfoSchema,
  permissionsInfoSchema,
  mcpInfoSchema,
  exportInfoSchema,
]);
export type SessionInfoSection = z.infer<typeof sessionInfoSectionSchema>;
/** The data of one named tab, e.g. `SessionInfoOf<'mcp'>`. */
export type SessionInfoOf<S extends SessionInfoSectionName> = Extract<SessionInfoSection, { section: S }>;

// =====================================================================================
// WP-69 Subagent transcript (read-only, on request)
// =====================================================================================

/** Bounds of `session.subagentTranscript` (items per answer; texts are capped like every item). */
export const SUBAGENT_TRANSCRIPT_LIMITS = {
  /** Items of one answer when the client asks for no `limit`. */
  pageItems: 100,
  /** Largest `limit` a client may ask for (like `LIMITS.loadEarlierMax`). */
  maxPageItems: 200,
  /** Characters of an agent id (`agent-<id>.jsonl`). */
  agentIdChars: 200,
} as const;

/**
 * Id of a subagent (`task_started.task_id` = the agent id, file `agent-<id>.jsonl`): letters, digits,
 * `_` and `-` only – it becomes part of a file name in the SDK, so no path characters.
 */
export const subagentIdSchema = z
  .string()
  .min(1)
  .max(SUBAGENT_TRANSCRIPT_LIMITS.agentIdChars)
  .regex(/^[A-Za-z0-9_-]+$/);

/**
 * One page of a subagent's transcript: `items` are the list positions `offset … offset+items.length-1`
 * of `total` (in `order`, oldest first; orders are the list's own, stable while it grows); `running`
 * = the subagent still works (the client polls then).
 */
export const subagentTranscriptPageSchema = z.object({
  items: z.array(transcriptItemSchema).max(SUBAGENT_TRANSCRIPT_LIMITS.maxPageItems),
  offset: z.number().int().nonnegative(),
  total: z.number().int().nonnegative(),
  running: z.boolean(),
});
export type SubagentTranscriptPage = z.infer<typeof subagentTranscriptPageSchema>;
