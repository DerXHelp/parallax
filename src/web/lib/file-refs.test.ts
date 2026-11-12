import { describe, expect, it } from 'vitest';
import {
  findCodeRefs,
  findFileRefs,
  parseFileTarget,
  resolveFilePath,
  resolveFileRef,
  type FileRef,
  type FileRefKind,
} from './file-refs';

const CWD = 'D:\\work\\sample';

/** Compact form of one reference: [raw, path, line, col, kind, unsafe]. */
type Row = [string, string, number | null, number | null, FileRefKind, boolean];

function rowOf(ref: FileRef): Row {
  return [ref.raw, ref.path, ref.line, ref.col, ref.kind, ref.unsafe];
}

function refsOf(text: string): Row[] {
  return findFileRefs(text).map(rowOf);
}

/** A drive reference without a column. */
function drive(raw: string, path = raw, line: number | null = null): Row {
  return [raw, path, line, null, 'drive', false];
}

/** A Git Bash reference without line or column. */
function gitBash(raw: string, path: string): Row {
  return [raw, path, null, null, 'git_bash', false];
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

  describe('absolute paths with spaces in running text (V4-01)', () => {
    const PROJECT = 'C:\\Users\\Max Mustermann\\proj\\Projekt mit Leerzeichen äöü';

    it.each<[string, Row[]]>([
      // Spaces in folder names: the path goes on up to a file with an extension or a separator.
      ['see C:\\Program Files\\nodejs\\node.exe now', [drive('C:\\Program Files\\nodejs\\node.exe')]],
      [`${PROJECT}\\README.md:12.`, [drive(`${PROJECT}\\README.md:12`, `${PROJECT}\\README.md`, 12)]],
      [`(${PROJECT}\\)`, [drive(`${PROJECT}\\`)]],
      ['C:\\Program Files (x86)\\Tool\\a.exe', [drive('C:\\Program Files (x86)\\Tool\\a.exe')]],
      [
        'C:/Users/Max Mustermann/notes v1.2 final/a.md',
        [drive('C:/Users/Max Mustermann/notes v1.2 final/a.md')],
      ],
      [
        '/c/Users/Max Mustermann/a.log',
        [gitBash('/c/Users/Max Mustermann/a.log', 'C:\\Users\\Max Mustermann\\a.log')],
      ],
      ['"C:\\Program Files\\x.exe" -v', [drive('C:\\Program Files\\x.exe')]],
      // Counter checks: two references stay two – a name with an extension ends a path.
      ['C:\\a\\b.ts and c.md', [drive('C:\\a\\b.ts')]],
      [
        'C:\\a\\b.ts and src\\c.md',
        [drive('C:\\a\\b.ts'), ['src\\c.md', 'src\\c.md', null, null, 'relative', false]],
      ],
      [
        'C:\\work\\a.ts, C:\\Program Files\\b.exe',
        [drive('C:\\work\\a.ts'), drive('C:\\Program Files\\b.exe')],
      ],
      ['C:\\work, then C:\\x\\a.ts', [drive('C:\\work'), drive('C:\\x\\a.ts')]],
      // A colon (another drive) and the other separator end the path.
      ['C:\\old dir and C:\\x\\a.ts', [drive('C:\\x\\a.ts')]],
      // Counter checks: never a mere prefix of a name with spaces (it would be linked or refused).
      [PROJECT, []],
      [`The cwd is ${PROJECT}.`, []],
      ['C:\\Users\\Max\\My File.txt', []],
      ['C:\\Users\\Max Mustermann\\My File.txt', []],
      ['The folder C:\\work contains a.ts', []],
      ['C:\\Program Files\\nodejs', []],
      ['C:\\a\\b and/or c', []],
      ['C:\\a\\b - done', []],
    ])('%j', (text, expected) => {
      expect(refsOf(text)).toEqual(expected);
    });

    it('reports positions over the spaces', () => {
      const text = `Edit ${PROJECT}\\a.md now`;
      const [ref] = findFileRefs(text);
      expect(ref).toMatchObject({ start: 5, raw: `${PROJECT}\\a.md` });
      expect(text.slice(ref?.start, ref?.end)).toBe(ref?.raw);
    });

    it('resolves a path with spaces like any drive path', () => {
      const [ref] = findFileRefs(`${PROJECT}\\src\\..\\README.md`);
      expect(ref === undefined ? null : resolveFileRef(ref, null)).toBe(`${PROJECT}\\README.md`);
    });
  });
});

