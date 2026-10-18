import { makeError, type ErrorPayload } from '@shared/errors';
import type { FsEntry, FsListing } from '@shared/model';
import { windowsPathIssue, windowsPathKey } from '@shared/paths';

/**
 * A fake folder tree answering `fs.listDirectory` like the server (ADR-119) – for tests and
 * playground demos of the folder browser only (dev/test; nothing in the app imports it).
 * Roots: user folder + drives C: and D:. `D:\work\locked` is not readable, `D:\archive` is
 * truncated, `D:\work\sample` is a link, names with a dot and `$Recycle.Bin` are hidden.
 */

export interface DemoFolder {
  name: string;
  kind?: FsEntry['kind'];
  hidden?: boolean;
}

/** Folder tree; keys are `windowsPathKey`s. */
export const DEMO_FOLDERS: Readonly<Record<string, readonly DemoFolder[]>> = {
  'c:\\': [{ name: 'Program Files' }, { name: 'Users' }, { name: 'Windows' }],
  'c:\\program files': [],
  'c:\\windows': [],
  'c:\\users': [{ name: 'Public' }, { name: 'user' }],
  'c:\\users\\public': [],
  'c:\\users\\user': [
    { name: '.claude', hidden: true },
    { name: '.claude-work', hidden: true },
    { name: 'Documents' },
    { name: 'Downloads' },
  ],
  'c:\\users\\user\\.claude': [],
  'c:\\users\\user\\.claude-work': [],
  'c:\\users\\user\\documents': [],
  'c:\\users\\user\\downloads': [],
  'd:\\': [{ name: '$Recycle.Bin', hidden: true }, { name: 'archive' }, { name: 'work' }],
  'd:\\archive': [{ name: '2019' }, { name: '2020' }, { name: '2021' }],
  'd:\\work': [
    { name: '.git-hooks', hidden: true },
    { name: 'api' },
    { name: 'locked' },
    { name: 'parallax' },
    { name: 'sample', kind: 'link' },
    { name: 'web' },
  ],
  'd:\\work\\api': [{ name: 'tests' }],
  'd:\\work\\api\\tests': [],
  'd:\\work\\parallax': [{ name: '.git', hidden: true }, { name: 'docs' }, { name: 'e2e' }, { name: 'src' }],
  'd:\\work\\parallax\\docs': [],
  'd:\\work\\parallax\\e2e': [],
  'd:\\work\\parallax\\src': [{ name: 'server' }, { name: 'shared' }, { name: 'web' }],
  'd:\\work\\parallax\\src\\server': [],
  'd:\\work\\parallax\\src\\shared': [],
  'd:\\work\\parallax\\src\\web': [],
  'd:\\work\\sample': [],
  'd:\\work\\web': [{ name: 'landing' }],
  'd:\\work\\web\\landing': [],
};

/** Folders the demo user may not read (FOLDER_NOT_READABLE). */
const LOCKED: ReadonlySet<string> = new Set(['d:\\work\\locked']);
/** Folders with more entries than the server sends (`truncated`). */
const TRUNCATED: ReadonlySet<string> = new Set(['d:\\archive']);

/** `D:\work\x` → `D:\work`, `D:\work` → `D:\`, a drive root → null. */
function parentOf(path: string): string | null {
  if (/^[A-Za-z]:[\\/]*$/.test(path)) return null;
  const trimmed = path.replace(/[\\/]+$/, '');
  const cut = Math.max(trimmed.lastIndexOf('\\'), trimmed.lastIndexOf('/'));
  return cut <= 2 ? trimmed.slice(0, 3) : trimmed.slice(0, cut);
}

/** Answer of `fs.listDirectory`: entry path = listed path + name, in the listed path's style. */
export function listDemoFolder(
  path: string | null,
  showHidden: boolean,
  folders: Readonly<Record<string, readonly DemoFolder[]>> = DEMO_FOLDERS,
): { ok: true; listing: FsListing } | { ok: false; error: ErrorPayload } {
  if (path === null) {
    return {
      ok: true,
      listing: {
        path: null,
        parent: null,
        entries: [
          { name: 'user', path: 'C:\\Users\\user', kind: 'home', hidden: false },
          { name: 'C:', path: 'C:\\', kind: 'drive', hidden: false },
          { name: 'D:', path: 'D:\\', kind: 'drive', hidden: false },
        ],
        truncated: false,
      },
    };
  }
  const issue = windowsPathIssue(path);
  if (issue !== null) return { ok: false, error: makeError('PATH_REJECTED', { reason: issue }) };
  const key = windowsPathKey(path);
  if (LOCKED.has(key)) return { ok: false, error: makeError('FOLDER_NOT_READABLE', { path }) };
  const children = folders[key];
  if (children === undefined) return { ok: false, error: makeError('CWD_NOT_FOUND', { cwd: path }) };
  const separator = path.includes('\\') ? '\\' : '/';
  const base = /[\\/]$/.test(path) ? path : `${path}${separator}`;
  return {
    ok: true,
    listing: {
      path,
      parent: parentOf(path),
      entries: children
        .filter((child) => showHidden || child.hidden !== true)
        .map((child) => ({
          name: child.name,
          path: `${base}${child.name}`,
          kind: child.kind ?? 'directory',
          hidden: child.hidden === true,
        })),
      truncated: TRUNCATED.has(key),
    },
  };
}
