import { describe, expect, it } from 'vitest';
import { PLAIN_STYLE, applySgr, parseAnsi, stripAnsi } from './ansi';
import { computeFallbackRows, contentToRows, diffStats, hunksToRows, peekFallbackRows } from './diff';
import { languageForPath, resolveLanguage } from './languages';
import { splitMarkdownBlocks } from './markdown-blocks';
import { markdownUrlTransform, safeHttpUrl } from './safe-url';
import { SizedLru } from './sized-cache';
import { clipForDisplay, countLines, firstLine, normalizeTerminalText, stripToolUseError } from './text';

const ESC = '\u001b';

describe('parseAnsi', () => {
  it('turns SGR colors into styles and keeps the text', () => {
    const segments = parseAnsi(`${ESC}[32m✓${ESC}[39m ok ${ESC}[1;31mfail${ESC}[0m`);
    expect(segments.map((s) => s.text)).toEqual(['✓', ' ok ', 'fail']);
    expect(segments[0]?.style.fg).toBe('green');
    expect(segments[1]?.style).toBe(PLAIN_STYLE);
    expect(segments[2]?.style).toMatchObject({ fg: 'red', bold: true });
  });

  it('drops cursor movement, OSC titles/hyperlinks and stray control characters', () => {
    const text = `${ESC}]0;evil title\u0007${ESC}]8;;https://x.test${ESC}\\link${ESC}]8;;${ESC}\\${ESC}[2K${ESC}[999;1Hdone\u0008\u0000!`;
    expect(stripAnsi(text)).toBe('linkdone!');
  });

  it('keeps HTML as plain text (rendered as React text, never markup)', () => {
    expect(stripAnsi(`${ESC}[31m<script>alert(1)</script>${ESC}[0m`)).toBe('<script>alert(1)</script>');
  });

  it('handles 256 colors, background, bright colors and resets', () => {
    expect(applySgr(PLAIN_STYLE, '38;5;9').fg).toBe('red');
    expect(applySgr(PLAIN_STYLE, '38;5;200').fg).toBeNull();
    expect(applySgr(PLAIN_STYLE, '38;2;1;2;3;4').fg).toBeNull();
    expect(applySgr(PLAIN_STYLE, '38;2;1;2;3;4').underline).toBe(true);
    expect(applySgr(PLAIN_STYLE, '44').bg).toBe('blue');
    expect(applySgr(PLAIN_STYLE, '96').fg).toBe('cyan');
    expect(applySgr(applySgr(PLAIN_STYLE, '1;3;4'), '22;23;24')).toMatchObject({
      bold: false,
      italic: false,
      underline: false,
    });
    expect(applySgr(applySgr(PLAIN_STYLE, '31'), '')).toBe(PLAIN_STYLE);
  });

  it('ignores an unterminated escape at the end', () => {
    expect(stripAnsi(`abc${ESC}[3`)).toBe('abc');
  });
});

describe('terminal text', () => {
  it('normalizes CRLF and carriage-return progress output', () => {
    expect(normalizeTerminalText('a\r\nb\r\n')).toBe('a\nb\n');
    expect(normalizeTerminalText('10%\r50%\r100%\ndone')).toBe('100%\ndone');
    expect(normalizeTerminalText('line\r')).toBe('line');
  });

  it('counts lines and shortens summaries', () => {
    expect(countLines('')).toBe(0);
    expect(countLines('a\nb\n')).toBe(2);
    expect(countLines('a\nb')).toBe(2);
    expect(firstLine('  first\nsecond')).toBe('first');
    expect(firstLine('x'.repeat(20), 10)).toBe(`${'x'.repeat(9)}…`);
    expect(stripToolUseError('<tool_use_error>Blocked</tool_use_error>')).toBe('Blocked');
  });
});

