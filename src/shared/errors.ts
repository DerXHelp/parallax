/**
 * Error code catalog. The server sends only codes (+ params); the UI translates them
 * (`errors.<CODE>` in the i18n files, typed `Record<ErrorCode, string>`). New codes only via a
 * contract change (docs/wp/WP-02.md §4, §13).
 */
import { z } from 'zod';
import { isoDateTimeSchema, paramsSchema, type Params } from './common';

export type ErrorCategory =
  | 'protocol'
  | 'auth'
  | 'validation'
  | 'not_found'
  | 'conflict'
  | 'setup'
  | 'claude'
  | 'store'
  | 'client'
  | 'internal';

export type ErrorSeverity = 'error' | 'warning' | 'info';

export interface ErrorSpec {
  category: ErrorCategory;
  /** HTTP status for REST answers; 0 = client-side only. */
  http: number;
  severity: ErrorSeverity;
  retryable: boolean;
}

export const ERROR_CATALOG = {
  // protocol / generic
  INVALID_MESSAGE: { category: 'protocol', http: 400, severity: 'error', retryable: false },
  PROTOCOL_VERSION_MISMATCH: { category: 'protocol', http: 400, severity: 'error', retryable: false },
  NOT_SUBSCRIBED: { category: 'protocol', http: 400, severity: 'error', retryable: true },
  NOT_IMPLEMENTED: { category: 'protocol', http: 501, severity: 'warning', retryable: false },
  PAYLOAD_TOO_LARGE: { category: 'validation', http: 413, severity: 'error', retryable: false },
  VALIDATION_FAILED: { category: 'validation', http: 400, severity: 'error', retryable: false },
  UNSUPPORTED_MEDIA_TYPE: { category: 'validation', http: 415, severity: 'error', retryable: false },
  // auth / origin (A.8)
  AUTH_REQUIRED: { category: 'auth', http: 401, severity: 'error', retryable: false },
  /** Unknown, already used or expired one-time code (indistinguishable on purpose). */
  AUTH_CODE_INVALID: { category: 'auth', http: 401, severity: 'error', retryable: false },
  /** `POST /api/launcher/code` without the launcher token of the lock file (R0-01, src/shared/http.ts). */
  LAUNCHER_TOKEN_INVALID: { category: 'auth', http: 401, severity: 'error', retryable: false },
  /** Also Sec-Fetch-Site violations (`params.reason: 'sec-fetch-site'`). */
  ORIGIN_REJECTED: { category: 'auth', http: 403, severity: 'error', retryable: false },
  HOST_HEADER_REJECTED: { category: 'auth', http: 403, severity: 'error', retryable: false },
  // paths (C.10, B "cwd exakt")
  PATH_REJECTED: { category: 'validation', http: 400, severity: 'error', retryable: false },
  PATH_NOT_ALLOWED: { category: 'auth', http: 403, severity: 'error', retryable: false },
  CWD_NOT_FOUND: { category: 'validation', http: 400, severity: 'error', retryable: false },
  CWD_NOT_DIRECTORY: { category: 'validation', http: 400, severity: 'error', retryable: false },
  // not found
  ENTRY_NOT_FOUND: { category: 'not_found', http: 404, severity: 'error', retryable: false },
  CONVERSATION_NOT_FOUND: { category: 'not_found', http: 404, severity: 'error', retryable: false },
  DECISION_NOT_FOUND: { category: 'not_found', http: 404, severity: 'error', retryable: false },
  ITEM_NOT_FOUND: { category: 'not_found', http: 404, severity: 'error', retryable: false },
  PROFILE_NOT_FOUND: { category: 'not_found', http: 404, severity: 'error', retryable: false },
  BLOB_NOT_FOUND: { category: 'not_found', http: 404, severity: 'error', retryable: false },
  // profiles: parseProfileArgs / buildEnv (C.12, Plan "Claude-Profile", R0-04). Params convention:
  // `index` (0-based position in profile.args), `flag` (e.g. '--add-dir'), see PROFILE_ARG_INVALID_REASONS.
  /** The profile as a whole cannot be used (at least one error below). */
  PROFILE_INVALID: { category: 'validation', http: 400, severity: 'error', retryable: false },
  /** Flag controlled by Parallax (-p, --resume, --output-format …, C.12 list). */
  PROFILE_ARG_BLOCKED: { category: 'validation', http: 400, severity: 'error', retryable: false },
  /** Flag not in the allowlist and "pass raw" is off. */
  PROFILE_ARG_NOT_ALLOWED: { category: 'validation', http: 400, severity: 'error', retryable: false },
  /** Missing/unexpected/invalid value or repeated flag (`params.reason`). */
  PROFILE_ARG_INVALID: { category: 'validation', http: 400, severity: 'error', retryable: false },
  /** `${env:NAME}` in profile.env is not set on this machine (`params.name`, `params.key`). */
  PROFILE_ENV_REF_UNRESOLVED: { category: 'validation', http: 400, severity: 'error', retryable: false },
  /** Warning: a blanket `--allowedTools` entry bypasses canUseTool (C.12, `params.value`). */
  PROFILE_ARG_BROAD_ALLOWED_TOOLS: {
    category: 'validation',
    http: 400,
    severity: 'warning',
    retryable: false,
  },
  /** Warning: the profile allows bypassPermissions (UI marks it red, C.3). */
  PROFILE_BYPASS_ENABLED: { category: 'validation', http: 400, severity: 'warning', retryable: false },
  /** Warning: e.g. a changed --append-system-prompt has no effect on resumed sessions (C.12). */
  PROFILE_ARG_RESUME_NO_EFFECT: { category: 'validation', http: 400, severity: 'warning', retryable: false },
  /** Info: unknown flag passed through unchecked because "pass raw" is on (C.12). */
  PROFILE_ARG_PASSED_RAW: { category: 'validation', http: 400, severity: 'info', retryable: false },
  // conflict / state
  DECISION_ALREADY_RESOLVED: { category: 'conflict', http: 409, severity: 'info', retryable: false },
  DECISION_EXPIRED: { category: 'conflict', http: 409, severity: 'warning', retryable: false },
  DECISION_OPTION_UNAVAILABLE: { category: 'conflict', http: 409, severity: 'error', retryable: false },
  SESSION_NOT_RUNNING: { category: 'conflict', http: 409, severity: 'warning', retryable: true },
  SESSION_BUSY: { category: 'conflict', http: 409, severity: 'warning', retryable: true },
  SESSION_EXTERNAL: { category: 'conflict', http: 409, severity: 'warning', retryable: false },
  /** startup_failure_reason `session_held_by_background`: the conversation runs elsewhere (Plan B, R0-26). */
  SESSION_HELD_ELSEWHERE: { category: 'conflict', http: 409, severity: 'error', retryable: true },
  MODE_NOT_ALLOWED: { category: 'conflict', http: 409, severity: 'error', retryable: false },
  PROFILE_IN_USE: { category: 'conflict', http: 409, severity: 'error', retryable: false },
  SERVER_SHUTTING_DOWN: { category: 'conflict', http: 503, severity: 'warning', retryable: false },
  // setup (C.5, C.7, F.17) – the UI shows the setup screen / hint
  CLAUDE_NOT_FOUND: { category: 'setup', http: 503, severity: 'error', retryable: true },
  CLAUDE_VERSION_TOO_OLD: { category: 'setup', http: 503, severity: 'warning', retryable: false },
  CLAUDE_NOT_LOGGED_IN: { category: 'setup', http: 503, severity: 'error', retryable: true },
  CLAUDE_AUTH_FAILED: { category: 'setup', http: 503, severity: 'error', retryable: true },
  CLAUDE_ORG_POLICY: { category: 'setup', http: 503, severity: 'error', retryable: false },
  CLAUDE_BILLING: { category: 'setup', http: 503, severity: 'error', retryable: false },
  SHELL_TOOL_MISSING: { category: 'setup', http: 503, severity: 'error', retryable: false },
  CWD_UNAVAILABLE: { category: 'setup', http: 503, severity: 'error', retryable: false },
  // claude runtime
  CLAUDE_SPAWN_FAILED: { category: 'claude', http: 502, severity: 'error', retryable: true },
  CLAUDE_STARTUP_FAILED: { category: 'claude', http: 502, severity: 'error', retryable: true },
  CLAUDE_PROCESS_CRASHED: { category: 'claude', http: 502, severity: 'error', retryable: true },
  CLAUDE_CONTROL_FAILED: { category: 'claude', http: 502, severity: 'error', retryable: true },
  RATE_LIMIT_REJECTED: { category: 'claude', http: 429, severity: 'warning', retryable: true },
  API_OVERLOADED: { category: 'claude', http: 502, severity: 'warning', retryable: true },
  API_ERROR: { category: 'claude', http: 502, severity: 'error', retryable: true },
  API_INVALID_REQUEST: { category: 'claude', http: 502, severity: 'error', retryable: false },
  API_MAX_OUTPUT_TOKENS: { category: 'claude', http: 502, severity: 'warning', retryable: false },
  MODEL_NOT_FOUND: { category: 'claude', http: 502, severity: 'error', retryable: false },
  MODEL_REFUSAL: { category: 'claude', http: 502, severity: 'warning', retryable: false },
  MCP_SERVER_NOT_APPROVED: { category: 'claude', http: 502, severity: 'info', retryable: false },
  TURN_FAILED: { category: 'claude', http: 502, severity: 'error', retryable: true },
  // store (B Persistenz)
  STORE_CORRUPT_QUARANTINED: { category: 'store', http: 500, severity: 'warning', retryable: false },
  STORE_WRITE_FAILED: { category: 'store', http: 500, severity: 'error', retryable: true },
  STORE_MIGRATION_FAILED: { category: 'store', http: 500, severity: 'error', retryable: false },
  // client-side only (never sent by a server)
  CONNECTION_LOST: { category: 'client', http: 0, severity: 'warning', retryable: true },
  COMMAND_TIMEOUT: { category: 'client', http: 0, severity: 'warning', retryable: true },
  // last resort
  INTERNAL_ERROR: { category: 'internal', http: 500, severity: 'error', retryable: true },
} as const satisfies Record<string, ErrorSpec>;

