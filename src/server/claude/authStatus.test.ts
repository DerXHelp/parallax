import { describe, expect, it } from 'vitest';
import { claudeInstallStatusSchema } from '@shared/model';
import { sampleClaudeInstallStatus } from '@shared/samples';
import { UNKNOWN_AUTH, parseAuthStatus, parseRawAuthStatus } from './authStatus';

/** `claude auth status --json` of CLI 2.1.300 (docs/sdk-findings.md, Punkt 17; placeholders). */
const LOGGED_IN = JSON.stringify({
  loggedIn: true,
  authMethod: 'claude.ai',
  apiProvider: 'firstParty',
  analyticsDisabled: false,
  projectsDirectory: 'C:\\Users\\<USER>\\.claude\\projects',
  configDirectory: 'C:\\Users\\<USER>\\.claude',
  email: 'someone@example.com',
  orgId: '00000000-0000-0000-0000-000000000000',
  orgName: 'Example Org',
  subscriptionType: 'max',
});

describe('parseAuthStatus (F.17)', () => {
  it('maps the logged-in output to the contract view', () => {
    expect(parseAuthStatus(LOGGED_IN)).toEqual({
      state: 'logged_in',
      method: 'claude.ai',
      apiProvider: 'firstParty',
      subscriptionType: 'max',
    });
  });

  it('never returns e-mail or organization', () => {
    const view = parseAuthStatus(`${LOGGED_IN}\n`);
    expect(Object.keys(view).sort()).toEqual(['apiProvider', 'method', 'state', 'subscriptionType']);
    const text = JSON.stringify(view);
    expect(text).not.toContain('someone@example.com');
    expect(text).not.toContain('Example Org');
    expect(text).not.toContain('00000000-0000');
  });

  it('fits ClaudeInstallStatus.auth', () => {
    const status = sampleClaudeInstallStatus({ auth: parseAuthStatus(LOGGED_IN) });
    expect(claudeInstallStatusSchema.parse(status)).toEqual(status);
  });

  it.each<[string, unknown, ReturnType<typeof parseAuthStatus>]>([
    [
      'logged out',
      '{"loggedIn":false,"authMethod":"none","apiProvider":"firstParty"}',
      { state: 'logged_out', method: 'none', apiProvider: 'firstParty', subscriptionType: null },
    ],
    [
      'api key login (no subscription)',
      { loggedIn: true, authMethod: 'api_key', apiProvider: 'firstParty', subscriptionType: null },
      { state: 'logged_in', method: 'api_key', apiProvider: 'firstParty', subscriptionType: null },
    ],
    [
      'bedrock, minimal fields',
      { loggedIn: true, apiProvider: 'bedrock' },
      { state: 'logged_in', method: null, apiProvider: 'bedrock', subscriptionType: null },
    ],
    [
      'blank fields become null',
      { loggedIn: true, authMethod: '  ', apiProvider: '' },
      { state: 'logged_in', method: null, apiProvider: null, subscriptionType: null },
    ],
    [
      'long values are capped',
      { loggedIn: true, authMethod: 'x'.repeat(500) },
      { state: 'logged_in', method: 'x'.repeat(100), apiProvider: null, subscriptionType: null },
    ],
  ])('%s', (_name, input, view) => {
    expect(parseAuthStatus(input)).toEqual(view);
  });

  it.each([
    ['empty output', ''],
    ['text output', 'Login method: Claude Max account\nEmail: someone@example.com'],
    ['broken json', '{"loggedIn": tru'],
    ['missing loggedIn', '{"authMethod":"claude.ai"}'],
    ['wrong type', '{"loggedIn":"yes"}'],
    ['null', null],
    ['array', '[]'],
  ])('reports error for %s', (_name, input) => {
    expect(parseAuthStatus(input)).toEqual({ ...UNKNOWN_AUTH, state: 'error' });
  });
});

describe('parseRawAuthStatus (recorder only)', () => {
  it('keeps e-mail/org for the sanitizer and unknown fields', () => {
    const raw = parseRawAuthStatus(LOGGED_IN);
    expect(raw?.email).toBe('someone@example.com');
    expect(raw?.orgName).toBe('Example Org');
    expect(raw?.analyticsDisabled).toBe(false);
  });

  it('returns null for anything else', () => {
    expect(parseRawAuthStatus('nope')).toBeNull();
  });
});
