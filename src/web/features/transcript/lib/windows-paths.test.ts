import { describe, expect, it } from 'vitest';
import { preserveWindowsPaths } from './windows-paths';

describe('preserveWindowsPaths (V2-12)', () => {
  it.each([
    // Paths in running text: backslashes before punctuation are doubled (shown as typed).
    ['C:\\Users\\user\\.claude', 'C:\\Users\\user\\\\.claude'],
    ['see D:\\work\\_build\\out.txt.', 'see D:\\work\\\\_build\\out.txt.'],
    ['(C:\\work\\[draft]\\*.md)', '(C:\\work\\\\[draft]\\\\*.md)'],
    ['**C:\\work\\**', '**C:\\work\\\\**'],
    ['c:\\temp\\', 'c:\\temp\\\\'],
    ['C:\\\\Users', 'C:\\\\\\Users'],
    ['two: C:\\a\\.x and D:\\b\\.y', 'two: C:\\a\\\\.x and D:\\b\\\\.y'],
    // V4-01: folder names with spaces – the rest of the path after a space is protected too.
    ['C:\\Users\\Max Mustermann\\.claude', 'C:\\Users\\Max Mustermann\\\\.claude'],
    ['C:\\Program Files\\_x\\a b\\.y.', 'C:\\Program Files\\\\_x\\a b\\\\.y.'],
    // … but not an escape at the start of the next word.
    ['C:\\x\\a.ts and \\*bold\\*', 'C:\\x\\a.ts and \\*bold\\*'],
    // No path: unchanged (counter checks – escapes outside paths stay escapes).
    ['\\*not bold\\*', '\\*not bold\\*'],
    ['snake\\_case and \\_\\_init\\_\\_', 'snake\\_case and \\_\\_init\\_\\_'],
    ['file:\\.x is no drive', 'file:\\.x is no drive'],
    ['A:B\\.c', 'A:B\\.c'],
    ['C:/Users/user/.claude', 'C:/Users/user/.claude'],
    // Code stays literal: inline code, fenced code, indented lines.
    ['`C:\\Users\\.claude` and C:\\x\\.y', '`C:\\Users\\.claude` and C:\\x\\\\.y'],
    ['``a ` C:\\x\\.y``', '``a ` C:\\x\\.y``'],
    // An escaped backtick opens no code span.
    ['\\`C:\\x\\.y', '\\`C:\\x\\\\.y'],
    [
      '```\nC:\\Users\\.claude\n```\nC:\\Users\\.claude',
      '```\nC:\\Users\\.claude\n```\nC:\\Users\\\\.claude',
    ],
    ['~~~ps\nC:\\a\\.b\n~~~', '~~~ps\nC:\\a\\.b\n~~~'],
    ['    C:\\indented\\.code', '    C:\\indented\\.code'],
    // WP-55: UNC and device paths keep their leading `\\` (and dots) – shown as typed.
    ['open \\\\server\\share\\x.txt', 'open \\\\\\server\\share\\x.txt'],
    ['(\\\\srv\\c$\\.git)', '(\\\\\\srv\\c$\\\\.git)'],
    ['\\\\?\\C:\\x\\.y', '\\\\\\\\?\\C:\\x\\\\.y'],
    ['\\\\.\\pipe\\x', '\\\\\\\\.\\pipe\\x'],
    ['`\\\\server\\share` stays code', '`\\\\server\\share` stays code'],
    // No UNC path: an escaped backslash in prose stays an escape.
    ['write \\\\n or a\\\\b\\\\c', 'write \\\\n or a\\\\b\\\\c'],
  ])('%j → %j', (input, expected) => {
    expect(preserveWindowsPaths(input)).toBe(expected);
  });

  it('leaves texts without a drive path as the same string', () => {
    const text = 'No paths here, just \\*stars\\*.';
    expect(preserveWindowsPaths(text)).toBe(text);
  });
});
