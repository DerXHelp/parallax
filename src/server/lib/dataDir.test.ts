import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { defaultDataDir, defaultDataDirLabel } from './dataDir';

describe('defaultDataDir / defaultDataDirLabel (WP-103)', () => {
  it('Windows: %LOCALAPPDATA%\\Parallax, without it <home>\\AppData\\Local\\Parallax (unchanged)', () => {
    expect(defaultDataDir({ LOCALAPPDATA: 'C:\\Users\\u\\AppData\\Local' }, 'win32')).toBe(
      'C:\\Users\\u\\AppData\\Local\\Parallax',
    );
    expect(defaultDataDir({ LOCALAPPDATA: '' }, 'win32')).toBe(
      path.win32.join(os.homedir(), 'AppData', 'Local', 'Parallax'),
    );
    expect(defaultDataDirLabel({}, 'win32')).toBe('%LOCALAPPDATA%\\Parallax');
  });

  it('Linux: $XDG_DATA_HOME/parallax, otherwise ~/.local/share/parallax', () => {
    expect(defaultDataDir({ HOME: '/home/u' }, 'linux')).toBe('/home/u/.local/share/parallax');
    expect(defaultDataDirLabel({ HOME: '/home/u' }, 'linux')).toBe('~/.local/share/parallax');
    expect(defaultDataDir({ HOME: '/home/u', XDG_DATA_HOME: '/data/xdg' }, 'linux')).toBe(
      '/data/xdg/parallax',
    );
    expect(defaultDataDirLabel({ XDG_DATA_HOME: '/data/xdg' }, 'linux')).toBe('$XDG_DATA_HOME/parallax');
  });

  it('Linux: a relative or empty XDG_DATA_HOME is ignored (XDG Base Directory specification)', () => {
    for (const XDG_DATA_HOME of ['', 'relative', '~/data']) {
      expect(defaultDataDir({ HOME: '/home/u', XDG_DATA_HOME }, 'linux'), XDG_DATA_HOME).toBe(
        '/home/u/.local/share/parallax',
      );
      expect(defaultDataDirLabel({ XDG_DATA_HOME }, 'linux')).toBe('~/.local/share/parallax');
    }
  });

  it('Linux without HOME: the home folder of the account', () => {
    expect(defaultDataDir({}, 'linux')).toBe(path.posix.join(os.homedir(), '.local', 'share', 'parallax'));
  });
});
