import { describe, expect, it } from 'vitest';
import { createSanitizer, findGenericLeaks, pathPatternSource, PLACEHOLDERS } from './sanitize';

// Synthetic identities only – never real machine data in tests.
// API-key prefix assembled at runtime so a repo-wide grep for it stays clean.
const KEY_PREFIX = ['sk', 'ant', ''].join('-');
const secrets = {
  home: 'C:\\Users\\Jane.Doe',
  tmpDir: 'C:\\Users\\Jane.Doe\\AppData\\Local\\Temp',
  username: 'Jane.Doe',
  hostname: 'WORKSTATION-42',
  emails: ['jane.doe@example.org'],
  orgNames: ["jane.doe@example.org's Organization"],
  ids: ['11111111-2222-3333-4444-555555555555'],
};

describe('pathPatternSource', () => {
  const pattern = new RegExp(pathPatternSource('C:\\Users\\Jane.Doe'), 'i');
  it.each([
    ['backslashes', 'C:\\Users\\Jane.Doe\\x'],
    ['JSON-escaped backslashes', 'C:\\\\Users\\\\Jane.Doe'],
    ['forward slashes', 'file:///C:/Users/Jane.Doe/x'],
    ['lower-case drive', 'c:\\users\\jane.doe'],
    ['project-dir encoding', 'C--Users-Jane-Doe-AppData'],
    ['url-encoded', 'C:%5CUsers%5CJane.Doe'],
  ])('matches %s', (_label, text) => {
    expect(pattern.test(text)).toBe(true);
  });
});

describe('createSanitizer', () => {
  it('replaces scratch, home and user paths in every spelling', () => {
    const s = createSanitizer(secrets);
    expect(s.text('C:\\Users\\Jane.Doe\\AppData\\Local\\Temp\\parallax-spike-20261015-005104\\work\\a')).toBe(
      `${PLACEHOLDERS.scratch}\\work\\a`,
    );
    expect(s.text('C--Users-Jane-Doe-AppData-Local-Temp-parallax-spike-20261015-005104-work-a')).toBe(
      `${PLACEHOLDERS.scratch}-work-a`,
    );
    expect(s.text('"C:\\\\Users\\\\Jane.Doe\\\\.claude\\\\plans"')).toBe(
      `"${PLACEHOLDERS.home}\\\\.claude\\\\plans"`,
    );
    expect(s.text('c:/users/jane.doe/.local/bin/claude.exe')).toBe(
      `${PLACEHOLDERS.home}/.local/bin/claude.exe`,
    );
    expect(s.text('owner Jane.Doe on WORKSTATION-42')).toBe(
      `owner ${PLACEHOLDERS.user} on ${PLACEHOLDERS.host}`,
    );
  });

  it('replaces account data, org name before e-mail, and ids', () => {
    const s = createSanitizer(secrets);
    expect(s.text("jane.doe@example.org's Organization")).toBe(PLACEHOLDERS.org);
    expect(s.text('mail jane.doe@example.org or other@example.com')).toBe(
      `mail ${PLACEHOLDERS.email} or ${PLACEHOLDERS.email}`,
    );
    expect(s.text('noreply@anthropic.com stays')).toBe('noreply@anthropic.com stays');
    expect(s.text('org 11111111-2222-3333-4444-555555555555')).toBe(`org ${PLACEHOLDERS.accountId}`);
  });

  it('replaces token-like strings', () => {
    const s = createSanitizer({});
    expect(s.text(`key ${KEY_PREFIX}api03-abcdefghijklmnop`)).toBe(`key ${PLACEHOLDERS.token}`);
    expect(s.text('Authorization: Bearer abcdefghijklmnopqrstuvwx')).toBe(
      `Authorization: Bearer ${PLACEHOLDERS.token}`,
    );
    expect(s.text('ghp_abcdefghijklmnopqrstuvwxyz0123')).toBe(PLACEHOLDERS.token);
  });

  it('sanitizes keys and values deeply, learns secrets from sensitive keys', () => {
    const s = createSanitizer({});
    const value = s.value({
      account: {
        email: 'x.y@corp.example',
        organization: 'Corp Example Inc',
        subscriptionType: 'Claude Max',
      },
      text: 'contact Corp Example Inc today',
      apiKeySource: 'none',
      model: { displayName: 'Haiku', value: 'haiku' },
      block: { type: 'thinking', thinking: 'hmm', signature: 'EqABCDEF' },
      redacted: { type: 'redacted_thinking', data: 'opaque' },
      byQuestion: { 'Mail x.y@corp.example?': 'yes' },
    });
    expect(value).toEqual({
      account: { email: PLACEHOLDERS.email, organization: PLACEHOLDERS.org, subscriptionType: 'Claude Max' },
      text: `contact ${PLACEHOLDERS.org} today`,
      apiKeySource: 'none',
      model: { displayName: 'Haiku', value: 'haiku' },
      block: { type: 'thinking', thinking: 'hmm', signature: PLACEHOLDERS.signature },
      redacted: { type: 'redacted_thinking', data: PLACEHOLDERS.redacted },
      byQuestion: { [`Mail ${PLACEHOLDERS.email}?`]: 'yes' },
    });
  });

  it('does not learn enum-like values as secrets', () => {
    const s = createSanitizer({});
    s.learn({ organization: 'personal', user_name: 'claude' });
    expect(s.text('personal claude')).toBe('personal claude');
  });

  it('keeps session uuids and leaves clean text unchanged', () => {
    const s = createSanitizer(secrets);
    const text = '{"session_id":"a2aa36f5-56fb-42f9-af06-3db55a33470f","model":"claude-haiku-5-5"}';
    expect(s.text(text)).toBe(text);
    expect(s.findLeaks(text)).toEqual([]);
  });

  it('findLeaks reports remaining personal data', () => {
    const s = createSanitizer(secrets);
    expect(s.findLeaks('path C:\\Users\\Jane.Doe\\x')).not.toEqual([]);
    expect(s.findLeaks(`path ${PLACEHOLDERS.home}\\x and WORKSTATION-42`)).toEqual([
      'machine word (14 chars)',
    ]);
  });
});

describe('findGenericLeaks', () => {
  it('flags user paths, e-mails and tokens but not placeholders', () => {
    expect(findGenericLeaks('C:\\Users\\someone\\file')).toHaveLength(1);
    expect(findGenericLeaks('C--Users-someone-AppData')).toHaveLength(1);
    expect(findGenericLeaks('C:\\Users\\Public\\x')).toEqual([]);
    expect(findGenericLeaks('a@b.example')).toHaveLength(1);
    expect(findGenericLeaks(`${KEY_PREFIX}xxxxxxxxxxxx`)).toHaveLength(1);
    expect(findGenericLeaks(`${PLACEHOLDERS.home}\\.claude ${PLACEHOLDERS.email}`)).toEqual([]);
  });
});
