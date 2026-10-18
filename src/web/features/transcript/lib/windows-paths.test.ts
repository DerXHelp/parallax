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
  ])('%j → %j', (input, expected) => {
    expect(preserveWindowsPaths(input)).toBe(expected);
  });

  it('leaves texts without a drive path as the same string', () => {
    const text = 'No paths here, just \\*stars\\*.';
    expect(preserveWindowsPaths(text)).toBe(text);
  });
});
