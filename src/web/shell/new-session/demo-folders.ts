import { makeError, type ErrorPayload } from '@shared/errors';
import type { FsEntry, FsListing } from '@shared/model';
import { windowsNameIssue, windowsPathIssue, windowsPathKey } from '@shared/paths';

/**
 * A fake folder tree answering `fs.listDirectory` (and `fs.createDirectory` on a copy, WP-94) like
 * the server (ADR-119) – for tests and playground demos of the folder browser only (dev/test;
 * nothing in the app imports it).
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
  // A long path (V3-01: dialogs keep their width, breadcrumbs scroll to the end).
  'c:\\users\\user\\documents': [{ name: 'parallax-verifikation-mit-einem-recht-langen-ordnernamen' }],
  'c:\\users\\user\\documents\\parallax-verifikation-mit-einem-recht-langen-ordnernamen': [{ name: 'projekte' }],
  'c:\\users\\user\\documents\\parallax-verifikation-mit-einem-recht-langen-ordnernamen\\projekte': [
    { name: 'beta-mit-einem-sehr-langen-ordnernamen-fuer-den-test-der-kopfzeile' },
  ],
  'c:\\users\\user\\documents\\parallax-verifikation-mit-einem-recht-langen-ordnernamen\\projekte\\beta-mit-einem-sehr-langen-ordnernamen-fuer-den-test-der-kopfzeile':
    [],
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
/** Names the server hides besides dot names (its `isHiddenName`). */
const SYSTEM_NAMES: ReadonlySet<string> = new Set([
  '$recycle.bin',
  'system volume information',
  '$winreagent',
  'recovery',
  'config.msi',
]);
/** Folders with more entries than the server sends (`truncated`). */
const TRUNCATED: ReadonlySet<string> = new Set(['d:\\archive']);

/** `D:\work\x` → `D:\work`, `D:\work` → `D:\`, a drive root → null. */
function parentOf(path: string): string | null {
  if (/^[A-Za-z]:[\\/]*$/.test(path)) return null;
  const trimmed = path.replace(/[\\/]+$/, '');
  const cut = Math.max(trimmed.lastIndexOf('\\'), trimmed.lastIndexOf('/'));
  return cut <= 2 ? trimmed.slice(0, 3) : trimmed.slice(0, cut);
}

/** `path` + `name` with one separator in the style of `path` (like the server's `childPath`). */
function childOf(path: string, name: string): string {
  if (/[\\/]$/.test(path)) return `${path}${name}`;
  return `${path}${path.includes('\\') ? '\\' : '/'}${name}`;
}

/** A copy of a folder tree that `createDemoFolder` may change (one per demo host). */
export function cloneDemoFolders(
  folders: Readonly<Record<string, readonly DemoFolder[]>> = DEMO_FOLDERS,
): Record<string, DemoFolder[]> {
  return Object.fromEntries(Object.entries(folders).map(([key, children]) => [key, [...children]]));
}

/**
 * Answer of `fs.createDirectory` (WP-94) on a changeable tree, like the server: name rules,
 * missing parent, an existing name (case-insensitive), `D:\work\locked` is not writable.
 */
export function createDemoFolder(
  parent: string,
  folderName: string,
  folders: Record<string, DemoFolder[]>,
): { ok: true; path: string } | { ok: false; error: ErrorPayload } {
  const issue = windowsPathIssue(parent) ?? windowsNameIssue(folderName);
  if (issue !== null) return { ok: false, error: makeError('PATH_REJECTED', { reason: issue }) };
  const key = windowsPathKey(parent);
  if (LOCKED.has(key)) return { ok: false, error: makeError('FOLDER_NOT_WRITABLE', { path: parent }) };
  const children = folders[key];
  if (children === undefined) return { ok: false, error: makeError('CWD_NOT_FOUND', { cwd: parent }) };
  const path = childOf(parent, folderName);
  if (children.some((child) => child.name.toLowerCase() === folderName.toLowerCase())) {
    return { ok: false, error: makeError('FOLDER_EXISTS', { path }) };
  }
  const hidden = folderName.startsWith('.') || SYSTEM_NAMES.has(folderName.toLowerCase());
  children.push(hidden ? { name: folderName, hidden: true } : { name: folderName });
  children.sort((a, b) => (a.name.toLowerCase() < b.name.toLowerCase() ? -1 : 1));
  folders[windowsPathKey(path)] = [];
  return { ok: true, path };
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
  return {
    ok: true,
    listing: {
      path,
      parent: parentOf(path),
      entries: children
        .filter((child) => showHidden || child.hidden !== true)
        .map((child) => ({
          name: child.name,
          path: childOf(path, child.name),
          kind: child.kind ?? 'directory',
          hidden: child.hidden === true,
        })),
      truncated: TRUNCATED.has(key),
    },
  };
}
