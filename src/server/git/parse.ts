/**
 * Pure parsers of git's machine output (WP-111, ADR-252). Every list comes NUL-separated (`-z`), so
 * paths are raw (no quoting, any character). Paths of files stay relative to the repository root and
 * `/`-separated (as git names them, `GitFileChange.path`); folders git reports (`--show-toplevel`,
 * `worktree list`) become the host's spelling with `hostPath` (Windows: `\`).
 */
import type { GitFileChange, GitFileKind, GitWorktree } from '@shared/model';
import { gitShaSchema } from '@shared/model';
import type { PathRules } from '@shared/paths';

/** git's `C:/work/x` → `C:\work\x` on Windows; POSIX unchanged. Trailing separators dropped (not a root). */
export function hostPath(gitPath: string, rules: PathRules): string {
  const trimmed = gitPath.replace(/\r?\n$/, '');
  if (rules.flavor !== 'win32') return trimmed.length > 1 ? trimmed.replace(/\/+$/, '') : trimmed;
  const native = trimmed.replace(/\//g, '\\');
  return /^[A-Za-z]:\\$/.test(native) ? native : native.replace(/\\+$/, '');
}

/**
 * `cwd`'s own spelling of `root` when `cwd` lies in it (B: the `cwd` string is kept exactly – the
 * sidebar groups by `repoRoot`, so a root git spells `D:\Work` stays `d:\work` when the session's
 * folder was typed like that). Otherwise git's spelling.
 */
export function rootInCwdSpelling(root: string, cwd: string, rules: PathRules): string {
  if (rules.flavor !== 'win32' || !rules.isInside(cwd, root)) return root;
  const segments = (path: string): string[] => path.split(/[\\/]+/).filter((s) => s !== '');
  const count = segments(root).length;
  const own = segments(cwd).slice(0, count);
  const candidate = own.length === 1 ? `${own[0] ?? ''}\\` : own.join('\\');
  return rules.equal(candidate, root) ? candidate : root;
}

/** NUL-separated records without the trailing empty one. */
export function splitNul(text: string): string[] {
  const parts = text.split('\0');
  if (parts.at(-1) === '') parts.pop();
  return parts;
}

function sha(value: string | undefined): string | null {
  if (value === undefined) return null;
  const parsed = gitShaSchema.safeParse(value.toLowerCase());
  return parsed.success ? parsed.data : null;
}

export interface ParsedStatus {
  branch: string | null;
  detached: boolean;
  head: string | null;
  upstream: string | null;
  ahead: number;
  behind: number;
  files: GitFileChange[];
}

/** `XY` of porcelain v2 (`.` = unchanged) → the kind shown in the list. */
function kindOfXY(xy: string): GitFileKind {
  const pick = (c: string): GitFileKind | null => {
    switch (c) {
      case 'M':
        return 'modified';
      case 'A':
        return 'added';
      case 'D':
        return 'deleted';
      case 'R':
        return 'renamed';
      case 'C':
        return 'copied';
      case 'T':
        return 'type_changed';
      default:
        return null;
    }
  };
  const x = xy[0] ?? '.';
  const y = xy[1] ?? '.';
  // A rename/copy in the index wins (it carries `origPath`); else the index side, else the worktree side.
  if (x === 'R' || x === 'C') return pick(x) ?? 'modified';
  return pick(x) ?? pick(y) ?? 'modified';
}

/**
 * `git status --porcelain=v2 --branch -z --untracked-files=all`: headers `# branch.*`, entries `1`
 * (changed), `2` (renamed/copied; the original path is the next record), `u` (unmerged), `?`
 * (untracked), `!` (ignored – not shown). Untracked folders git lists with a trailing `/` (a nested
 * repository) are kept as one entry without the slash.
 */
export function parseStatusV2(text: string): ParsedStatus {
  const out: ParsedStatus = {
    branch: null,
    detached: false,
    head: null,
    upstream: null,
    ahead: 0,
    behind: 0,
    files: [],
  };
  const records = splitNul(text);
  for (let i = 0; i < records.length; i += 1) {
    const record = records[i] ?? '';
    if (record.startsWith('# ')) {
      const [key, ...rest] = record.slice(2).split(' ');
      const value = rest.join(' ');
      switch (key) {
        case 'branch.oid':
          out.head = sha(value);
          break;
        case 'branch.head':
          if (value === '(detached)') out.detached = true;
          else if (value !== '') out.branch = value;
          break;
        case 'branch.upstream':
          out.upstream = value === '' ? null : value;
          break;
        case 'branch.ab': {
          const match = /^\+(\d+) -(\d+)$/.exec(value);
          if (match !== null) {
            out.ahead = Number(match[1]);
            out.behind = Number(match[2]);
          }
          break;
        }
        default:
          break;
      }
      continue;
    }
    const type = record[0];
    if (type === '1') {
      // 1 <XY> <sub> <mH> <mI> <mW> <hH> <hI> <path>
      const fields = record.split(' ');
      const xy = fields[1] ?? '..';
      const path = fields.slice(8).join(' ');
      if (path === '') continue;
      out.files.push({
        path,
        origPath: null,
        kind: kindOfXY(xy),
        staged: (xy[0] ?? '.') !== '.',
        unstaged: (xy[1] ?? '.') !== '.',
      });
    } else if (type === '2') {
      // 2 <XY> <sub> <mH> <mI> <mW> <hH> <hI> <X><score> <path>, then the original path.
      const fields = record.split(' ');
      const xy = fields[1] ?? '..';
      const path = fields.slice(9).join(' ');
      const orig = records[i + 1] ?? null;
      i += 1;
      if (path === '') continue;
      out.files.push({
        path,
        origPath: orig === '' ? null : orig,
        kind: kindOfXY(xy),
        staged: (xy[0] ?? '.') !== '.',
        unstaged: (xy[1] ?? '.') !== '.',
      });
    } else if (type === 'u') {
      // u <XY> <sub> <m1> <m2> <m3> <mW> <h1> <h2> <h3> <path>
      const path = record.split(' ').slice(10).join(' ');
      if (path === '') continue;
      out.files.push({ path, origPath: null, kind: 'conflicted', staged: true, unstaged: true });
    } else if (type === '?') {
      const path = record.slice(2).replace(/\/$/, '');
      if (path === '') continue;
      out.files.push({ path, origPath: null, kind: 'untracked', staged: false, unstaged: true });
    }
  }
  return out;
}

/** One file of `git diff --raw --numstat -z` (before the patch is loaded). */
export interface DiffEntry {
  path: string;
  origPath: string | null;
  kind: GitFileKind;
  binary: boolean;
  additions: number;
  deletions: number;
}

function kindOfRawStatus(status: string): GitFileKind {
  switch (status[0]) {
    case 'A':
      return 'added';
    case 'D':
      return 'deleted';
    case 'R':
      return 'renamed';
    case 'C':
      return 'copied';
    case 'T':
      return 'type_changed';
    case 'U':
      return 'conflicted';
    default:
      return 'modified';
  }
}

/**
 * `git diff --raw --numstat -z [-M]`: first the raw records (`:<modes> <shas> <STATUS>\0<path>\0`, a
 * rename/copy with `\0<old>\0<new>\0`), then the numstat records (`<add>\t<del>\t<path>\0`, a rename
 * with `<add>\t<del>\t\0<old>\0<new>\0`; `-\t-` = binary). Merged by the (new) path, in raw order.
 */
export function parseRawNumstat(text: string): DiffEntry[] {
  const records = splitNul(text);
  const entries: DiffEntry[] = [];
  const byPath = new Map<string, DiffEntry>();
  let i = 0;
  while (i < records.length) {
    const record = records[i] ?? '';
    if (record.startsWith(':')) {
      const status = record.split(' ').at(-1) ?? 'M';
      const kind = kindOfRawStatus(status);
      if (kind === 'renamed' || kind === 'copied') {
        const origPath = records[i + 1] ?? '';
        const path = records[i + 2] ?? '';
        i += 3;
        const entry: DiffEntry = { path, origPath, kind, binary: false, additions: 0, deletions: 0 };
        entries.push(entry);
        byPath.set(path, entry);
      } else {
        const path = records[i + 1] ?? '';
        i += 2;
        // An unmerged path is listed twice (U, then M) – keep the first.
        if (byPath.has(path)) continue;
        const entry: DiffEntry = { path, origPath: null, kind, binary: false, additions: 0, deletions: 0 };
        entries.push(entry);
        byPath.set(path, entry);
      }
      continue;
    }
    const match = /^(-|\d+)\t(-|\d+)\t(.*)$/s.exec(record);
    if (match === null) {
      i += 1;
      continue;
    }
    let path = match[3] ?? '';
    i += 1;
    if (path === '') {
      // Rename: old and new path follow.
      path = records[i + 1] ?? '';
      i += 2;
    }
    const entry = byPath.get(path);
    if (entry === undefined) continue;
    if (match[1] === '-' || match[2] === '-') {
      entry.binary = true;
    } else {
      entry.additions = Number(match[1]);
      entry.deletions = Number(match[2]);
    }
  }
  return entries.filter((e) => e.path !== '');
}

/**
 * The unified diff of ONE file from `git diff` output: everything from the first `@@` on (the
 * `diff --git`/`index`/`---`/`+++` header dropped). `binary` when git says "Binary files … differ".
 */
export function patchBody(text: string): { patch: string; binary: boolean } {
  const lines = text.split('\n');
  const first = lines.findIndex((line) => line.startsWith('@@'));
  if (first < 0) {
    const binary = lines.some(
      (line) => /^Binary files .* differ\r?$/.test(line) || line.startsWith('GIT binary patch'),
    );
    return { patch: '', binary };
  }
  return { patch: lines.slice(first).join('\n'), binary: false };
}

/** Added and removed lines of a patch body (header lines `+++`/`---` are not part of it). */
export function countPatchLines(patch: string): { additions: number; deletions: number } {
  let additions = 0;
  let deletions = 0;
  for (const line of patch.split('\n')) {
    if (line.startsWith('+')) additions += 1;
    else if (line.startsWith('-')) deletions += 1;
  }
  return { additions, deletions };
}

/**
 * `git worktree list --porcelain -z`: blocks of `worktree <path>`, `HEAD <sha>`, `branch refs/heads/x`
 * | `detached` | `bare`, … separated by an empty record. The first block is the main worktree. Bare
 * entries and paths the host's rules reject are skipped.
 */
export function parseWorktreeList(text: string, rules: PathRules): GitWorktree[] {
  const out: GitWorktree[] = [];
  let current: { path: string; head: string | null; branch: string | null; bare: boolean } | null = null;
  let index = 0;
  const finish = (): void => {
    if (current !== null && !current.bare && rules.issue(current.path) === null) {
      out.push({ path: current.path, branch: current.branch, head: current.head, main: index === 0 });
    }
    if (current !== null) index += 1;
    current = null;
  };
  for (const record of text.split('\0')) {
    if (record === '') {
      finish();
      continue;
    }
    if (record.startsWith('worktree ')) {
      finish();
      current = { path: hostPath(record.slice(9), rules), head: null, branch: null, bare: false };
      continue;
    }
    if (current === null) continue;
    if (record.startsWith('HEAD ')) current.head = sha(record.slice(5));
    else if (record.startsWith('branch ')) current.branch = record.slice(7).replace(/^refs\/heads\//, '');
    else if (record === 'bare') current.bare = true;
  }
  finish();
  return out;
}

/** Why a push failed, from git's message (English, `LANGUAGE=en`). */
export function classifyPushFailure(stderr: string): 'auth' | 'rejected' | 'network' | 'other' {
  const text = stderr.toLowerCase();
  if (
    /authentication failed|could not read (username|password)|terminal prompts disabled|permission denied \(publickey|invalid username or password|http basic: access denied|access denied|returned error: 40[13]|host key verification failed|403 forbidden|401 unauthorized/.test(
      text,
    )
  ) {
    return 'auth';
  }
  if (/\[rejected\]|\[remote rejected\]|non-fast-forward|updates were rejected|fetch first/.test(text)) {
    return 'rejected';
  }
  if (
    /could not resolve host|unable to access|failed to connect|connection (timed out|refused|reset)|network is unreachable|could not read from remote repository|operation timed out/.test(
      text,
    )
  ) {
    return 'network';
  }
  return 'other';
}
