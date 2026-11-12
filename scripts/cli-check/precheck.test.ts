import { describe, expect, it } from 'vitest';
import { makeError } from '@shared/errors';
import { sampleClaudeInstallStatus } from '@shared/samples';
import { billingVarsSet, precheckProblems } from './precheck';
import { probeGuard } from './probe';

describe('precheck (WP-62, ADR-011 guards before any live call)', () => {
  it('passes with the subscription login, a current claude and no API-key variables', () => {
    expect(precheckProblems({ env: { PATH: 'x' }, status: sampleClaudeInstallStatus(), sdkVersion: '0.3.322' })).toEqual([]);
  });

  it('refuses API-key variables (case-insensitive, empty values ignored)', () => {
    expect(billingVarsSet({ anthropic_api_key: 'sk', ANTHROPIC_BASE_URL: '', ANTHROPIC_AUTH_TOKEN: 't' })).toEqual([
      'ANTHROPIC_AUTH_TOKEN',
      'anthropic_api_key',
    ]);
    const problems = precheckProblems({
      env: { ANTHROPIC_API_KEY: 'sk' },
      status: sampleClaudeInstallStatus(),
      sdkVersion: '0.3.322',
    });
    expect(problems).toEqual(['ANTHROPIC_API_KEY set – only the subscription login is allowed']);
  });

  it.each([
    ['not found', { state: 'not_found' as const, path: null, error: makeError('CLAUDE_NOT_FOUND') }, 'claude not usable: not_found CLAUDE_NOT_FOUND'],
    ['too old', { versionStatus: 'too_old' as const }, 'claude 2.1.300 is older than the SDK expects'],
    ['unknown version', { versionStatus: 'unknown' as const }, 'claude version unknown or not comparable with the SDK requirement'],
    [
      'logged out',
      { auth: { state: 'logged_out' as const, method: null, apiProvider: null, subscriptionType: null } },
      'claude auth status: logged_out',
    ],
    [
      'console login',
      { auth: { state: 'logged_in' as const, method: 'console', apiProvider: 'firstParty', subscriptionType: null } },
      'claude auth status: console/firstParty – subscription login (claude.ai/firstParty) required',
    ],
  ])('refuses: %s', (_name, partial, problem) => {
    expect(precheckProblems({ env: {}, status: sampleClaudeInstallStatus(partial), sdkVersion: '0.3.322' })).toEqual([problem]);
  });

  it('refuses without an installed SDK', () => {
    expect(precheckProblems({ env: {}, status: sampleClaudeInstallStatus(), sdkVersion: null })).toEqual([
      'Agent SDK not installed (pnpm install --frozen-lockfile)',
    ]);
  });
});

describe('probeGuard (WP-62, recorder guards)', () => {
  const init = { type: 'system', subtype: 'init', apiKeySource: 'none', model: 'claude-haiku-5-5' };

  it('lets a normal stream pass', () => {
    expect(probeGuard(init, 0.05)).toBeNull();
    expect(probeGuard({ type: 'assistant', message: {} }, 0.05)).toBeNull();
    expect(probeGuard({ type: 'rate_limit_event', rate_limit_info: { status: 'allowed_warning' } }, 0.05)).toBeNull();
    expect(probeGuard({ type: 'result', subtype: 'success', total_cost_usd: 0.004 }, 0.05)).toBeNull();
    expect(probeGuard('not an object', 0.05)).toBeNull();
  });

  it.each<[string, unknown, string]>([
    ['API key', { ...init, apiKeySource: 'ANTHROPIC_API_KEY' }, 'auth'],
    ['not Haiku', { ...init, model: 'claude-sonnet-5-5' }, 'guard'],
    ['auth error', { type: 'assistant', error: 'billing_error' }, 'auth'],
    ['credits required', { type: 'rate_limit_event', rate_limit_info: { errorCode: 'credits_required' } }, 'auth'],
    ['rejected', { type: 'rate_limit_event', rate_limit_info: { status: 'rejected' } }, 'guard'],
    ['startup failure', { type: 'result', subtype: 'error_during_execution', startup_failure_reason: 'auth' }, 'auth'],
    ['budget', { type: 'result', subtype: 'success', total_cost_usd: 0.06 }, 'budget'],
  ])('stops: %s', (_name, message, kind) => {
    expect(probeGuard(message, 0.05)?.kind).toBe(kind);
  });
});
