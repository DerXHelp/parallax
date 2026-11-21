import { describe, expect, it } from 'vitest';
import { POSIX_PATHS } from '@shared/paths';
import { createMemoryFs } from '../lib/windows';
import {
  TERMINAL_EMULATOR_NAMES,
  resolveTerminalEmulator,
  terminalCommandArgs,
  terminalKindOf,
  type TerminalEmulatorKind,
} from './terminalEmulator';

const PATH = '/home/demo/.local/bin:/usr/local/bin:/usr/bin';
const env = { PATH };
const memory = (files: readonly string[], notExecutable: readonly string[] = []) =>
  createMemoryFs(Object.fromEntries(files.map((file) => [file, ''])), { rules: POSIX_PATHS, notExecutable });

describe('terminal emulators (WP-106, WP-100 §5.5)', () => {
  it('lookup order: xdg-terminal-exec, x-terminal-emulator, then the known ones on PATH', async () => {
    expect(TERMINAL_EMULATOR_NAMES.map(([name]) => name)).toEqual([
      'xdg-terminal-exec',
      'x-terminal-emulator',
      'ptyxis',
      'gnome-terminal',
      'konsole',
      'xfce4-terminal',
      'kitty',
      'alacritty',
      'wezterm',
      'foot',
      'xterm',
    ]);
    const all = memory(['/usr/bin/xterm', '/usr/bin/konsole', '/usr/bin/x-terminal-emulator']);
    expect(await resolveTerminalEmulator({ configured: null, env, fs: all })).toEqual({
      file: '/usr/bin/x-terminal-emulator',
      kind: 'x-terminal-emulator',
    });
    const kde = memory(['/usr/bin/xterm', '/usr/bin/konsole']);
    expect(await resolveTerminalEmulator({ configured: null, env, fs: kde })).toEqual({
      file: '/usr/bin/konsole',
      kind: 'konsole',
    });
    // The first PATH entry wins; a file without the execute bit does not count.
    const local = memory(
      ['/home/demo/.local/bin/kitty', '/usr/bin/kitty', '/usr/bin/foot'],
      ['/home/demo/.local/bin/kitty'],
    );
    expect(await resolveTerminalEmulator({ configured: null, env, fs: local })).toEqual({
      file: '/usr/bin/kitty',
      kind: 'kitty',
    });
    expect(await resolveTerminalEmulator({ configured: null, env, fs: memory([]) })).toBeNull();
    // No PATH: nothing is searched (never the working folder).
    expect(await resolveTerminalEmulator({ configured: null, env: {}, fs: all })).toBeNull();
  });

  it('a configured program must be absolute, safe and executable – never a silent fallback', async () => {
    const fs = memory(['/opt/term/myterm', '/usr/bin/xterm']);
    expect(await resolveTerminalEmulator({ configured: '/opt/term/myterm', env, fs })).toEqual({
      file: '/opt/term/myterm',
      kind: 'generic',
    });
    expect(await resolveTerminalEmulator({ configured: '/usr/bin/xterm', env, fs })).toEqual({
      file: '/usr/bin/xterm',
      kind: 'xterm',
    });
    for (const configured of ['/opt/term/missing', 'xterm', '../bin/xterm', '/proc/self/exe']) {
      expect(await resolveTerminalEmulator({ configured, env, fs })).toBeNull();
    }
    expect(fs.touched.some((file) => file.startsWith('/proc'))).toBe(false);
  });

  it('kind by base name', () => {
    expect(terminalKindOf('/usr/bin/gnome-terminal')).toBe('gnome-terminal');
    expect(terminalKindOf('/usr/local/bin/wezterm')).toBe('wezterm');
    expect(terminalKindOf('/usr/bin/tilix')).toBe('generic');
  });

  it.each<[TerminalEmulatorKind, string[]]>([
    ['xdg-terminal-exec', ['/usr/bin/claude', '--resume', 'x y']],
    [
      'ptyxis',
      ['--new-window', '--working-directory=/home/demo/my work', '--', '/usr/bin/claude', '--resume', 'x y'],
    ],
    [
      'gnome-terminal',
      ['--window', '--working-directory=/home/demo/my work', '--', '/usr/bin/claude', '--resume', 'x y'],
    ],
    ['konsole', ['--workdir', '/home/demo/my work', '-e', '/usr/bin/claude', '--resume', 'x y']],
    [
      'xfce4-terminal',
      ['--window', '--working-directory=/home/demo/my work', '-x', '/usr/bin/claude', '--resume', 'x y'],
    ],
    ['kitty', ['--directory', '/home/demo/my work', '/usr/bin/claude', '--resume', 'x y']],
    ['alacritty', ['--working-directory', '/home/demo/my work', '-e', '/usr/bin/claude', '--resume', 'x y']],
    [
      'wezterm',
      [
        'start',
        '--always-new-process',
        '--cwd',
        '/home/demo/my work',
        '--',
        '/usr/bin/claude',
        '--resume',
        'x y',
      ],
    ],
    ['foot', ['--working-directory=/home/demo/my work', '/usr/bin/claude', '--resume', 'x y']],
    ['x-terminal-emulator', ['-e', '/usr/bin/claude', '--resume', 'x y']],
    ['xterm', ['-e', '/usr/bin/claude', '--resume', 'x y']],
    ['generic', ['-e', '/usr/bin/claude', '--resume', 'x y']],
  ])('%s: arguments for one window in the folder running the command', (kind, expected) => {
    expect(terminalCommandArgs(kind, '/home/demo/my work', ['/usr/bin/claude', '--resume', 'x y'])).toEqual(
      expected,
    );
  });
});
