import { describe, expect, it } from 'vitest';
import { cliVersionStatus, compareVersions } from './version';

describe('version rule C.7 (one implementation, WP-30 §4.9)', () => {
  it.each([
    ['2.1.300', '2.1.296', 1],
    ['2.1.296', '2.1.296', 0],
    ['2.1.9', '2.1.10', -1],
    ['v2.1.300', '2.1.300', 0],
    ['2.1.300-beta.1', '2.1.300', -1],
    ['2.1.300-beta.2', '2.1.300-beta.10', -1],
    ['2.1.300+build.5', '2.1.300', 0],
    ['2.1.300 (Claude Code)', '2.1.300', null],
    ['x', '2.1.300', null],
  ])('compareVersions(%s, %s) = %s', (a, b, expected) => {
    expect(compareVersions(a, b)).toBe(expected);
  });

  it('cliVersionStatus', () => {
    expect(cliVersionStatus('2.1.300', '2.1.296')).toBe('ok');
    expect(cliVersionStatus('2.1.200', '2.1.296')).toBe('too_old');
    expect(cliVersionStatus(null, '2.1.296')).toBe('unknown');
    expect(cliVersionStatus('2.1.300', null)).toBe('unknown');
    expect(cliVersionStatus('garbage', '2.1.296')).toBe('unknown');
  });
});