describe('findCodeRefs (inline code, V4-01)', () => {
  const PROJECT = 'C:\\Users\\Max Mustermann\\proj\\Projekt mit Leerzeichen äöü';

  it.each<[string, Row[]]>([
    // The span as a whole: spaces anywhere, also in the file name; folders too.
    [`${PROJECT}\\README.md`, [drive(`${PROJECT}\\README.md`)]],
    [PROJECT, [drive(PROJECT)]],
    [
      'C:\\Users\\Max\\My File.txt:3',
      [drive('C:\\Users\\Max\\My File.txt:3', 'C:\\Users\\Max\\My File.txt', 3)],
    ],
    [
      ' /c/Users/Max Mustermann/a.log ',
      [gitBash('/c/Users/Max Mustermann/a.log', 'C:\\Users\\Max Mustermann\\a.log')],
    ],
    // Without spaces: the same as running text.
    ['src/a.ts:7', [['src/a.ts:7', 'src/a.ts', 7, null, 'relative', false]]],
    // Not one path: the references in the text (commands, several paths).
    ['pnpm exec vitest run src/a.ts', [['src/a.ts', 'src/a.ts', null, null, 'relative', false]]],
    ['node C:\\Program Files\\x.js', [drive('C:\\Program Files\\x.js')]],
    ['C:\\a\\b.ts and c.md', [drive('C:\\a\\b.ts')]],
    ['C:\\x\\tool.exe --help', [drive('C:\\x\\tool.exe')]],
    ['C:\\a\\b.ts, C:\\c\\d.ts', [drive('C:\\a\\b.ts'), drive('C:\\c\\d.ts')]],
    ['C:\\x y\\a.md\tb', [drive('C:\\x y\\a.md')]],
    ['git commit -m "C:\\x y\\a.md"', [drive('C:\\x y\\a.md')]],
    ['//server/share/a b.txt', [['//server/share/a', '//server/share/a', null, null, 'unc', true]]],
  ])('%j', (code, expected) => {
    expect(findCodeRefs(code).map(rowOf)).toEqual(expected);
  });

  it('reports the position of the trimmed path in the span', () => {
    const code = '  C:\\a b\\c.md ';
    const [ref] = findCodeRefs(code);
    expect(ref).toMatchObject({ start: 2, end: 13, raw: 'C:\\a b\\c.md' });
    expect(code.slice(ref?.start, ref?.end)).toBe(ref?.raw);
  });
});

describe('linear time on long input (R5W-05)', () => {
  // Before the fix: 0.8–2.7 s each at these sizes (quadratic e-mail/URL patterns, bracket trimming).
  // A generous bound – linear scans take a few ms, also under parallel load.
  const BOUND_MS = 250;

  it.each<[string, string]>([
    ['a word without @', `${'a'.repeat(50_000)}/`],
    ['an e-mail-like run of labels', `a@${'b.'.repeat(20_000)}1 /`],
    ['dotted letters (URL scheme)', `${'b.'.repeat(25_000)}/`],
    ['hyphenated letters', `${'a-'.repeat(25_000)}/`],
    ['trailing closers', `x/${')'.repeat(50_000)}`],
    ['a drive path followed by many folder-like words', `C:\\a${' b\\c'.repeat(12_000)}`],
    ['many drive starts', 'C:\\a b '.repeat(8_000)],
  ])('%s', (_label, text) => {
    const start = performance.now();
    findFileRefs(text);
    findCodeRefs(text);
    expect(performance.now() - start).toBeLessThan(BOUND_MS);
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
