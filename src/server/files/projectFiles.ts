/**
 * File list of a project for the @ picker (`files.project`, ADR-151): `git ls-files` (fsmonitor
 * off – a repository could start programs through it; quotepath off; `-z`) with git resolved to an
 * absolute `.exe` (never the bare name: a planted `git.exe` in the cwd would win, R1-04), no shell,
 * `windowsHide: true`, 5 s, at most 8 MB output. No repository, no git or a failure → a bounded
 * walk (no links/junctions, ignore list, depth ≤ 12, 3 s). At most LIMITS.projectFilesMax paths
 * (`truncated`). Cached per entry for 30 s; a finished Write/Edit drops the cache (files.service).
 */
import path from 'node:path';
import { LIMITS, type EntryId } from '@shared/common';
import type { CommandResult } from '@shared/protocol';
import { runFile, type RunFileFn } from '../lib/process';
import type { FileFs } from './fileFs';

export type ProjectFileList = CommandResult<'files.project'>;

export const GIT_LS_FILES_ARGS: readonly string[] = [
  '-c',
  'core.fsmonitor=false',
  '-c',
  'core.quotepath=off',
  'ls-files',
  '-z',
  '--cached',
  '--others',
  '--exclude-standard',
];
export const GIT_LS_FILES_TIMEOUT_MS = 5_000;
export const GIT_LS_FILES_MAX_OUTPUT_BYTES = 8 * 1024 * 1024;
export const PROJECT_WALK_BUDGET_MS = 3_000;
export const PROJECT_WALK_MAX_DEPTH = 12;
export const PROJECT_FILES_CACHE_MS = 30_000;

/** Folders the walk never enters (lower case): tool output, dependencies, VCS data, system folders. */
export const PROJECT_WALK_IGNORED: ReadonlySet<string> = new Set([
  '.git',
  '.hg',
  '.svn',
  'node_modules',
  'dist',
  'build',
  'out',
  'target',
  '.venv',
  'venv',
  '__pycache__',
  '.next',
  '.nuxt',
  '.turbo',
  '.cache',
  'coverage',
  '.idea',
  '.vs',
  '$recycle.bin',
  'system volume information',
]);

export interface ProjectFilesDeps {
  fs: FileFs;
  /** Absolute git.exe or null (default: resolveExecutable('git', process.env)). */
  resolveGit: () => Promise<string | null>;
  run?: RunFileFn;
  /** Environment of git (default: process.env). */
  env?: Record<string, string>;
  now?: () => number;
}

export interface ProjectFiles {
  /** `cwd` must be checked (safe, existing folder) by the caller. */
  list(entryId: EntryId, cwd: string): Promise<ProjectFileList>;
  invalidate(entryId: EntryId): void;
}

/**
 * NUL-separated git output → unique relative paths ('/' separators). Every path ends with NUL, so
 * the last part is '' after a complete output, or a cut path when the output hit the size limit
 * (`cut`) – dropped either way.
 */
export function parseLsFiles(stdout: string): string[] {
  const parts = stdout.split('\0');
  parts.pop();
  const seen = new Set<string>();
  const files: string[] = [];
  for (const part of parts) {
    if (part === '' || seen.has(part)) continue;
    seen.add(part);
    files.push(part.replace(/\\/g, '/'));
  }
  return files;
}

function limited(files: string[], truncated: boolean): { files: string[]; truncated: boolean } {
  if (files.length <= LIMITS.projectFilesMax) return { files, truncated };
  return { files: files.slice(0, LIMITS.projectFilesMax), truncated: true };
}

/** Breadth first (shallow files first, so a cut list keeps the top of the project). */
async function walk(
  fs: FileFs,
  root: string,
  now: () => number,
): Promise<{ files: string[]; truncated: boolean }> {
  const deadline = now() + PROJECT_WALK_BUDGET_MS;
  const files: string[] = [];
  const queue: { dir: string; rel: string; depth: number }[] = [{ dir: root, rel: '', depth: 0 }];
  for (let next = queue.shift(); next !== undefined; next = queue.shift()) {
    if (now() > deadline || files.length > LIMITS.projectFilesMax) return { files, truncated: true };
    let entries;
    try {
      entries = await fs.readdir(next.dir);
    } catch {
      continue; // unreadable or vanished folder, or a timeout: skip it
    }
    const sorted = [...entries].sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
    for (const entry of sorted) {
      // Links and junctions are never followed (they may lead out of the project or to a share).
      if (entry.isSymbolicLink()) continue;
      const rel = next.rel === '' ? entry.name : `${next.rel}/${entry.name}`;
      if (entry.isDirectory()) {
        if (PROJECT_WALK_IGNORED.has(entry.name.toLowerCase())) continue;
        if (next.depth + 1 <= PROJECT_WALK_MAX_DEPTH) {
          queue.push({ dir: path.win32.join(next.dir, entry.name), rel, depth: next.depth + 1 });
        }
      } else if (entry.isFile()) {
        files.push(rel);
      }
    }
  }
  return { files, truncated: false };
}

export function createProjectFiles(deps: ProjectFilesDeps): ProjectFiles {
  const now = deps.now ?? (() => Date.now());
  const run = deps.run ?? runFile;
  const cache = new Map<EntryId, { cwd: string; at: number; list: ProjectFileList }>();

  const fromGit = async (cwd: string): Promise<{ files: string[]; truncated: boolean } | null> => {
    let git: string | null;
    try {
      git = await deps.resolveGit();
    } catch {
      return null;
    }
    if (git === null) return null;
    try {
      const result = await run(git, GIT_LS_FILES_ARGS, {
        cwd,
        env: deps.env,
        timeoutMs: GIT_LS_FILES_TIMEOUT_MS,
        maxOutputBytes: GIT_LS_FILES_MAX_OUTPUT_BYTES,
      });
      if (result.timedOut || result.exitCode !== 0) return null;
      const cut = Buffer.byteLength(result.stdout, 'utf8') >= GIT_LS_FILES_MAX_OUTPUT_BYTES - 4;
      return { files: parseLsFiles(result.stdout), truncated: cut };
    } catch {
      return null; // git could not be started (AppLocker, gone)
    }
  };

  return {
    list: async (entryId, cwd) => {
      const cached = cache.get(entryId);
      if (cached?.cwd === cwd && now() - cached.at < PROJECT_FILES_CACHE_MS) {
        return cached.list;
      }
      const git = await fromGit(cwd);
      const found = git ?? (await walk(deps.fs, cwd, now));
      const { files, truncated } = limited(found.files, found.truncated);
      const list: ProjectFileList = { root: cwd, files, truncated, source: git === null ? 'walk' : 'git' };
      cache.set(entryId, { cwd, at: now(), list });
      return list;
    },
    invalidate: (entryId) => {
      cache.delete(entryId);
    },
  };
}