describe('splitMarkdownBlocks', () => {
  it('splits on blank lines outside code fences', () => {
    const blocks = splitMarkdownBlocks('# Title\ntext\n\n```ts\na\n\nb\n```\n\nend\n');
    expect(blocks.map((b) => b.text)).toEqual(['# Title\ntext', '```ts\na\n\nb\n```', 'end']);
    expect(blocks.every((b) => !b.openFence)).toBe(true);
  });

  it('keeps loose lists and indented continuations in one block', () => {
    const blocks = splitMarkdownBlocks('- a\n\n- b\n\n  more of b\n\nafter\n');
    expect(blocks.map((b) => b.text)).toEqual(['- a\n\n- b\n\n  more of b', 'after']);
  });

  it('marks an unclosed fence at the end', () => {
    const blocks = splitMarkdownBlocks('text\n\n~~~~py\nprint(1)\n~~~\n');
    expect(blocks.at(-1)).toEqual({ text: '~~~~py\nprint(1)\n~~~\n', openFence: true });
    expect(splitMarkdownBlocks('```\ncode\n```').at(-1)?.openFence).toBe(false);
  });

  it('is stable while streaming: earlier blocks never change when text is appended', () => {
    const text = [
      'Intro **bold**',
      '',
      '1. one',
      '',
      '2. two',
      '',
      '```ts',
      'const a = 1;',
      '',
      'const b = 2;',
      '```',
      '',
      '| a | b |',
      '|---|---|',
      '| 1 | 2 |',
      '',
      '> quote',
    ].join('\n');
    const final = splitMarkdownBlocks(text);
    for (let end = 1; end <= text.length; end++) {
      const partial = splitMarkdownBlocks(text.slice(0, end));
      // All but the last block of every prefix are final blocks already.
      for (let i = 0; i < partial.length - 1; i++) expect(partial[i]?.text).toBe(final[i]?.text);
    }
  });

  it('normalizes CRLF', () => {
    expect(splitMarkdownBlocks('a\r\n\r\nb\r\n').map((b) => b.text)).toEqual(['a', 'b']);
  });

  it('keeps an incomplete last line with the previous block (it may still become a list item)', () => {
    expect(splitMarkdownBlocks('1. one\n\n2').map((b) => b.text)).toEqual(['1. one\n\n2']);
    expect(splitMarkdownBlocks('1. one\n\n2. two\n').map((b) => b.text)).toEqual(['1. one\n\n2. two']);
    expect(splitMarkdownBlocks('1. one\n\nPara\n').map((b) => b.text)).toEqual(['1. one', 'Para']);
  });
});

describe('safeHttpUrl', () => {
  it('allows only absolute http(s) URLs', () => {
    expect(safeHttpUrl('https://example.com/a?b=1')).toBe('https://example.com/a?b=1');
    expect(safeHttpUrl(' HTTP://Example.com ')).toBe('http://example.com/');
    for (const url of [
      'javascript:alert(1)',
      'JaVaScRiPt:alert(1)',
      '\u0000javascript:alert(1)',
      'data:text/html;base64,PHNjcmlwdD4=',
      'vbscript:msgbox(1)',
      'file:///C:/Windows',
      'mailto:a@b.c',
      '//evil.example',
      '/relative',
      '../secrets',
      'https:\\\\evil',
      'http://',
      '',
    ]) {
      expect(safeHttpUrl(url)).toBeNull();
    }
    expect(safeHttpUrl(null)).toBeNull();
    expect(markdownUrlTransform('javascript:alert(1)')).toBe('');
  });
});

