import { describe, expect, it } from 'vitest';
import {
  findFileRefs,
  parseFileTarget,
  resolveFilePath,
  resolveFileRef,
  type FileRefKind,
} from './file-refs';

const CWD = 'D:\\work\\sample';

/** Compact form of one reference: [raw, path, line, col, kind, unsafe]. */
type Row = [string, string, number | null, number | null, FileRefKind, boolean];

function refsOf(text: string): Row[] {
  return findFileRefs(text).map((ref) => [ref.raw, ref.path, ref.line, ref.col, ref.kind, ref.unsafe]);
}

describe('findFileRefs', () => {
  it.each<[string, Row[]]>([
    // Drive paths, both separators
    ['see C:\\work\\a.ts here', [['C:\\work\\a.ts', 'C:\\work\\a.ts', null, null, 'drive', false]]],
    ['C:/Users/x/notes.txt', [['C:/Users/x/notes.txt', 'C:/Users/x/notes.txt', null, null, 'drive', false]]],
    ['d:\\work\\', [['d:\\work\\', 'd:\\work\\', null, null, 'drive', false]]],
    [
      'D:\\work\\sample\\README.md.',
      [['D:\\work\\sample\\README.md', 'D:\\work\\sample\\README.md', null, null, 'drive', false]],
    ],
    // Line and column suffixes
    ['C:\\work\\a.ts:12', [['C:\\work\\a.ts:12', 'C:\\work\\a.ts', 12, null, 'drive', false]]],
    ['C:\\work\\a.ts:12:4.', [['C:\\work\\a.ts:12:4', 'C:\\work\\a.ts', 12, 4, 'drive', false]]],
    ['at src/a.ts:7: error', [['src/a.ts:7', 'src/a.ts', 7, null, 'relative', false]]],
    ['src/a.ts#L12', [['src/a.ts#L12', 'src/a.ts', 12, null, 'relative', false]]],
    ['src/a.ts#L12-L20', [['src/a.ts#L12-L20', 'src/a.ts', 12, null, 'relative', false]]],
    ['src/a.ts#L3C9', [['src/a.ts#L3C9', 'src/a.ts', 3, 9, 'relative', false]]],
    ['src/a.ts:0', [['src/a.ts:0', 'src/a.ts', null, null, 'relative', false]]],
    // Punctuation, brackets and quotes around a reference
    ['(see src/a.ts)', [['src/a.ts', 'src/a.ts', null, null, 'relative', false]]],
    ['(src/a.ts:3)', [['src/a.ts:3', 'src/a.ts', 3, null, 'relative', false]]],
    [
      '"src/a.ts", \'docs/b.md\';',
      [
        ['src/a.ts', 'src/a.ts', null, null, 'relative', false],
        ['docs/b.md', 'docs/b.md', null, null, 'relative', false],
      ],
    ],
    [
      '„docs/b.md“ und «c/d.txt»!',
      [
        ['docs/b.md', 'docs/b.md', null, null, 'relative', false],
        ['c/d.txt', 'c/d.txt', null, null, 'relative', false],
      ],
    ],
    ['[src/a.ts]', [['src/a.ts', 'src/a.ts', null, null, 'relative', false]]],
    ['C:\\x\\file(1).ts', [['C:\\x\\file(1).ts', 'C:\\x\\file(1).ts', null, null, 'drive', false]]],
    ['<C:\\x\\a.log>', [['C:\\x\\a.log', 'C:\\x\\a.log', null, null, 'drive', false]]],
    ['path=src/a.ts', [['src/a.ts', 'src/a.ts', null, null, 'relative', false]]],
    ['→C:\\x\\a.ts', [['C:\\x\\a.ts', 'C:\\x\\a.ts', null, null, 'drive', false]]],
    // Relative paths
    ['./a.ts', [['./a.ts', './a.ts', null, null, 'relative', false]]],
    ['..\\b.md', [['..\\b.md', '..\\b.md', null, null, 'relative', false]]],
    [
      'node_modules/@types/node/index.d.ts',
      [
        [
          'node_modules/@types/node/index.d.ts',
          'node_modules/@types/node/index.d.ts',
          null,
          null,
          'relative',
          false,
        ],
      ],
    ],
    [
      'src\\Übersicht\\Größe.md',
      [['src\\Übersicht\\Größe.md', 'src\\Übersicht\\Größe.md', null, null, 'relative', false]],
    ],
    // Git Bash
    ['/c/Users/x/a.log', [['/c/Users/x/a.log', 'C:\\Users\\x\\a.log', null, null, 'git_bash', false]]],
    [
      '/d/work/sample/src/main.ts:26',
      [['/d/work/sample/src/main.ts:26', 'D:\\work\\sample\\src\\main.ts', 26, null, 'git_bash', false]],
    ],
    // file:// URLs
    [
      'file:///C:/Users/x/a%20b.txt',
      [['file:///C:/Users/x/a%20b.txt', 'C:/Users/x/a b.txt', null, null, 'file_url', false]],
    ],
    ['(file:///D:/work/a.md#L4)', [['file:///D:/work/a.md#L4', 'D:/work/a.md', 4, null, 'file_url', false]]],
    [
      'file://server/share/x.txt',
      [['file://server/share/x.txt', '\\\\server\\share\\x.txt', null, null, 'unc', true]],
    ],
    // UNC and device: recognized, unsafe
    [
      'open \\\\server\\share\\x.txt now',
      [['\\\\server\\share\\x.txt', '\\\\server\\share\\x.txt', null, null, 'unc', true]],
    ],
    ['//server/share/x.txt', [['//server/share/x.txt', '//server/share/x.txt', null, null, 'unc', true]]],
    ['\\\\?\\C:\\x\\a.txt', [['\\\\?\\C:\\x\\a.txt', '\\\\?\\C:\\x\\a.txt', null, null, 'device', true]]],
    ['\\\\.\\pipe\\x', [['\\\\.\\pipe\\x', '\\\\.\\pipe\\x', null, null, 'device', true]]],
    ['(\\??\\C:\\x\\a.txt).', [['\\??\\C:\\x\\a.txt', '\\??\\C:\\x\\a.txt', null, null, 'device', true]]],
    ['//?/C:/x/a.txt', [['//?/C:/x/a.txt', '//?/C:/x/a.txt', null, null, 'device', true]]],
    // Several references in one text
    [
      'C:\\a\\b.ts and src/c.ts:2',
      [
        ['C:\\a\\b.ts', 'C:\\a\\b.ts', null, null, 'drive', false],
        ['src/c.ts:2', 'src/c.ts', 2, null, 'relative', false],
      ],
    ],
    // Counter checks: never references
    ['https://example.com/src/a.ts', []],
    ['see http://x.org/a/b.md, and more', []],
    ['www.example.com/a.html', []],
    ['mail foo@example.com or bar.baz@example.org/x.txt', []],
    ['git@github.com:org/repo.git', []],
    ['a.ts and README.md', []],
    ['and/or, km/h, TCP/IP, 24/7', []],
    ['version 1.5/2.0', []],
    ['e.g./i.e. are prose', []],
    ['src/ and docs/', []],
    ['~/notes.txt and $HOME/a.txt and %TEMP%\\a.log', []],
    ['/usr/lib/x.so', []],
    ['the /s/ sound', []],
    ['C: drive and C:\\ root', []],
    ['src/**/*.ts', []],
    ['// comment', []],
    ['no separators at all', []],
  ])('%j', (text, expected) => {
    expect(refsOf(text)).toEqual(expected);
  });

  it('reports positions in the text and the range end of #L12-L20', () => {
    const text = 'Edit (src/a.ts#L12-L20).';
    const [ref] = findFileRefs(text);
    expect(ref).toMatchObject({ start: 6, end: 22, raw: 'src/a.ts#L12-L20', line: 12, endLine: 20 });
    expect(text.slice(ref?.start, ref?.end)).toBe(ref?.raw);
  });

  it('skips over-long tokens', () => {
    expect(findFileRefs(`src/${'a'.repeat(1200)}.ts`)).toEqual([]);
  });
});

