import { describe, expect, it } from 'vitest';
import { makeError } from '@shared/errors';
import { LoginMethodMissing, hasLoginMethods, loginErrorOf, loginResultOf, loginStartOf } from './login';

function timeout(): Error {
  const error = new Error('claudeOAuthWaitForCompletion timed out after 600000 ms');
  error.name = 'TimeoutError';
  return error;
}

describe('backend/login (WP-70)', () => {
  it('loginStartOf: https links only; automaticUrl optional; unknown shape → LOGIN_UNAVAILABLE', () => {
    expect(
      loginStartOf({
        manualUrl: 'https://claude.ai/oauth/authorize?state=1',
        automaticUrl: 'https://claude.ai/oauth/authorize?a=1',
      }),
    ).toEqual({
      ok: true,
      manualUrl: 'https://claude.ai/oauth/authorize?state=1',
      automaticUrl: 'https://claude.ai/oauth/authorize?a=1',
    });
    expect(loginStartOf({ manualUrl: 'https://claude.ai/x' })).toEqual({
      ok: true,
      manualUrl: 'https://claude.ai/x',
      automaticUrl: null,
    });
    expect(loginStartOf({ manualUrl: 'https://claude.ai/x', automaticUrl: 'javascript:alert(1)' })).toMatchObject({
      automaticUrl: null,
    });
    expect(loginStartOf({ manualUrl: 'http://claude.ai/x' })).toEqual({
      ok: false,
      error: makeError('LOGIN_FAILED', { reason: 'url' }),
    });
    expect(loginStartOf(null)).toMatchObject({ ok: false, error: { code: 'LOGIN_UNAVAILABLE' } });
  });

  it('loginResultOf: only subscriptionType leaves – never e-mail or organization', () => {
    const result = loginResultOf({
      account: { email: 'someone@example.invalid', organization: 'Org', subscriptionType: 'max', tokenSource: 'oauth' },
    });
    expect(result).toEqual({ ok: true, subscriptionType: 'max' });
    expect(JSON.stringify(result)).not.toContain('example.invalid');
    expect(loginResultOf({ account: { subscriptionType: 7 } })).toEqual({ ok: true, subscriptionType: null });
    expect(loginResultOf(undefined)).toEqual({ ok: true, subscriptionType: null });
  });

  it('loginErrorOf classifies without passing the CLI text on', () => {
    expect(loginErrorOf(new LoginMethodMissing('claudeAuthenticate'), 'start').code).toBe('LOGIN_UNAVAILABLE');
    expect(loginErrorOf(new Error('Unsupported control request subtype: claude_authenticate'), 'start').code).toBe(
      'LOGIN_UNAVAILABLE',
    );
    const blocked = loginErrorOf(
      new Error("Login blocked: this machine's managed settings do not permit signing in (allowedProviders)"),
      'start',
    );
    expect(blocked).toEqual(makeError('LOGIN_BLOCKED'));
    expect(loginErrorOf(new Error("forceLoginMethod is 'claudeai' in managed settings"), 'start').code).toBe(
      'LOGIN_BLOCKED',
    );
    expect(loginErrorOf(new Error('No active claude_authenticate flow'), 'code')).toEqual(
      makeError('LOGIN_FAILED', { reason: 'expired' }),
    );
    expect(loginErrorOf(timeout(), 'wait').params).toEqual({ reason: 'expired' });
    expect(loginErrorOf(timeout(), 'start').params).toEqual({ reason: 'failed' });
    expect(loginErrorOf(new Error('session closed'), 'wait').params).toEqual({ reason: 'process' });
    expect(loginErrorOf(new Error('Request failed with status code 400 (someone@example.invalid)'), 'code')).toEqual(
      makeError('LOGIN_FAILED', { reason: 'code' }),
    );
    expect(loginErrorOf('odd', 'wait')).toEqual(makeError('LOGIN_FAILED', { reason: 'failed' }));
  });

  it('hasLoginMethods checks existence only', () => {
    const fn = (): Promise<unknown> => Promise.reject(new Error('never called'));
    expect(hasLoginMethods({ claudeAuthenticate: fn, claudeOAuthCallback: fn, claudeOAuthWaitForCompletion: fn })).toBe(
      true,
    );
    expect(hasLoginMethods({ claudeAuthenticate: fn, claudeOAuthCallback: fn })).toBe(false);
    expect(hasLoginMethods({})).toBe(false);
  });
});
