import { describe, expect, it } from 'vitest';
import {
  ERROR_CATALOG,
  ERROR_CODES,
  PROFILE_ARG_INVALID_REASONS,
  errorCodeForAssistantError,
  errorCodeForRateLimitError,
  errorCodeForStartupFailure,
  errorCodeSchema,
  errorInfoSchema,
  errorPayloadSchema,
  errorSpec,
  isSetupError,
  makeError,
  type ErrorCode,
} from './errors';

describe('error catalog', () => {
  it('every code has a complete spec', () => {
    for (const code of ERROR_CODES) {
      const spec = errorSpec(code);
      expect(spec.category, code).toBeTypeOf('string');
      expect(spec.http, code).toBeTypeOf('number');
      expect(['error', 'warning', 'info'], code).toContain(spec.severity);
      expect(spec.retryable, code).toBeTypeOf('boolean');
    }
  });

  it('errorCodeSchema accepts exactly the catalog keys', () => {
    expect([...errorCodeSchema.options].sort()).toEqual(Object.keys(ERROR_CATALOG).sort());
    expect(errorCodeSchema.safeParse('NOT_A_CODE').success).toBe(false);
  });

  it('client-only codes have no HTTP status, all others a 4xx/5xx', () => {
    for (const code of ERROR_CODES) {
      const spec = errorSpec(code);
      if (spec.category === 'client') expect(spec.http, code).toBe(0);
      else expect(spec.http >= 400 && spec.http < 600, code).toBe(true);
    }
  });

  it('isSetupError follows the category', () => {
    expect(isSetupError('CLAUDE_NOT_FOUND')).toBe(true);
    expect(isSetupError('SHELL_TOOL_MISSING')).toBe(true);
    expect(isSetupError('API_ERROR')).toBe(false);
  });
});

describe('R0 additions', () => {
  it('profile codes (R0-04): errors make the profile invalid, the rest are warnings/info', () => {
    const errors: ErrorCode[] = [
      'PROFILE_INVALID',
      'PROFILE_ARG_BLOCKED',
      'PROFILE_ARG_NOT_ALLOWED',
      'PROFILE_ARG_INVALID',
      'PROFILE_ENV_REF_UNRESOLVED',
    ];
    const warnings: ErrorCode[] = [
      'PROFILE_ARG_BROAD_ALLOWED_TOOLS',
      'PROFILE_BYPASS_ENABLED',
      'PROFILE_ARG_RESUME_NO_EFFECT',
    ];
    for (const code of errors)
      expect(errorSpec(code), code).toMatchObject({ category: 'validation', severity: 'error' });
    for (const code of warnings) expect(errorSpec(code).severity, code).toBe('warning');
    expect(errorSpec('PROFILE_ARG_PASSED_RAW').severity).toBe('info');
    expect(PROFILE_ARG_INVALID_REASONS).toEqual([
      'missing_value',
      'unexpected_value',
      'duplicate',
      'invalid_value',
      'not_a_flag',
    ]);
  });

  it('auth codes for the HTTP contract (R0-01) are 401/403', () => {
    expect(errorSpec('LAUNCHER_TOKEN_INVALID')).toMatchObject({ category: 'auth', http: 401 });
    expect(errorSpec('AUTH_REQUIRED').http).toBe(401);
    expect(errorSpec('AUTH_CODE_INVALID').http).toBe(401);
    expect(errorSpec('ORIGIN_REJECTED').http).toBe(403);
    expect(errorSpec('HOST_HEADER_REJECTED').http).toBe(403);
  });

  it('a session held elsewhere is a retryable conflict, not a setup error (R0-26)', () => {
    expect(errorSpec('SESSION_HELD_ELSEWHERE')).toMatchObject({ category: 'conflict', retryable: true });
    expect(isSetupError('SESSION_HELD_ELSEWHERE')).toBe(false);
  });
});