describe('resolveFileRef', () => {
  const resolve = (text: string, cwd: string | null = CWD) => {
    const [ref] = findFileRefs(text);
    return ref === undefined ? undefined : resolveFileRef(ref, cwd);
  };

  it.each<[string, string | null, string | null]>([
    ['src/a.ts', CWD, 'D:\\work\\sample\\src\\a.ts'],
    ['./a.ts', CWD, 'D:\\work\\sample\\a.ts'],
    ['..\\b.md', CWD, 'D:\\work\\b.md'],
    ['src/a.ts', null, null],
    ['C:/Users/x/notes.txt', null, 'C:\\Users\\x\\notes.txt'],
    ['C:\\work\\..\\x\\a.ts', null, 'C:\\x\\a.ts'],
    ['/c/Users/x/a.log', null, 'C:\\Users\\x\\a.log'],
    ['file:///C:/Users/x/a%20b.txt', null, 'C:\\Users\\x\\a b.txt'],
    ['\\\\server\\share\\x.txt', CWD, null],
    ['file://server/share/x.txt', CWD, null],
    ['\\\\?\\C:\\x\\a.txt', CWD, null],
    ['C:\\x\\con.txt', CWD, null],
  ])('%j (cwd %j) → %j', (text, cwd, expected) => {
    expect(resolve(text, cwd)).toBe(expected);
  });

  it('never leaves the drive root of the cwd', () => {
    expect(resolve('../../../x/a.ts', 'D:\\work')).toBeNull();
  });
});

