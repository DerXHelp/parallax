import { describe, expect, it } from 'vitest';
import {
  NAME_MAX_CHARS,
  PATH_ISSUES,
  PATH_MAX_CHARS,
  POSIX_PATHS,
  POSIX_PATH_MAX_BYTES,
  WIN32_PATHS,
  fromGitBashPath,
  isPosixPathInside,
  isSafePosixPath,
  isSafeWindowsPath,
  isWindowsPathInside,
  pathFlavorOf,
  pathFlavorOfShape,
  pathRules,
  posixBaseName,
  posixNameIssue,
  posixPathExtension,
  posixPathIssue,
  posixPathKey,
  posixPathsEqual,
  resolvePosixPath,
  resolveWindowsPath,
  windowsBaseName,
  windowsNameIssue,
  windowsPathExtension,
  windowsPathIssue,
  windowsPathKey,
  windowsPathsEqual,
  type PathIssue,
} from './paths';

describe('windowsPathIssue (C.10)', () => {
  it.each([
    'C:\\',
    'C:\\work\\x',
    'd:\\work\\x\\',
    'D:/work/x',
    'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
    'C:\\Users\\user\\.local\\bin\\claude.exe',
    'C:\\PROGRA~1\\x',
    'C:\\a\\\\b',
    'C:\\con10\\nul1\\com10',
    'C:\\x\\.hidden',
    'C:\\x\\ leading space',
  ])('accepts %s', (path) => {
    expect(windowsPathIssue(path)).toBeNull();
    expect(isSafeWindowsPath(path)).toBe(true);
  });

  const rejected: [string, PathIssue][] = [
    ['', 'empty'],
    [`C:\\${'x'.repeat(PATH_MAX_CHARS)}`, 'too_long'],
    ['C:\\work\u0000\\x', 'control_char'],
    ['C:\\work\n', 'control_char'],
    ['\\\\server\\share\\x', 'unc'],
    ['//server/share/x', 'unc'],
    ['\\/server\\share', 'unc'],
    ['\\\\?\\C:\\work', 'device'],
    ['\\\\.\\pipe\\x', 'device'],
    ['//?/C:/work', 'device'],
    ['\\??\\C:\\work', 'device'],
    ['work\\x', 'not_absolute'],
    ['\\work\\x', 'not_absolute'],
    ['C:work', 'not_absolute'],
    ['/c/work', 'not_absolute'],
    ['.\\x', 'not_absolute'],
    ['C:\\work\\file.txt:stream', 'ads'],
    ['C:\\work\\file.txt::$DATA', 'ads'],
    ['C:\\work\\a*b', 'invalid_char'],
    ['C:\\work\\a?b', 'invalid_char'],
    ['C:\\work\\<x>', 'invalid_char'],
    ['C:\\work\\a"b', 'invalid_char'],
    ['C:\\work\\a|b', 'invalid_char'],
    ['C:\\work\\..\\x', 'dot_segment'],
    ['C:\\work\\.\\x', 'dot_segment'],
    ['C:\\work.\\x', 'trailing_dot_or_space'],
    ['C:\\work \\x', 'trailing_dot_or_space'],
    ['C:\\work\\x.', 'trailing_dot_or_space'],
    ['C:\\work\\CON', 'reserved_name'],
    ['C:\\work\\nul.txt', 'reserved_name'],
    ['C:\\work\\Com1\\x', 'reserved_name'],
    ['C:\\work\\LPT9.log', 'reserved_name'],
    ['C:\\work\\aux .txt', 'reserved_name'],
    ['C:\\work\\CONOUT$', 'reserved_name'],
    ['C:\\work\\com¹', 'reserved_name'],
  ];

  it.each(rejected)('rejects %j as %s', (path, issue) => {
    expect(windowsPathIssue(path)).toBe(issue);
    expect(isSafeWindowsPath(path)).toBe(false);
  });

  it('every issue is covered by a case (except the POSIX-only pseudo_fs)', () => {
    expect([...new Set(rejected.map(([, issue]) => issue))].sort()).toEqual(
      [...PATH_ISSUES].filter((issue) => issue !== 'pseudo_fs').sort(),
    );
  });
});

