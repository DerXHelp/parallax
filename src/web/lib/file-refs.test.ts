import { describe, expect, it } from 'vitest';
import { POSIX_PATHS, WIN32_PATHS } from '@shared/paths';
import {
  findCodeRefs,
  findFileRefs,
  parseFileTarget,
  resolveFilePath,
  resolveFileRef,
  type FileRef,
  type FileRefKind,
  type FileRefScope,
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

describe('POSIX hosts (WP-104)', () => {
  const HOME_CWD = '/home/alice/work/sample';
  const scope = (cwd: string | null = HOME_CWD): FileRefScope => ({ rules: POSIX_PATHS, cwd });
  const posixRefs = (text: string, cwd: string | null = HOME_CWD) =>
    findFileRefs(text, scope(cwd)).map(rowOf);
  const posix = (raw: string, path = raw, line: number | null = null): Row => [
    raw,
    path,
    line,
    null,
    'posix',
    false,
  ];
  const home = (raw: string): Row => [raw, raw, null, null, 'home', false];
  const relative = (raw: string, path = raw, line: number | null = null): Row => [
    raw,
    path,
    line,
    null,
    'relative',
    false,
  ];
  const fileUrl = (raw: string, path: string): Row => [raw, path, null, null, 'file_url', false];

  it.each<[string, Row[]]>([
    // Well-known roots
    ['see /home/alice/notes.txt here', [posix('/home/alice/notes.txt')]],
    ['/tmp/build/out.log:12', [posix('/tmp/build/out.log:12', '/tmp/build/out.log', 12)]],
    ['/usr/lib/x.so', [posix('/usr/lib/x.so')]],
    ['/etc/hosts.', [posix('/etc/hosts')]],
    ['(/var/log/syslog)', [posix('/var/log/syslog')]],
    ['/opt/tool/bin/tool', [posix('/opt/tool/bin/tool')]],
    ['/mnt/data/a.csv /media/usb/b.png', [posix('/mnt/data/a.csv'), posix('/media/usb/b.png')]],
    ['/srv/app/main.py#L3', [posix('/srv/app/main.py#L3', '/srv/app/main.py', 3)]],
    ['/root/.bashrc and /run/user/1000/x.sock', [posix('/root/.bashrc'), posix('/run/user/1000/x.sock')]],
    ['/workspace/repo/src/a.ts', [posix('/workspace/repo/src/a.ts')]],
    ['→/home/alice/a.ts', [posix('/home/alice/a.ts')]],
    ['path=/home/alice/a.ts', [posix('/home/alice/a.ts')]],
    // A file without an extension followed by prose stays a reference (differs from Windows, V4-01).
    ['The file /etc/hosts contains it', [posix('/etc/hosts')]],
    // Spaces in folder names: extended up to a file with an extension.
    ['see /home/alice/My Project/a.md now', [posix('/home/alice/My Project/a.md')]],
    // Not under a known root and not under the cwd
    ['/data/proj/src/a.ts', []],
    // ~/… (resolved later)
    ['~/notes.txt and ~/.config/app/x.json', [home('~/notes.txt'), home('~/.config/app/x.json')]],
    // Relative paths: only `/` separates
    ['src/a.ts:7', [relative('src/a.ts:7', 'src/a.ts', 7)]],
    ['./a.ts and ../b.md', [relative('./a.ts'), relative('../b.md')]],
    ['src\\a.ts', []],
    // file:// URLs
    ['file:///home/alice/a%20b.txt', [fileUrl('file:///home/alice/a%20b.txt', '/home/alice/a b.txt')]],
    ['file://localhost/tmp/x.log', [fileUrl('file://localhost/tmp/x.log', '/tmp/x.log')]],
    ['file://server/share/x.txt', []],
    ['file:///C:/x/a.txt', []],
    // Windows forms are no references on a Linux host
    ['C:\\work\\a.ts and C:/x/b.md', []],
    ['/c/Users/x/a.log', []],
    ['\\\\server\\share\\x.txt and //server/share/x.txt', []],
    ['\\\\?\\C:\\x\\a.txt', []],
    // Counter checks: URLs, fractions, dates, prose, commands
    ['https://example.com/home/alice/a.ts', []],
    ['see http://x.org/tmp/a.md, and www.example.com/usr/a.html', []],
    ['git@github.com:org/repo.git', []],
    ['1/2, 3/4.5, 24/7 and 2026/11/21', []],
    ['and/or, km/h, TCP/IP', []],
    ['/clear and /model and /api/hosts/x', []],
    ['the /s/ sound', []],
    ['/home and /tmp/ alone', []],
    ['// comment', []],
    ['scp host:/home/alice/a.txt', []],
    ['src/**/*.ts', []],
    ['/proc/1/status', []],
    ['e.g./i.e. are prose', []],
    ['~ and ~user/x.txt and $HOME/a.txt', []],
  ])('%j', (text, expected) => {
    expect(posixRefs(text)).toEqual(expected);
  });

  it('takes absolute paths under the cwd with any root, never with the cwd /', () => {
    expect(posixRefs('/data/proj/src/a.ts and /data/other/b.ts', '/data/proj')).toEqual([
      posix('/data/proj/src/a.ts'),
    ]);
    expect(posixRefs('/data/proj', '/data/proj')).toEqual([posix('/data/proj')]);
    expect(posixRefs('/data/proj/a.ts', '/')).toEqual([]);
    expect(posixRefs('/data/proj/a.ts', null)).toEqual([]);
  });

  it('keeps Windows hosts exactly as before (no POSIX references)', () => {
    expect(refsOf('/home/alice/notes.txt and ~/a.txt')).toEqual([]);
    expect(findFileRefs('/data/proj/a.ts', { rules: WIN32_PATHS, cwd: '/data/proj' })).toEqual([]);
  });

  it('finds inline code paths with spaces', () => {
    const codeRefs = (code: string) => findCodeRefs(code, scope()).map(rowOf);
    expect(codeRefs('/home/alice/My Project/My File.txt:3')).toEqual([
      posix('/home/alice/My Project/My File.txt:3', '/home/alice/My Project/My File.txt', 3),
    ]);
    expect(codeRefs('~/My Notes/a b.md')).toEqual([home('~/My Notes/a b.md')]);
    expect(codeRefs('cat /etc/hosts | grep x')).toEqual([posix('/etc/hosts')]);
    expect(codeRefs('/srv/x y/a.md')).toEqual([posix('/srv/x y/a.md')]);
    // Not under a known root: the text as running text (only the relative tail).
    expect(codeRefs('/data/x y/a.md')).toEqual([relative('y/a.md')]);
  });

  it('stays linear on long input', () => {
    const start = performance.now();
    findFileRefs(`/home/a${' b/c'.repeat(12_000)}`, scope());
    findFileRefs('/home/a b '.repeat(8_000), scope());
    findCodeRefs(`~/${'a/'.repeat(20_000)}`, scope());
    expect(performance.now() - start).toBeLessThan(250);
  });

  describe('resolveFileRef', () => {
    const resolve = (text: string, cwd: string | null = HOME_CWD) => {
      const [ref] = findFileRefs(text, scope(cwd));
      return ref === undefined ? undefined : resolveFileRef(ref, cwd, POSIX_PATHS);
    };

    it.each<[string, string | null, string | null]>([
      ['src/a.ts', HOME_CWD, '/home/alice/work/sample/src/a.ts'],
      ['../b/c.md', HOME_CWD, '/home/alice/work/b/c.md'],
      ['src/a.ts', null, null],
      ['/tmp/x/../y.log', null, '/tmp/y.log'],
      ['file:///home/alice/a%20b.txt', null, '/home/alice/a b.txt'],
      // ~/… only where the home derived from the cwd puts the file under the cwd
      ['~/work/sample/README.md', HOME_CWD, '/home/alice/work/sample/README.md'],
      ['~/.bashrc.d/x.sh', HOME_CWD, null],
      ['~/work/sample/a.md', '/srv/app', null],
      ['~/proj/a.md', '/root/proj', '/root/proj/a.md'],
      ['~/work/sample/a.md', null, null],
    ])('%j (cwd %j) → %j', (text, cwd, expected) => {
      expect(resolve(text, cwd)).toBe(expected);
    });

    it('never leaves the root and refuses kernel files and drive paths', () => {
      const ref = (path: string, kind: FileRefKind) => ({ path, kind, unsafe: false });
      expect(resolveFileRef(ref('../../../../../x.ts', 'relative'), '/home/a', POSIX_PATHS)).toBeNull();
      expect(resolveFileRef(ref('/proc/1/environ', 'posix'), null, POSIX_PATHS)).toBeNull();
      expect(resolveFileRef(ref('C:\\x\\a.ts', 'drive'), null, POSIX_PATHS)).toBeNull();
      // ~/… never on a Windows host
      expect(resolveFileRef(ref('~/a.ts', 'home'), 'C:\\Users\\x', WIN32_PATHS)).toBeNull();
    });
  });

  describe('parseFileTarget', () => {
    it.each<[string, Partial<ReturnType<typeof parseFileTarget>> | null]>([
      ['/docs/a.md', { path: '/docs/a.md', kind: 'posix', unsafe: false }],
      ['/home/alice/a.ts#L5', { path: '/home/alice/a.ts', line: 5, kind: 'posix' }],
      ['~/notes.md', { path: '~/notes.md', kind: 'home' }],
      ['docs/guide', { path: 'docs/guide', kind: 'relative' }],
      ['file:///home/alice/a.md', { path: '/home/alice/a.md', kind: 'file_url', unsafe: false }],
      ['file://host/share/a.md', null],
      ['C:%5Cwork%5Ca.ts', null],
      ['//server/share', null],
      ['https://example.com/a.md', null],
      ['#section', null],
    ])('%j', (target, expected) => {
      const parsed = parseFileTarget(target, POSIX_PATHS);
      if (expected === null) expect(parsed).toBeNull();
      else expect(parsed).toMatchObject(expected);
    });
  });

  describe('resolveFilePath', () => {
    it.each<[string, string | null, string | null]>([
      ['/home/alice/work/sample/src/main.ts', null, '/home/alice/work/sample/src/main.ts'],
      ['/srv//app/./x.ts', null, '/srv/app/x.ts'],
      ['src/main.ts', HOME_CWD, '/home/alice/work/sample/src/main.ts'],
      ['src/main.ts', null, null],
      ['~/work/sample/a.ts', HOME_CWD, '/home/alice/work/sample/a.ts'],
      ['~/other/a.ts', HOME_CWD, null],
      ['~alice/a.ts', HOME_CWD, null],
      ['C:\\work\\a.ts', HOME_CWD, null],
      ['/proc/self/environ', null, null],
      ['', HOME_CWD, null],
    ])('%j (cwd %j) → %j', (path, cwd, expected) => {
      expect(resolveFilePath(path, cwd, POSIX_PATHS)).toBe(expected);
    });
  });
});