describe('payloads', () => {
  it('makeError sets params {} and omits an absent message', () => {
    expect(makeError('ENTRY_NOT_FOUND')).toEqual({ code: 'ENTRY_NOT_FOUND', params: {} });
    expect(makeError('VALIDATION_FAILED', { path: 'cmd.cwd' }, 'Required')).toEqual({
      code: 'VALIDATION_FAILED',
      params: { path: 'cmd.cwd' },
      message: 'Required',
    });
  });

  it('errorPayloadSchema fills params and rejects unknown codes', () => {
    expect(errorPayloadSchema.parse({ code: 'INTERNAL_ERROR' })).toEqual({
      code: 'INTERNAL_ERROR',
      params: {},
    });
    expect(errorPayloadSchema.safeParse({ code: 'NOPE' }).success).toBe(false);
  });

  it('errorInfoSchema requires a timestamp', () => {
    expect(errorInfoSchema.safeParse({ code: 'API_ERROR', params: {} }).success).toBe(false);
    expect(
      errorInfoSchema.safeParse({ code: 'API_ERROR', params: {}, at: '2026-10-15T08:00:00.000Z' }).success,
    ).toBe(true);
  });
});

describe('startup_failure_reason → code (C.5)', () => {
  const table: [string, ErrorCode][] = [
    ['shell_tool_missing', 'SHELL_TOOL_MISSING'],
    ['cwd_unavailable', 'CWD_UNAVAILABLE'],
    ['cli_version_too_old', 'CLAUDE_VERSION_TOO_OLD'],
    ['org_pin_api_key_conflict', 'CLAUDE_ORG_POLICY'],
    ['provider_not_allowed', 'CLAUDE_ORG_POLICY'],
    ['org_verify_failed', 'CLAUDE_ORG_POLICY'],
    ['org_pin_mismatch', 'CLAUDE_ORG_POLICY'],
    ['managed_settings_invalid', 'CLAUDE_ORG_POLICY'],
    ['remote_settings_required_unavailable', 'CLAUDE_ORG_POLICY'],
    ['org_config_required_unavailable', 'CLAUDE_ORG_POLICY'],
    ['org_config_refused', 'CLAUDE_ORG_POLICY'],
    ['gateway_signin_required', 'CLAUDE_AUTH_FAILED'],
    ['gateway_access_denied', 'CLAUDE_AUTH_FAILED'],
    ['proxy_invalid', 'CLAUDE_STARTUP_FAILED'],
    ['temp_dir_unusable', 'CLAUDE_STARTUP_FAILED'],
    ['session_held_by_background', 'SESSION_HELD_ELSEWHERE'],
    ['worktree_resume_refused', 'CLAUDE_STARTUP_FAILED'],
    ['something_new', 'CLAUDE_STARTUP_FAILED'],
    ['toString', 'CLAUDE_STARTUP_FAILED'],
    ['', 'CLAUDE_STARTUP_FAILED'],
  ];
  it.each(table)('%s → %s', (reason, code) => {
    expect(errorCodeForStartupFailure(reason)).toBe(code);
  });
});

describe('assistant.error → code (C.5)', () => {
  const table: [string, ErrorCode][] = [
    ['authentication_failed', 'CLAUDE_AUTH_FAILED'],
    ['oauth_org_not_allowed', 'CLAUDE_AUTH_FAILED'],
    ['account_on_hold', 'CLAUDE_AUTH_FAILED'],
    ['verification_required', 'CLAUDE_AUTH_FAILED'],
    ['cloud_credential_error', 'CLAUDE_AUTH_FAILED'],
    ['billing_error', 'CLAUDE_BILLING'],
    ['rate_limit', 'RATE_LIMIT_REJECTED'],
    ['overloaded', 'API_OVERLOADED'],
    ['invalid_request', 'API_INVALID_REQUEST'],
    ['model_not_found', 'MODEL_NOT_FOUND'],
    ['max_output_tokens', 'API_MAX_OUTPUT_TOKENS'],
    ['server_error', 'API_ERROR'],
    ['unknown', 'API_ERROR'],
    ['brand_new_error', 'API_ERROR'],
    ['constructor', 'API_ERROR'],
  ];
  it.each(table)('%s → %s', (error, code) => {
    expect(errorCodeForAssistantError(error)).toBe(code);
  });
});

describe('rate_limit_info.errorCode → code', () => {
  it('credits_required means billing', () => {
    expect(errorCodeForRateLimitError('credits_required')).toBe('CLAUDE_BILLING');
    expect(errorCodeForRateLimitError('something_else')).toBe('RATE_LIMIT_REJECTED');
  });
});