export type ErrorCode = keyof typeof ERROR_CATALOG;

/** All codes in catalog order. The only allowed type assertion of the contracts (type-tested). */
export const ERROR_CODES = Object.keys(ERROR_CATALOG) as ErrorCode[];

export const errorCodeSchema = z.enum(ERROR_CODES);

/** Wire error: code + interpolation params. `message` is English, for logs/dev tools only, never shown. */
export const errorPayloadSchema = z.object({
  code: errorCodeSchema,
  params: paramsSchema.default({}),
  message: z.string().max(2000).optional(),
});
export type ErrorPayload = z.infer<typeof errorPayloadSchema>;

/** Persisted/displayed error info (Entry.lastError, error items). */
export const errorInfoSchema = errorPayloadSchema.extend({ at: isoDateTimeSchema });
export type ErrorInfo = z.infer<typeof errorInfoSchema>;

export function errorSpec(code: ErrorCode): ErrorSpec {
  return ERROR_CATALOG[code];
}

/** Setup errors make the UI show the setup screen / hint (C.5). */
export function isSetupError(code: ErrorCode): boolean {
  return ERROR_CATALOG[code].category === 'setup';
}

export function makeError(code: ErrorCode, params: Params = {}, message?: string): ErrorPayload {
  return message === undefined ? { code, params } : { code, params, message };
}

