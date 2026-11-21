/**
 * Git access of the public-repo check (WP-84): file list, local list, commits, objects, refs.
 * git runs as an absolute program without a shell (CLAUDE.md "Windows": `resolveExecutable`, the
 * `.exe` on Windows, e.g. `/usr/bin/git` on Linux).
 */
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { runFile, spawnHidden } from '../../src/server/lib/process';
import { resolveExecutable } from '../../src/server/lib/windows';

/** File name of the local list in the shared git directory (`git rev-parse --git-common-dir`). */
export const PRIVATE_LIST_NAME = 'public-check.local';

const GIT_TIMEOUT_MS = 300_000;
const MAX_OUTPUT_BYTES = 256 * 1024 * 1024;

let gitExePromise: Promise<string> | undefined;

async function gitExe(): Promise<string> {
  gitExePromise ??= resolveExecutable('git', process.env).then((exe) => {
    if (exe === null) throw new Error('public-check: git not found on PATH');
    return exe;
  });
  return gitExePromise;
}

export async function git(repo: string, args: readonly string[]): Promise<string> {
  const result = await runFile(await gitExe(), args, {
    cwd: repo,
    timeoutMs: GIT_TIMEOUT_MS,
    maxOutputBytes: MAX_OUTPUT_BYTES,
  });
  if (result.exitCode !== 0) {
    throw new Error(
      `public-check: git ${args[0] ?? ''} failed (${String(result.exitCode)}): ${result.stderr.trim()}`,
    );
  }
  if (Buffer.byteLength(result.stdout) >= MAX_OUTPUT_BYTES) {
    throw new Error(`public-check: output of git ${args[0] ?? ''} too large`);
  }
  return result.stdout;
}

export async function topLevel(repo: string): Promise<string> {
  return path.resolve((await git(repo, ['rev-parse', '--show-toplevel'])).trim());
}

/** Absolute shared git directory (the main repo's `.git`, also from a worktree). */
export async function commonDir(repo: string): Promise<string> {
  const dir = (await git(repo, ['rev-parse', '--git-common-dir'])).trim();
  return path.resolve(repo, dir);
}

/** Tracked files plus untracked ones that are not ignored (new files count before `git add`). */
export async function listFiles(repo: string): Promise<string[]> {
  const out = await git(repo, [
    'ls-files',
    '-z',
    '--cached',
    '--others',
    '--exclude-standard',
    '--deduplicate',
  ]);
  return out.split('\0').filter((file) => file.length > 0);
}

/** Tracked files only. */
export async function trackedFiles(repo: string): Promise<string[]> {
  const out = await git(repo, ['ls-files', '-z']);
  return out.split('\0').filter((file) => file.length > 0);
}

/** Terms text of the local list, or null if there is none (CI, fresh clone). */
export async function readPrivateList(repo: string, override?: string): Promise<string | null> {
  const file = override ?? path.join(await commonDir(repo), PRIVATE_LIST_NAME);
  try {
    return await readFile(file, 'utf8');
  } catch (error) {
    if (override !== undefined) throw error;
    return null;
  }
}

export interface CommitInfo {
  sha: string;
  authorName: string;
  authorEmail: string;
  committerName: string;
  committerEmail: string;
  message: string;
}

/** Commits of a revision range (arguments as for `git rev-list`, e.g. `origin/main..HEAD`, `--all`). */
export async function commits(repo: string, range: readonly string[]): Promise<CommitInfo[]> {
  const out = await git(repo, ['log', '--format=%H%x00%an%x00%ae%x00%cn%x00%ce%x00%B%x1e', ...range, '--']);
  return out
    .split('\x1e')
    .map((record) => record.replace(/^\r?\n/u, ''))
    .filter((record) => record.length > 0)
    .map((record) => {
      const [
        sha = '',
        authorName = '',
        authorEmail = '',
        committerName = '',
        committerEmail = '',
        message = '',
      ] = record.split('\0');
      return { sha, authorName, authorEmail, committerName, committerEmail, message };
    });
}

export interface ObjectEntry {
  sha: string;
  /** Path of the object in the first commit that reached it ('' for commits and root trees). */
  path: string;
}

/** Objects (commits, trees, blobs) reachable from the range and not from its excluded side. */
export async function objects(repo: string, range: readonly string[]): Promise<ObjectEntry[]> {
  const out = await git(repo, ['rev-list', '--objects', ...range, '--']);
  return out
    .split('\n')
    .filter((line) => line.length > 0)
    .map((line) => {
      const space = line.indexOf(' ');
      return space === -1
        ? { sha: line, path: '' }
        : { sha: line.slice(0, space), path: line.slice(space + 1) };
    });
}

export interface RefEntry {
  sha: string;
  name: string;
}

/** Local branches and tags. */
export async function refs(repo: string): Promise<RefEntry[]> {
  const out = await git(repo, [
    'for-each-ref',
    '--format=%(objectname) %(refname)',
    'refs/heads',
    'refs/tags',
  ]);
  return out
    .split('\n')
    .filter((line) => line.length > 0)
    .map((line) => {
      const space = line.indexOf(' ');
      return { sha: line.slice(0, space), name: line.slice(space + 1) };
    });
}

/**
 * Streams the blobs among `shas` through `git cat-file --batch`; other object types are skipped.
 * `onBlob` gets each blob's content as a Buffer.
 */
export async function readBlobs(
  repo: string,
  shas: readonly string[],
  onBlob: (sha: string, content: Buffer) => void,
): Promise<void> {
  const child = spawnHidden(await gitExe(), ['cat-file', '--batch'], {
    cwd: repo,
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  let pending: Buffer = Buffer.alloc(0);
  let header: { sha: string; type: string; size: number } | null = null;
  let failure: Error | null = null;
  const drain = (): void => {
    for (;;) {
      if (header === null) {
        const end = pending.indexOf(0x0a);
        if (end === -1) return;
        const line = pending.subarray(0, end).toString('utf8');
        pending = pending.subarray(end + 1);
        const [sha = '', type = '', size = ''] = line.split(' ');
        if (type === 'missing') {
          failure ??= new Error(`public-check: object ${sha} missing`);
          continue;
        }
        header = { sha, type, size: Number(size) };
      }
      if (pending.length < header.size + 1) return;
      if (header.type === 'blob') onBlob(header.sha, pending.subarray(0, header.size));
      pending = pending.subarray(header.size + 1);
      header = null;
    }
  };
  const done = new Promise<void>((resolve, reject) => {
    child.once('error', reject);
    child.once('close', (code) => {
      if (failure !== null) reject(failure);
      else if (code !== 0) reject(new Error(`public-check: git cat-file failed (${String(code)})`));
      else resolve();
    });
  });
  child.stdout?.on('data', (chunk: Buffer) => {
    pending = pending.length === 0 ? chunk : Buffer.concat([pending, chunk]);
    drain();
  });
  child.stdin?.end(shas.map((sha) => `${sha}\n`).join(''));
  await done;
}
