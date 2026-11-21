import { describe, expect, it } from 'vitest';
import { POSIX_SHELL_KINDS, WINDOWS_SHELL_KINDS } from '@shared/model';
import { effectiveShell, preferredFirst, shellChoices } from './shells';

describe('shells of a host (WP-104)', () => {
  it('offers the kinds of the flavor, or the detected ones of that flavor', () => {
    expect(shellChoices('win32')).toEqual(WINDOWS_SHELL_KINDS);
    expect(shellChoices('posix')).toEqual(POSIX_SHELL_KINDS);
    expect(shellChoices('posix', ['login', 'zsh'])).toEqual(['login', 'zsh']);
    // Kinds of the other flavor are dropped; nothing left = the flavor's kinds.
    expect(shellChoices('posix', ['cmd', 'bash'])).toEqual(['bash']);
    expect(shellChoices('posix', ['cmd'])).toEqual(POSIX_SHELL_KINDS);
    expect(shellChoices('win32', null)).toEqual(WINDOWS_SHELL_KINDS);
  });

  it('keeps a setting the host offers, else falls back to the host default', () => {
    expect(effectiveShell('powershell', 'win32')).toBe('powershell');
    expect(effectiveShell('cmd', 'posix')).toBe('login');
    expect(effectiveShell('zsh', 'posix', ['bash', 'zsh'])).toBe('zsh');
    expect(effectiveShell('cmd', 'posix', ['bash', 'zsh'])).toBe('bash');
  });

  it('puts the preferred shell first when offered', () => {
    expect(preferredFirst('gitbash', WINDOWS_SHELL_KINDS)).toEqual(['gitbash', 'cmd', 'powershell']);
    expect(preferredFirst('cmd', ['login', 'bash'])).toEqual(['login', 'bash']);
  });
});