describe('windowsNameIssue (WP-94: name of a new folder)', () => {
  it.each(['foobar', 'my project', '.claude', 'a.b.c', 'Ä-ö_ß (1)', 'x'.repeat(NAME_MAX_CHARS), 'console'])(
    'accepts %j',
    (name) => {
      expect(windowsNameIssue(name)).toBeNull();
    },
  );

  const rejected: readonly (readonly [string, PathIssue])[] = [
    ['', 'empty'],
    ['x'.repeat(NAME_MAX_CHARS + 1), 'too_long'],
    ['a\\b', 'invalid_char'],
    ['a/b', 'invalid_char'],
    ['a:b', 'invalid_char'],
    ['C:', 'invalid_char'],
    ['a?b', 'invalid_char'],
    ['a\tb', 'control_char'],
    ['.', 'dot_segment'],
    ['..', 'dot_segment'],
    ['name.', 'trailing_dot_or_space'],
    ['name ', 'trailing_dot_or_space'],
    ['CON', 'reserved_name'],
    ['nul.txt', 'reserved_name'],
  ];

  it.each(rejected)('rejects %j as %s', (name, issue) => {
    expect(windowsNameIssue(name)).toBe(issue);
  });
});

describe('comparison keys (B "case-insensitiv", cwd stays exact)', () => {
  it('ignores case, separator style, repeated and trailing separators', () => {
    expect(windowsPathKey('D:\\Work\\X\\')).toBe('d:\\work\\x');
    expect(windowsPathKey('d:/work//x')).toBe('d:\\work\\x');
    expect(windowsPathKey('C:\\')).toBe('c:\\');
    expect(windowsPathKey('C:')).toBe('c:\\');
    expect(windowsPathsEqual('D:\\work\\x', 'd:/WORK/x/')).toBe(true);
    expect(windowsPathsEqual('D:\\work\\x', 'D:\\work\\xy')).toBe(false);
  });

  it('inside: equal or below, never a sibling prefix', () => {
    expect(isWindowsPathInside('D:\\work\\x\\src', 'd:\\work\\x')).toBe(true);
    expect(isWindowsPathInside('D:\\work\\x', 'D:\\work\\x\\')).toBe(true);
    expect(isWindowsPathInside('D:\\work\\xy', 'D:\\work\\x')).toBe(false);
    expect(isWindowsPathInside('D:\\work', 'D:\\work\\x')).toBe(false);
    expect(isWindowsPathInside('C:\\anything', 'C:\\')).toBe(true);
  });
});

describe('file reference helpers (Phase 3, WP-50 §4.7)', () => {
  it.each([
    ['/c/Users/x', 'C:\\Users\\x'],
    ['/d/work/a b/c.ts', 'D:\\work\\a b\\c.ts'],
    ['/c', 'C:\\'],
    ['/c/', 'C:\\'],
  ])('fromGitBashPath(%j) = %j', (path, expected) => {
    expect(fromGitBashPath(path)).toBe(expected);
  });

  it.each(['/cc/x', 'c/x', 'C:\\x', '//server/share', '/'])('fromGitBashPath(%j) = null', (path) => {
    expect(fromGitBashPath(path)).toBeNull();
  });

  const resolved: [string, string, string | null][] = [
    ['C:\\work\\p', 'src/a.ts', 'C:\\work\\p\\src\\a.ts'],
    ['C:\\work\\p\\', './src\\a.ts', 'C:\\work\\p\\src\\a.ts'],
    ['C:\\work\\p', '../q/b.md', 'C:\\work\\q\\b.md'],
    ['C:\\work\\p', 'a//b', 'C:\\work\\p\\a\\b'],
    ['C:\\work\\p', '../..', 'C:\\'],
    ['C:\\work\\p', '../../..', null],
    ['C:\\work\\p', 'D:/x/y.txt', 'D:\\x\\y.txt'],
    ['C:\\work\\p', 'D:\\x\\..\\y', 'D:\\y'],
    ['C:\\work\\p', '\\\\server\\share\\x', null],
    ['C:\\work\\p', '//server/share/x', null],
    ['C:\\work\\p', '\\x', null],
    ['C:\\work\\p', 'C:x', null],
    ['C:\\work\\p', 'a:b', null],
    ['C:\\work\\p', 'CON', null],
    ['C:\\work\\p', 'x*y', null],
    ['\\\\server\\share', 'x', null],
    ['work', 'x', null],
  ];
  it.each(resolved)('resolveWindowsPath(%j, %j) = %j', (base, relative, expected) => {
    expect(resolveWindowsPath(base, relative)).toBe(expected);
  });

  it('base name and extension', () => {
    expect(windowsBaseName('C:\\a\\b.txt')).toBe('b.txt');
    expect(windowsBaseName('C:/a/b/')).toBe('b');
    expect(windowsBaseName('C:\\')).toBe('');
    expect(windowsPathExtension('C:\\a\\B.TXT')).toBe('txt');
    expect(windowsPathExtension('C:\\a\\x.tar.gz')).toBe('gz');
    expect(windowsPathExtension('C:\\a\\.gitignore')).toBe('');
    expect(windowsPathExtension('C:\\a.d\\Makefile')).toBe('');
  });
});