describe('parseFileTarget (Markdown link targets)', () => {
  it.each<[string, Partial<ReturnType<typeof parseFileTarget>> | null]>([
    ['C:%5Cwork%5Ca.ts', { path: 'C:\\work\\a.ts', kind: 'drive', unsafe: false }],
    ['C:/work/a.ts#L5', { path: 'C:/work/a.ts', line: 5, kind: 'drive' }],
    ['../secrets.txt', { path: '../secrets.txt', kind: 'relative' }],
    ['docs/guide', { path: 'docs/guide', kind: 'relative' }],
    ['LICENSE', { path: 'LICENSE', kind: 'relative' }],
    ['README.md#install', { path: 'README.md', line: null, kind: 'relative' }],
    ['src/a.ts?raw=1', { path: 'src/a.ts', kind: 'relative' }],
    ['file:///C:/Users/x/a.md', { path: 'C:/Users/x/a.md', kind: 'file_url', unsafe: false }],
    ['file://host/share/a.md', { kind: 'unc', unsafe: true }],
    ['%5C%5Cserver%5Cshare', { kind: 'unc', unsafe: true }],
    ['https://example.com/a.md', null],
    ['mailto:foo@example.com', null],
    ['javascript:alert(1)', null],
    ['#section', null],
    ['/docs/a.md', null],
    ['', null],
  ])('%j', (target, expected) => {
    const parsed = parseFileTarget(target);
    if (expected === null) expect(parsed).toBeNull();
    else expect(parsed).toMatchObject(expected);
  });
});

describe('resolveFilePath (tool inputs, search hits)', () => {
  it.each<[string, string | null, string | null]>([
    ['D:\\work\\sample\\src\\main.ts', null, 'D:\\work\\sample\\src\\main.ts'],
    ['D:/work/sample/src/main.ts', null, 'D:\\work\\sample\\src\\main.ts'],
    ['src\\main.ts', CWD, 'D:\\work\\sample\\src\\main.ts'],
    ['src/main.ts', null, null],
    ['/d/work/a.ts', null, 'D:\\work\\a.ts'],
    ['\\\\server\\share\\a.ts', CWD, null],
    ['\\rooted\\a.ts', CWD, null],
    ['C:relative.ts', CWD, null],
    ['', CWD, null],
  ])('%j (cwd %j) → %j', (path, cwd, expected) => {
    expect(resolveFilePath(path, cwd)).toBe(expected);
  });
});