const STARTUP_FAILURE_CODES: Readonly<Record<string, ErrorCode>> = {
  shell_tool_missing: 'SHELL_TOOL_MISSING',
  cwd_unavailable: 'CWD_UNAVAILABLE',
  cli_version_too_old: 'CLAUDE_VERSION_TOO_OLD',
  org_pin_api_key_conflict: 'CLAUDE_ORG_POLICY',
  provider_not_allowed: 'CLAUDE_ORG_POLICY',
  org_verify_failed: 'CLAUDE_ORG_POLICY',
  org_pin_mismatch: 'CLAUDE_ORG_POLICY',
  managed_settings_invalid: 'CLAUDE_ORG_POLICY',
  remote_settings_required_unavailable: 'CLAUDE_ORG_POLICY',
  org_config_required_unavailable: 'CLAUDE_ORG_POLICY',
  org_config_refused: 'CLAUDE_ORG_POLICY',
  gateway_signin_required: 'CLAUDE_AUTH_FAILED',
  gateway_access_denied: 'CLAUDE_AUTH_FAILED',
  session_held_by_background: 'SESSION_HELD_ELSEWHERE',
};

const ASSISTANT_ERROR_CODES: Readonly<Record<string, ErrorCode>> = {
  authentication_failed: 'CLAUDE_AUTH_FAILED',
  oauth_org_not_allowed: 'CLAUDE_AUTH_FAILED',
  account_on_hold: 'CLAUDE_AUTH_FAILED',
  verification_required: 'CLAUDE_AUTH_FAILED',
  cloud_credential_error: 'CLAUDE_AUTH_FAILED',
  billing_error: 'CLAUDE_BILLING',
  rate_limit: 'RATE_LIMIT_REJECTED',
  overloaded: 'API_OVERLOADED',
  invalid_request: 'API_INVALID_REQUEST',
  model_not_found: 'MODEL_NOT_FOUND',
  max_output_tokens: 'API_MAX_OUTPUT_TOKENS',
};