describe('posixPathIssue (WP-102, WP-100 E6)', () => {
  it.each([
    '/',
    '/home/u/proj',
    '/home/u/proj/',
    '/home//u/proj',
    '/home/u/Projekt mit Leerzeichen/äöü',
    '/home/u/a:b?c*d"e<f>g|h',
    '/home/u/CON',
    '/home/u/trailing.',
    '/home/u/trailing ',
    '/home/u/.hidden',
    '/home/u/...',
    '/mnt/c/Users',
    '/c/Users',
    '/run/user/1000/x',
    '/devices',
    '/process',
    '//server/share',
    `/${'a'.repeat(255)}`,
  ])('accepts %j', (path) => {
    expect(posixPathIssue(path)).toBeNull();
    expect(isSafePosixPath(path)).toBe(true);
  });

  const rejected: [string, PathIssue][] = [
    ['', 'empty'],
    ['home/u', 'not_absolute'],
    ['./x', 'not_absolute'],
    ['~/x', 'not_absolute'],
    ['C:\\work', 'not_absolute'],
    ['/home/u\0x', 'control_char'],
    ['/home/u\nx', 'control_char'],
    ['/home/u/./x', 'dot_segment'],
    ['/home/u/../etc', 'dot_segment'],
    ['/home/u/..', 'dot_segment'],
    [`/${'a'.repeat(256)}`, 'too_long'],
    [`/${'ä'.repeat(128)}`, 'too_long'],
    [`/${'a/'.repeat(2048)}`, 'too_long'],
    ['/proc', 'pseudo_fs'],
    ['/proc/self/environ', 'pseudo_fs'],
    ['/sys/kernel', 'pseudo_fs'],
    ['/dev/zero', 'pseudo_fs'],
    ['/dev/', 'pseudo_fs'],
    ['//proc/1', 'pseudo_fs'],
  ];
  it.each(rejected)('rejects %j as %s', (path, issue) => {
    expect(posixPathIssue(path)).toBe(issue);
  });

  it('returns only the POSIX subset of PATH_ISSUES', () => {
    expect([...new Set(rejected.map(([, issue]) => issue))].sort()).toEqual(
      ['control_char', 'dot_segment', 'empty', 'not_absolute', 'pseudo_fs', 'too_long'].sort(),
    );
  });

  it('counts UTF-8 bytes, not characters', () => {
    expect(posixPathIssue(`/${'ä'.repeat(127)}`)).toBeNull();
    expect(posixPathIssue(`/${'🚀'.repeat(63)}`)).toBeNull();
    expect(posixPathIssue(`/${'🚀'.repeat(64)}`)).toBe('too_long');
    const longest = `/${`${'a'.repeat(199)}/`.repeat(20)}${'a'.repeat(94)}`;
    expect(longest.length).toBe(POSIX_PATH_MAX_BYTES);
    expect(posixPathIssue(longest)).toBeNull();
    expect(posixPathIssue(`${longest}a`)).toBe('too_long');
  });

  it('new folder names', () => {
    expect(posixNameIssue('neu')).toBeNull();
    expect(posixNameIssue('CON')).toBeNull();
    expect(posixNameIssue('a:b')).toBeNull();
    expect(posixNameIssue('.config')).toBeNull();
    expect(posixNameIssue('')).toBe('empty');
    expect(posixNameIssue('a/b')).toBe('invalid_char');
    expect(posixNameIssue('.')).toBe('dot_segment');
    expect(posixNameIssue('..')).toBe('dot_segment');
    expect(posixNameIssue('a\tb')).toBe('control_char');
    expect(posixNameIssue('a'.repeat(256))).toBe('too_long');
  });
});