describe('diff rows', () => {
  it('builds rows with line numbers from structuredPatch hunks', () => {
    const rows = hunksToRows([
      {
        oldStart: 4,
        oldLines: 3,
        newStart: 4,
        newLines: 3,
        lines: [' a', '-b', '+c', ' d', '\\ No newline at end of file'],
      },
    ]);
    expect(rows.map((r) => [r.kind, r.text, r.oldLine, r.newLine])).toEqual([
      ['hunk', '@@ -4,3 +4,3 @@', null, null],
      ['context', 'a', 4, 4],
      ['remove', 'b', 5, null],
      ['add', 'c', null, 5],
      ['context', 'd', 6, 6],
    ]);
    expect(diffStats(rows)).toEqual({ added: 1, removed: 1 });
  });

  it('shows a new file as additions', () => {
    expect(contentToRows('a\r\nb\n').map((r) => [r.kind, r.text, r.newLine])).toEqual([
      ['add', 'a', 1],
      ['add', 'b', 2],
    ]);
    expect(contentToRows('')).toEqual([]);
  });

  it('computes the jsdiff fallback from old_string/new_string and caches it', async () => {
    expect(peekFallbackRows('alpha\nbeta', 'alpha\ngamma')).toBeNull();
    const rows = await computeFallbackRows('alpha\nbeta', 'alpha\ngamma');
    expect(rows.filter((r) => r.kind !== 'hunk').map((r) => `${r.kind}:${r.text}`)).toEqual([
      'context:alpha',
      'remove:beta',
      'add:gamma',
    ]);
    expect(peekFallbackRows('alpha\nbeta', 'alpha\ngamma')).toBe(rows);
  });
});

describe('languages', () => {
  it('resolves fence info strings and file names', () => {
    expect(resolveLanguage('ts')).toBe('typescript');
    expect(resolveLanguage('TypeScript {1,3}')).toBe('typescript');
    expect(resolveLanguage('ps1')).toBe('powershell');
    expect(resolveLanguage('brainfuck')).toBeNull();
    expect(resolveLanguage(null)).toBeNull();
    expect(languageForPath('D:\\work\\a.tsx')).toBe('tsx');
    expect(languageForPath('/x/Dockerfile')).toBe('docker');
    expect(languageForPath('README')).toBeNull();
  });
});

describe('SizedLru (R2W-06/R2W-18)', () => {
  it('evicts the oldest entries over the count or the size budget, never the newest', () => {
    const cache = new SizedLru<string, string>({ maxEntries: 3, maxSize: 10 });
    cache.set('a', 'a', 4);
    cache.set('b', 'b', 4);
    expect(cache.count).toBe(2);
    cache.set('c', 'c', 4);
    expect([cache.peek('a'), cache.peek('b'), cache.peek('c')]).toEqual([undefined, 'b', 'c']);
    expect(cache.totalSize).toBe(8);
    cache.set('huge', 'h', 50);
    expect([cache.peek('b'), cache.peek('c'), cache.peek('huge')]).toEqual([undefined, undefined, 'h']);
    expect(cache.totalSize).toBe(50);
  });

  it('get refreshes an entry, peek does not; keep protects entries', () => {
    const cache = new SizedLru<string, string>({ maxEntries: 2, maxSize: 100 });
    cache.set('a', 'a', 1);
    cache.set('b', 'b', 1);
    expect(cache.get('a')).toBe('a');
    cache.set('c', 'c', 1);
    expect([cache.peek('a'), cache.peek('b')]).toEqual(['a', undefined]);
    cache.set('d', 'd', 1, (value) => value === 'a');
    expect([cache.peek('a'), cache.peek('c'), cache.peek('d')]).toEqual(['a', undefined, 'd']);
    cache.set('a', 'a2', 5);
    expect(cache.totalSize).toBe(6);
    cache.clear();
    expect([cache.count, cache.totalSize]).toEqual([0, 0]);
  });
});

describe('clipForDisplay (R2W-06)', () => {
  it('keeps texts within the budget and clips by chars or at a line end', () => {
    expect(clipForDisplay('a\nb', { chars: 10, lines: 10 })).toEqual({ text: 'a\nb', clipped: false });
    expect(clipForDisplay('abcdef', { chars: 4, lines: 10 })).toEqual({ text: 'abcd', clipped: true });
    expect(clipForDisplay('1\n2\n3\n4\n', { chars: 100, lines: 2 })).toEqual({ text: '1\n2', clipped: true });
    const log = 'line\n'.repeat(25_000);
    const clipped = clipForDisplay(log);
    expect(clipped.clipped).toBe(true);
    expect(countLines(clipped.text)).toBe(20_000);
  });
});
