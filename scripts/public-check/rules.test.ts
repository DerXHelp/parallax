/**
 * WP-84: rules of the public-repo check. Samples that must trigger a rule are assembled at runtime,
 * so this file itself stays clean for the repo scan (repo.test.ts).
 */
import { describe, expect, it } from 'vitest';
import {
  environmentPatterns,
  isAllowedIdentityEmail,
  parsePrivateList,
  privateTermPatterns,
  scanText,
  type ScanContext,
} from './rules';

const BS = '\\';
const EMPTY: ScanContext = { privateTerms: [], environment: [] };

function rules(text: string, context: ScanContext = EMPTY, commitMessage = false): string[] {
  return scanText(text, context, { commitMessage }).map((f) => `${String(f.line)}:${f.rule}`);
}

describe('user paths', () => {
  it('finds real names in every spelling', () => {
    expect(rules(['C:', 'Users', 'kimberly', 'x'].join(BS))).toEqual(['1:user-path']);
    expect(rules(['C:', 'Users', 'kimberly'].join(BS + BS))).toEqual(['1:user-path']);
    expect(rules('see\nc:/' + 'users/Kimberly/AppData')).toEqual(['2:user-path']);
    expect(rules('/c/' + 'Users/kimberly/x')).toEqual(['1:user-path']);
    expect(rules('~/.claude/projects/C--' + 'Users-kimberly-AppData-x')).toEqual(['1:user-path']);
  });

  it('allows placeholders and invented names', () => {
    for (const name of ['<USER>', '%USERNAME%', '…', 'Jane.Doe', 'someone', 'x', 'Max']) {
      expect(rules(['C:', 'Users', name, 'a'].join(BS))).toEqual([]);
    }
    expect(rules('C--Users-<USER>-AppData')).toEqual([]);
    expect(rules('%USERPROFILE%\\.claude')).toEqual([]);
  });
});

describe('e-mail addresses', () => {
  it('finds real addresses', () => {
    expect(rules('mail ' + 'kim' + '@' + 'mailbox.org')).toEqual(['1:email']);
  });

  it('allows example domains, noreply, file names and URL user info', () => {
    expect(rules('a@b.example, x.y@corp.example, jo@example.com, t@host.invalid')).toEqual([]);
    expect(rules('27100284+DerXHelp@users.noreply.github.com noreply@anthropic.com git@github.com')).toEqual(
      [],
    );
    expect(rules('u200b@README.md')).toEqual([]);
    expect(rules('https://user:secret@nexus.corp/repo and https://evil.com@claude.ai')).toEqual([]);
  });
});

describe('session links and secrets', () => {
  it('finds real-looking session links, allows invented ones', () => {
    expect(rules('https://claude.ai/code/session_' + '01AbCdEfGhIjKlMnOpQrStUv')).toEqual(['1:session-link']);
    expect(rules('https://claude.ai/chat/' + '0b8e9c4a-1f2d-4e5b-9a6c-7d8e9f0a1b2c')).toEqual([
      '1:session-link',
    ]);
    expect(rules('https://claude.ai/code/session_01ExampleSessionId000000')).toEqual([]);
    expect(rules('https://claude.ai/code/session_fakeabc https://claude.ai/code/session_…')).toEqual([]);
  });

  it('finds key material, allows short test strings', () => {
    expect(rules('sk-ant-' + 'api03-' + 'A'.repeat(40))).toEqual(['1:secret']);
    expect(rules('-----BEGIN ' + 'PRIVATE KEY-----')).toEqual(['1:secret']);
    expect(rules('ghp_' + 'a'.repeat(36))).toEqual(['1:secret']);
    expect(rules('sk-ant-abcdefghijkl and sk-ant-…')).toEqual([]);
  });
});

describe('local list', () => {
  it('parses one term per line, skips comments and blank lines', () => {
    expect(parsePrivateList('# comment\nAlpha Corp\r\n\n  beta  \nx\n')).toEqual(['Alpha Corp', 'beta']);
  });

  it('matches whole words only, case-insensitively', () => {
    const context: ScanContext = {
      privateTerms: privateTermPatterns(['zorblat', 'Alpha Corp']),
      environment: [],
    };
    expect(rules('the ZORBLAT team', context)).toEqual(['1:private-term']);
    expect(rules('x\nalpha corp (Berlin)', context)).toEqual(['2:private-term']);
    expect(rules('zorblatter, superzorblat, zorblatId', context)).toEqual([]);
    expect(rules('zorblat_x zorblat-y', context)).toEqual(['1:private-term']);
  });
});

describe('environment', () => {
  it('finds the OS user name as a word and the checkout path in all spellings', () => {
    const context: ScanContext = {
      privateTerms: [],
      environment: environmentPatterns({
        userName: 'Kimberly',
        checkoutPaths: ['E:\\work\\my repo\\parallax'],
      }),
    };
    expect(rules('owner kimberly here', context)).toEqual(['1:os-user']);
    expect(rules('SuperKimberly', context)).toEqual([]);
    expect(rules(['E:', 'work', 'my repo', 'parallax', 'x'].join(BS), context)).toEqual(['1:repo-path']);
    expect(rules('e:/work/my repo/parallax', context)).toEqual(['1:repo-path']);
    expect(rules('/e/work/my repo/parallax/src', context)).toEqual(['1:repo-path']);
    expect(rules('E--work-my-repo-parallax', context)).toEqual(['1:repo-path']);
    expect(rules('E:/work/my repo/parallax2', context)).toEqual([]);
  });

  it('skips generic user names', () => {
    expect(environmentPatterns({ userName: 'runneradmin', checkoutPaths: [] })).toEqual([]);
    expect(environmentPatterns({ userName: 'user', checkoutPaths: [] })).toEqual([]);
  });
});

describe('commit metadata', () => {
  it('flags Claude attribution trailers in messages only', () => {
    const trailer = 'Co-Authored-By: Claude <noreply@anthropic.com>';
    expect(rules(`Fix\n\n${trailer}`, EMPTY, true)).toEqual(['3:attribution']);
    expect(rules(`Fix\n\nClaude-Session: https://claude.ai/code/x`, EMPTY, true)).toEqual(['3:attribution']);
    expect(rules(`Fix\n\n${trailer}`)).toEqual([]);
  });

  it('allows only GitHub noreply addresses as author and committer', () => {
    expect(isAllowedIdentityEmail('27100284+DerXHelp@users.noreply.github.com')).toBe(true);
    expect(isAllowedIdentityEmail('noreply@github.com')).toBe(true);
    expect(isAllowedIdentityEmail('49699333+dependabot[bot]@users.noreply.github.com')).toBe(true);
    expect(isAllowedIdentityEmail('kim' + '@' + 'mailbox.org')).toBe(false);
  });
});