function lookup(table: Readonly<Record<string, ErrorCode>>, key: string, fallback: ErrorCode): ErrorCode {
  return Object.hasOwn(table, key) ? (table[key] ?? fallback) : fallback;
}

/**
 * C.5: `result.startup_failure_reason` (SDKStartupFailureReason as plain string) → code.
 * Unknown reasons → CLAUDE_STARTUP_FAILED. Callers pass the raw value as `params.reason`.
 */
export function errorCodeForStartupFailure(reason: string): ErrorCode {
  return lookup(STARTUP_FAILURE_CODES, reason, 'CLAUDE_STARTUP_FAILED');
}

/**
 * C.5: `assistant.error` (SDKAssistantMessageError as plain string) → code.
 * `server_error`, `unknown` and unknown values → API_ERROR. Callers pass the raw value as `params.reason`.
 */
export function errorCodeForAssistantError(error: string): ErrorCode {
  return lookup(ASSISTANT_ERROR_CODES, error, 'API_ERROR');
}

/** Values of `params.reason` for PROFILE_ARG_INVALID (R0-04, WP-11 parseProfileArgs). */
export const PROFILE_ARG_INVALID_REASONS = [
  /** Flag needs a value, none given. */
  'missing_value',
  /** Boolean flag got a value. */
  'unexpected_value',
  /** C.12: one value per flag – repeated flags are not allowed. */
  'duplicate',
  /** Value does not parse (e.g. unknown permission mode). */
  'invalid_value',
  /** Empty argument or a value without a flag. */
  'not_a_flag',
] as const;
export type ProfileArgInvalidReason = (typeof PROFILE_ARG_INVALID_REASONS)[number];

/** `rate_limit_info.errorCode` value that means "no credits / billing" (WP-02 §4). */
export const CREDITS_REQUIRED_ERROR = 'credits_required';

/** `rate_limit_info.errorCode` → code: `credits_required` → CLAUDE_BILLING, anything else → RATE_LIMIT_REJECTED. */
export function errorCodeForRateLimitError(errorCode: string): ErrorCode {
  return errorCode === CREDITS_REQUIRED_ERROR ? 'CLAUDE_BILLING' : 'RATE_LIMIT_REJECTED';
}
