import { describe, expect, it } from 'vitest';
import { conPtyCommandLine } from './conpty';

/** The binding itself runs only in the spike (WP-98) and the opt-in test of WP-99. */
describe('conPtyCommandLine (WP-98)', () => {
  it('always quotes the program and quotes arguments only when needed', () => {
    expect(conPtyCommandLine('C:\\Windows\\System32\\cmd.exe', [])).toBe('"C:\\Windows\\System32\\cmd.exe"');
    expect(conPtyCommandLine('C:\\Program Files\\Git\\bin\\bash.exe', ['--login', '-i'])).toBe(
      '"C:\\Program Files\\Git\\bin\\bash.exe" --login -i',
    );
    expect(conPtyCommandLine('D:\\Tools\\x.exe', ['a b', 'c"d', 'e\\'])).toBe(
      '"D:\\Tools\\x.exe" "a b" "c\\"d" e\\',
    );
  });
});