describe('POSIX keys, resolution and names', () => {
  it('keys are case-sensitive and normalize separators', () => {
    expect(posixPathKey('/home//u/proj/')).toBe('/home/u/proj');
    expect(posixPathKey('/')).toBe('/');
    expect(posixPathKey('///')).toBe('/');
    expect(posixPathsEqual('/a/Proj', '/a/proj')).toBe(false);
    expect(posixPathsEqual('/a/proj/', '/a//proj')).toBe(true);
  });

  it('inside', () => {
    expect(isPosixPathInside('/a/b/c', '/a/b')).toBe(true);
    expect(isPosixPathInside('/a/b', '/a/b/')).toBe(true);
    expect(isPosixPathInside('/a/bc', '/a/b')).toBe(false);
    expect(isPosixPathInside('/a/B/c', '/a/b')).toBe(false);
    expect(isPosixPathInside('/anything', '/')).toBe(true);
  });

  const resolved: [string, string, string | null][] = [
    ['/home/u/p', 'src/a.ts', '/home/u/p/src/a.ts'],
    ['/home/u/p', './src//a.ts', '/home/u/p/src/a.ts'],
    ['/home/u/p', '../q/x', '/home/u/q/x'],
    ['/home/u/p', '/etc/hosts', '/etc/hosts'],
    ['/home/u/p', '/a/../b', '/b'],
    ['/', 'x', '/x'],
    ['/home', '../..', null],
    ['/home/u/p', '../../../../x', null],
    ['/home/u/p', '/proc/self/environ', null],
    ['/home/u/p', 'a\0b', null],
    ['relative', 'x', null],
    ['C:\\work', 'x', null],
  ];
  it.each(resolved)('resolvePosixPath(%j, %j) = %j', (base, relative, expected) => {
    expect(resolvePosixPath(base, relative)).toBe(expected);
  });

  it('base name and extension', () => {
    expect(posixBaseName('/a/b.txt')).toBe('b.txt');
    expect(posixBaseName('/a/b/')).toBe('b');
    expect(posixBaseName('/')).toBe('');
    expect(posixBaseName('/a/back\\slash')).toBe('back\\slash');
    expect(posixPathExtension('/a/B.TXT')).toBe('txt');
    expect(posixPathExtension('/a/x.tar.gz')).toBe('gz');
    expect(posixPathExtension('/a/.gitignore')).toBe('');
    expect(posixPathExtension('/a.d/Makefile')).toBe('');
  });
});

describe('pathRules (WP-102)', () => {
  it('flavor from the platform', () => {
    expect(pathFlavorOf('win32')).toBe('win32');
    expect(pathFlavorOf('linux')).toBe('posix');
    expect(pathFlavorOf('darwin')).toBe('posix');
    expect(pathFlavorOfShape('/usr/bin/code')).toBe('posix');
    expect(pathFlavorOfShape('C:\\x')).toBe('win32');
    expect(pathFlavorOfShape('\\\\server\\share')).toBe('win32');
    expect(pathFlavorOfShape('code')).toBe('win32');
    expect(pathRules('win32')).toBe(WIN32_PATHS);
    expect(pathRules('posix')).toBe(POSIX_PATHS);
  });

  it('win32 delegates to the unchanged windows* functions', () => {
    expect(WIN32_PATHS.issue('C:\\x')).toBeNull();
    expect(WIN32_PATHS.issue('/home/u')).toBe('not_absolute');
    expect(WIN32_PATHS.equal('C:\\A', 'c:/a/')).toBe(true);
    expect(WIN32_PATHS.isInside('C:\\a\\b', 'c:\\A')).toBe(true);
    expect(WIN32_PATHS.isAbsolute('C:/x')).toBe(true);
    expect(WIN32_PATHS.isAbsolute('/x')).toBe(false);
    expect(WIN32_PATHS.maxLength).toBe(PATH_MAX_CHARS);
  });

  it('posix', () => {
    expect(POSIX_PATHS.issue('/home/u')).toBeNull();
    expect(POSIX_PATHS.issue('C:\\x')).toBe('not_absolute');
    expect(POSIX_PATHS.equal('/A', '/a')).toBe(false);
    expect(POSIX_PATHS.isAbsolute('/x')).toBe(true);
    expect(POSIX_PATHS.isAbsolute('C:\\x')).toBe(false);
    expect(POSIX_PATHS.maxLength).toBe(POSIX_PATH_MAX_BYTES);
  });

  it.each([
    [WIN32_PATHS, 'C:\\', 'a', 'C:\\a'],
    [WIN32_PATHS, 'C:\\work\\', '\\a.txt', 'C:\\work\\a.txt'],
    [WIN32_PATHS, 'C:/work', 'a', 'C:/work\\a'],
    [POSIX_PATHS, '/', 'a', '/a'],
    [POSIX_PATHS, '/home/u/', '/a.txt', '/home/u/a.txt'],
    [POSIX_PATHS, '/home/u', 'back\\slash', '/home/u/back\\slash'],
  ])('join %#', (rules, dir, name, expected) => {
    expect(rules.join(dir, name)).toBe(expected);
  });
});
