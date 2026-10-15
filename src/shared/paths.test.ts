import { describe, expect, it } from 'vitest';
import {
  PATH_ISSUES,
  PATH_MAX_CHARS,
  isSafeWindowsPath,
  isWindowsPathInside,
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

  it('every issue is covered by a case', () => {
    expect([...new Set(rejected.map(([, issue]) => issue))].sort()).toEqual([...PATH_ISSUES].sort());
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
