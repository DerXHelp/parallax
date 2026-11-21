/**
 * Repository operations of the git service (WP-111; ADR-250, ADR-252, ADR-253). Every function takes a
 * `GitContext` (runner, the session's env, the host's path rules) and a folder; git runs through the
 * runner only (absolute `git`, argument arrays, paths after `--`, reads hardened).
 *
 * - Lists run in the repository root (`--show-toplevel`): porcelain and diff paths are relative to it
 *   and `/`-separated; `ls-files` would list relative to the folder it runs in.
 * - Diffs: `--no-color --no-ext-diff --no-textconv --no-relative -M` – an external diff tool or a
 *   textconv filter from a foreign repository's configuration never runs on a read. Untracked files
 *   count as added (`ls-files --others --exclude-standard`); their content is read here (regular files
 *   only, never through a link, at most LIMITS.gitPatchBytes, binary when a NUL byte appears in the
 *   first 8000 bytes – git's own rule).
 * - Limits: LIMITS.gitFilesMax files per list (`truncated`), LIMITS.gitPatchBytes per patch.
 */
import { constants } from 'node:fs';
import { appendFile, copyFile, lstat, mkdir, readFile, realpath } from 'node:fs/promises';
import { LIMITS } from '@shared/common';
import { makeError } from '@shared/errors';
import {
  isValidGitRefName,
  type GitDiffFile,
  type GitDiffScope,
  type GitStatus,
  type GitWorktree,
  type WorktreeInspection,
} from '@shared/model';
import type { PathRules } from '@shared/paths';
import { readFileHead } from '../lib/fileRead';
import { logger } from '../lib/logger';
import { fsErrorCode, pathModuleOf } from '../lib/paths';
import { CommandError } from '../sync/ports';
import {
  classifyPushFailure,
  countPatchLines,
  hostPath,
  parseRawNumstat,
  parseStatusV2,
  parseWorktreeList,
  patchBody,
  rootInCwdSpelling,
  splitNul,
  type DiffEntry,
} from './parse';
import {
  GIT_LONG_TIMEOUT_MS,
  isNotARepoMessage,
  scrubGitMessage,
  type GitCall,
  type GitRunner,
} from './runner';

/** Empty tree of a sha1 / sha256 repository (diff base before the first commit). */
const EMPTY_TREE = {
  sha1: '4b825dc642cb6eb9a060e54bf8d69288fbee4904',
  sha256: '6ef19b41225c5369f1c104d45d8d85efa9b057b53b14b4b9b939dd74decc5321',
} as const;

/** git's binary rule: a NUL byte in the first 8000 bytes. */
const BINARY_SNIFF_BYTES = 8000;
/** Content of untracked files read for one diff list (line counts); beyond it additions stay 0. */
export const UNTRACKED_LIST_BUDGET_BYTES = 32 * 1024 * 1024;
/** `.worktreeinclude`: at most this many files / bytes are copied into a new worktree. */
export const WORKTREE_INCLUDE_LIMITS = { files: 2_000, bytes: 512 * 1024 * 1024 } as const;
/** The folder of Parallax's worktrees below the repository root (like `claude --worktree`). */
export const WORKTREES_DIR = ['.claude', 'worktrees'] as const;

const DIFF_OPTIONS = ['--no-color', '--no-ext-diff', '--no-textconv', '--no-relative', '-M'] as const;

export interface GitContext {
  runner: GitRunner;
  env: Readonly<Record<string, string>>;
  rules: PathRules;
}

function call(
  ctx: GitContext,
  cwd: string,
  op: GitCall['op'],
  mode: GitCall['mode'],
  args: readonly string[],
  extra: Partial<Pick<GitCall, 'timeoutMs' | 'maxOutputBytes' | 'readsWorktree'>> = {},
): GitCall {
  return { cwd, env: ctx.env, op, mode, args, ...extra };
}

function firstLine(text: string): string {
  return (text.split(/\r?\n/)[0] ?? '').trim();
}

/** `folder` exists and is a folder (git would fail with a confusing spawn error otherwise). */
export async function isFolder(folder: string): Promise<boolean> {
  try {
    return (await lstat(folder)).isDirectory();
  } catch {
    return false;
  }
}

/**
 * Root of the worktree `cwd` belongs to (host spelling; `cwd`'s spelling when it lies inside), or
 * null when `cwd` is in no repository (or is missing). Throws GIT_NOT_FOUND / GIT_FAILED (timeout).
 */
export async function worktreeRoot(ctx: GitContext, cwd: string): Promise<string | null> {
  if (ctx.rules.issue(cwd) !== null || !(await isFolder(cwd))) return null;
  const result = await ctx.runner.run(call(ctx, cwd, 'status', 'read', ['rev-parse', '--show-toplevel']));
  if (result.exitCode !== 0) return null;
  const line = firstLine(result.stdout);
  if (line === '') return null;
  const root = hostPath(line, ctx.rules);
  if (ctx.rules.issue(root) !== null) return null;
  return rootInCwdSpelling(root, cwd, ctx.rules);
}

/** Like `worktreeRoot`, but NOT_A_GIT_REPO {path} instead of null. */
export async function requireRoot(ctx: GitContext, cwd: string): Promise<string> {
  const root = await worktreeRoot(ctx, cwd);
  if (root === null) throw new CommandError(makeError('NOT_A_GIT_REPO', { path: cwd }));
  return root;
}

/** Commit of `ref` (`<ref>^{commit}`), or null when it does not resolve. */
export async function resolveCommit(ctx: GitContext, cwd: string, ref: string): Promise<string | null> {
  const result = await ctx.runner.run(
    call(ctx, cwd, 'status', 'read', [
      'rev-parse',
      '--verify',
      '--quiet',
      '--end-of-options',
      `${ref}^{commit}`,
    ]),
  );
  if (result.exitCode !== 0) return null;
  const sha = firstLine(result.stdout).toLowerCase();
  return /^[0-9a-f]{40}(?:[0-9a-f]{24})?$/.test(sha) ? sha : null;
}

/** Commit of `HEAD`, or null (no commit yet, no repository). */
export function headCommit(ctx: GitContext, cwd: string): Promise<string | null> {
  return resolveCommit(ctx, cwd, 'HEAD');
}

/** Merge base of two commits, or null. */
export async function mergeBase(ctx: GitContext, cwd: string, a: string, b: string): Promise<string | null> {
  const result = await ctx.runner.run(
    call(ctx, cwd, 'diff', 'read', ['merge-base', '--end-of-options', a, b]),
  );
  if (result.exitCode !== 0) return null;
  const sha = firstLine(result.stdout).toLowerCase();
  return /^[0-9a-f]{40}(?:[0-9a-f]{24})?$/.test(sha) ? sha : null;
}

async function emptyTree(ctx: GitContext, root: string): Promise<string> {
  const result = await ctx.runner.run(call(ctx, root, 'diff', 'read', ['rev-parse', '--show-object-format']));
  return firstLine(result.stdout) === 'sha256' ? EMPTY_TREE.sha256 : EMPTY_TREE.sha1;
}

/** Current branch (short name) of the worktree, or null (detached, unborn without a name, error). */
export async function currentBranch(ctx: GitContext, cwd: string): Promise<string | null> {
  const result = await ctx.runner.run(
    call(ctx, cwd, 'status', 'read', ['symbolic-ref', '--quiet', '--short', 'HEAD']),
  );
  if (result.exitCode !== 0) return null;
  const branch = firstLine(result.stdout);
  return branch === '' ? null : branch;
}

// ---- status ----

const NO_REPO_STATUS: GitStatus = {
  isRepo: false,
  root: null,
  branch: null,
  detached: false,
  head: null,
  upstream: null,
  ahead: 0,
  behind: 0,
  files: [],
  truncated: false,
};

/** `git.status` of `cwd`: `isRepo: false` (not an error) when `cwd` is in no repository. */
export async function readStatus(ctx: GitContext, cwd: string): Promise<GitStatus> {
  const root = await worktreeRoot(ctx, cwd);
  if (root === null) return { ...NO_REPO_STATUS, files: [] };
  const result = await ctx.runner.ok(
    call(
      ctx,
      root,
      'status',
      'read',
      ['status', '--porcelain=v2', '--branch', '-z', '--untracked-files=all'],
      { readsWorktree: true },
    ),
  );
  const parsed = parseStatusV2(result.stdout);
  const truncated = result.truncated || parsed.files.length > LIMITS.gitFilesMax;
  return {
    isRepo: true,
    root,
    branch: parsed.branch === null ? null : parsed.branch.slice(0, LIMITS.gitRefChars),
    detached: parsed.detached,
    head: parsed.head,
    upstream: parsed.upstream === null ? null : parsed.upstream.slice(0, LIMITS.gitRefChars),
    ahead: parsed.ahead,
    behind: parsed.behind,
    files: parsed.files.slice(0, LIMITS.gitFilesMax),
    truncated,
  };
}

// ---- diffs ----

/** What a diff compares (ADR-253): `base` null = HEAD/index scopes (the answer's `base`). */
export interface DiffSpec {
  scope: GitDiffScope;
  /** `session`: the session's base commit (null = no commit yet → the empty tree). */
  base: string | null;
}

/** The arguments selecting the two sides of `spec` (`staged` = index vs HEAD). */
async function sides(ctx: GitContext, root: string, spec: DiffSpec): Promise<string[]> {
  if (spec.scope === 'staged') return ['--cached'];
  const from = spec.scope === 'session' ? spec.base : await headCommit(ctx, root);
  return [from ?? (await emptyTree(ctx, root))];
}

/** Untracked files (relative, `/`), without nested repositories (git lists those as `dir/`). */
async function untrackedFiles(ctx: GitContext, root: string): Promise<string[]> {
  const result = await ctx.runner.ok(
    call(ctx, root, 'diff', 'read', ['ls-files', '--others', '--exclude-standard', '-z']),
  );
  return splitNul(result.stdout).filter((p) => p !== '' && !p.endsWith('/'));
}

/** Absolute host path of a repository-relative git path; null if it would leave the root or is unsafe. */
export function absoluteIn(root: string, relative: string, rules: PathRules): string | null {
  const segments = relative.split('/');
  if (segments.some((s) => s === '' || s === '.' || s === '..')) return null;
  const full = rules.join(root, segments.join(rules.separator));
  return rules.issue(full) === null && rules.isInside(full, root) ? full : null;
}

interface UntrackedContent {
  binary: boolean;
  /** Text (only for text files), cut at `max` bytes. */
  text: string | null;
  truncated: boolean;
}

/** Content of an untracked file: regular files only (never through a link), at most `max` bytes. */
async function readUntracked(full: string, max: number): Promise<UntrackedContent | null> {
  try {
    const info = await lstat(full);
    if (!info.isFile()) return null;
    const bytes = await readFileHead(full, max + 1);
    const truncated = bytes.length > max;
    const head = bytes.subarray(0, Math.min(bytes.length, BINARY_SNIFF_BYTES));
    if (head.includes(0)) return { binary: true, text: null, truncated };
    return {
      binary: false,
      text: bytes.subarray(0, Math.min(bytes.length, max)).toString('utf8'),
      truncated,
    };
  } catch (error) {
    logger.debug({ code: fsErrorCode(error) }, 'untracked file unreadable');
    return null;
  }
}

function lineCount(text: string): number {
  if (text === '') return 0;
  const lines = text.split('\n').length;
  return text.endsWith('\n') ? lines - 1 : lines;
}

/** Unified diff of a new file (`@@ -0,0 +1,N @@`), cut at `max` bytes. */
export function addedFilePatch(
  text: string,
  max: number = LIMITS.gitPatchBytes,
): { patch: string; truncated: boolean } {
  const n = lineCount(text);
  if (n === 0) return { patch: '', truncated: false };
  const lines = text.split('\n');
  if (text.endsWith('\n')) lines.pop();
  let patch = `@@ -0,0 +1${n === 1 ? '' : `,${n}`} @@\n`;
  let truncated = false;
  for (const line of lines) {
    const next = `+${line}\n`;
    if (Buffer.byteLength(patch, 'utf8') + Buffer.byteLength(next, 'utf8') > max) {
      truncated = true;
      break;
    }
    patch += next;
  }
  if (!truncated && !text.endsWith('\n')) patch += '\\ No newline at end of file\n';
  return { patch, truncated };
}

export interface DiffListResult {
  root: string;
  files: GitDiffFile[];
  truncated: boolean;
}

interface CollectedDiff {
  root: string;
  items: { file: GitDiffFile; untracked: boolean }[];
  truncated: boolean;
}

type KeepFn = (path: string, origPath: string | null) => boolean;

/** `root` is the root of the worktree (callers resolved it with `requireRoot`). */
async function collectDiff(
  ctx: GitContext,
  root: string,
  spec: DiffSpec,
  keep: KeepFn | null,
): Promise<CollectedDiff> {
  const result = await ctx.runner.ok(
    call(
      ctx,
      root,
      'diff',
      'read',
      ['diff', '--raw', '--numstat', '-z', ...DIFF_OPTIONS, ...(await sides(ctx, root, spec)), '--'],
      { readsWorktree: spec.scope !== 'staged' },
    ),
  );
  let truncated = result.truncated;
  const items: CollectedDiff['items'] = parseRawNumstat(result.stdout)
    .filter((e) => keep === null || keep(e.path, e.origPath))
    .map((e) => ({ file: toDiffFile(e), untracked: false }));
  if (spec.scope !== 'staged') {
    const known = new Set(items.map((i) => i.file.path));
    let budget = UNTRACKED_LIST_BUDGET_BYTES;
    for (const path of await untrackedFiles(ctx, root)) {
      if (known.has(path) || (keep !== null && !keep(path, null))) continue;
      if (items.length > LIMITS.gitFilesMax) break;
      const full = absoluteIn(root, path, ctx.rules);
      if (full === null) continue;
      let additions = 0;
      let binary = false;
      if (budget > 0) {
        const content = await readUntracked(full, Math.min(LIMITS.gitPatchBytes, budget));
        if (content !== null) {
          binary = content.binary;
          additions = content.text === null ? 0 : lineCount(content.text);
          budget -= content.text === null ? BINARY_SNIFF_BYTES : Buffer.byteLength(content.text, 'utf8');
        }
      }
      items.push({
        file: {
          path,
          origPath: null,
          kind: 'added',
          binary,
          additions,
          deletions: 0,
          patch: null,
          truncated: false,
        },
        untracked: true,
      });
    }
  }
  if (items.length > LIMITS.gitFilesMax) truncated = true;
  return { root, items: items.slice(0, LIMITS.gitFilesMax), truncated };
}

/**
 * The changed files of `spec` without patches; untracked files as `added` (except for `staged`).
 * `keep` filters by repository-relative path (only files of the session, ADR-253).
 */
export async function diffList(
  ctx: GitContext,
  cwd: string,
  spec: DiffSpec,
  keep: KeepFn | null = null,
): Promise<DiffListResult> {
  return diffListAt(ctx, await requireRoot(ctx, cwd), spec, keep);
}

/** `diffList` for a root the caller resolved already (CR9: one `rev-parse` per command). */
export async function diffListAt(
  ctx: GitContext,
  root: string,
  spec: DiffSpec,
  keep: KeepFn | null = null,
): Promise<DiffListResult> {
  const collected = await collectDiff(ctx, root, spec, keep);
  return { root: collected.root, files: collected.items.map((i) => i.file), truncated: collected.truncated };
}

function toDiffFile(e: DiffEntry): GitDiffFile {
  return {
    path: e.path,
    origPath: e.origPath,
    kind: e.kind,
    binary: e.binary,
    additions: e.additions,
    deletions: e.deletions,
    patch: null,
    truncated: false,
  };
}

/**
 * The patch of one file of `spec` (`path` relative to the root, `/`). VALIDATION_FAILED {field: 'path'}
 * when the file is not part of the diff (committed meanwhile, never changed).
 */
export async function fileDiff(
  ctx: GitContext,
  cwd: string,
  spec: DiffSpec,
  path: string,
): Promise<GitDiffFile> {
  return fileDiffAt(ctx, await requireRoot(ctx, cwd), spec, path);
}

/** `path` is an untracked, not ignored file of the worktree (literal pathspec). */
async function isUntracked(ctx: GitContext, root: string, path: string): Promise<boolean> {
  const result = await ctx.runner.ok(
    call(ctx, root, 'diff', 'read', [
      '--literal-pathspecs',
      'ls-files',
      '--others',
      '--exclude-standard',
      '-z',
      '--',
      path,
    ]),
  );
  return splitNul(result.stdout).includes(path);
}

/** The diff of a new (untracked) file, built from its content. */
async function untrackedFileDiff(ctx: GitContext, root: string, path: string): Promise<GitDiffFile> {
  const entry: GitDiffFile = {
    path,
    origPath: null,
    kind: 'added',
    binary: false,
    additions: 0,
    deletions: 0,
    patch: null,
    truncated: false,
  };
  const full = absoluteIn(root, path, ctx.rules);
  const content = full === null ? null : await readUntracked(full, LIMITS.gitPatchBytes);
  const text = content?.text ?? null;
  if (content === null || text === null) return { ...entry, binary: content?.binary ?? false };
  const built = addedFilePatch(text);
  return {
    ...entry,
    additions: lineCount(text),
    patch: built.patch,
    truncated: built.truncated || content.truncated,
  };
}

/**
 * `fileDiff` for a root the caller resolved already. CR9: kind and rename partner come from the
 * name status of the diff (`--raw`, no line counts of the other files, no untracked listing); the
 * patch and – when it was cut – the line counts from calls limited to the file (literal pathspecs).
 */
export async function fileDiffAt(
  ctx: GitContext,
  root: string,
  spec: DiffSpec,
  path: string,
): Promise<GitDiffFile> {
  const notInDiff = (): CommandError =>
    new CommandError(makeError('VALIDATION_FAILED', { field: 'path', reason: 'not_in_diff' }));
  if (absoluteIn(root, path, ctx.rules) === null) throw notInDiff();
  const worktree = spec.scope !== 'staged';
  const from = await sides(ctx, root, spec);
  const raw = await ctx.runner.ok(
    call(ctx, root, 'diff', 'read', ['diff', '--raw', '-z', ...DIFF_OPTIONS, ...from, '--'], {
      readsWorktree: worktree,
    }),
  );
  const entries = parseRawNumstat(raw.stdout);
  const entry = entries.find((e) => e.path === path) ?? entries.find((e) => e.origPath === path);
  if (entry === undefined) {
    if (worktree && (await isUntracked(ctx, root, path))) return untrackedFileDiff(ctx, root, path);
    throw notInDiff();
  }
  const base = toDiffFile(entry);
  const paths = entry.origPath === null ? [entry.path] : [entry.path, entry.origPath];
  const limited = (args: readonly string[]): string[] => [
    '--literal-pathspecs',
    'diff',
    ...args,
    ...DIFF_OPTIONS,
    ...from,
    '--',
    ...paths,
  ];
  const result = await ctx.runner.ok(
    call(ctx, root, 'diff', 'read', limited([]), {
      maxOutputBytes: LIMITS.gitPatchBytes,
      readsWorktree: worktree,
    }),
  );
  const body = patchBody(result.stdout);
  if (body.binary) return { ...base, binary: true, patch: null };
  let counts = countPatchLines(body.patch);
  if (result.truncated) {
    const stat = await ctx.runner.ok(
      call(ctx, root, 'diff', 'read', limited(['--raw', '--numstat', '-z']), { readsWorktree: worktree }),
    );
    const whole = parseRawNumstat(stat.stdout).find((e) => e.path === entry.path);
    if (whole !== undefined) counts = { additions: whole.additions, deletions: whole.deletions };
  }
  return { ...base, ...counts, patch: body.patch, truncated: result.truncated };
}

// ---- writing ----

/** Commit everything (`paths` null) or exactly the given files (repository-relative, `/`). */
export async function commit(
  ctx: GitContext,
  cwd: string,
  message: string,
  paths: readonly string[] | null,
): Promise<string> {
  const root = await requireRoot(ctx, cwd);
  if (paths !== null) {
    for (const p of paths) {
      if (absoluteIn(root, p, ctx.rules) === null) {
        throw new CommandError(makeError('VALIDATION_FAILED', { field: 'paths', reason: 'outside' }));
      }
    }
  }
  // CR3: file names are literal (`[id].ts`, `*.md` are names, never globs).
  const scope = paths === null ? [] : ['--', ...paths];
  await ctx.runner.ok(
    call(ctx, root, 'commit', 'write', ['--literal-pathspecs', 'add', '-A', ...scope], {
      timeoutMs: GIT_LONG_TIMEOUT_MS,
    }),
  );
  await ctx.runner.ok(
    call(
      ctx,
      root,
      'commit',
      'write',
      ['--literal-pathspecs', 'commit', '--no-edit', '-m', message, ...scope],
      {
        timeoutMs: GIT_LONG_TIMEOUT_MS,
      },
    ),
  );
  const sha = await headCommit(ctx, root);
  if (sha === null)
    throw new CommandError(makeError('GIT_FAILED', { op: 'commit', detail: 'no HEAD after commit' }));
  return sha;
}

/** `refs/heads/<name>` exists. */
export async function branchExists(ctx: GitContext, cwd: string, name: string): Promise<boolean> {
  const result = await ctx.runner.run(
    call(ctx, cwd, 'branch_create', 'read', ['show-ref', '--verify', '--quiet', `refs/heads/${name}`]),
  );
  return result.exitCode === 0;
}

/** New branch at HEAD (BRANCH_EXISTS {branch}); `switchTo` checks it out. */
export async function createBranch(
  ctx: GitContext,
  cwd: string,
  name: string,
  switchTo: boolean,
): Promise<void> {
  const root = await requireRoot(ctx, cwd);
  if (await branchExists(ctx, root, name))
    throw new CommandError(makeError('BRANCH_EXISTS', { branch: name }));
  if (switchTo) {
    await ctx.runner.ok(call(ctx, root, 'branch_create', 'write', ['switch', '--no-guess', '-c', name]));
  } else {
    await ctx.runner.ok(call(ctx, root, 'branch_create', 'write', ['branch', '--no-track', name]));
  }
}

/** Switches to a branch; git refuses when local changes would be overwritten (GIT_FAILED {op: 'branch_switch'}). */
export async function switchBranch(ctx: GitContext, cwd: string, name: string): Promise<void> {
  const root = await requireRoot(ctx, cwd);
  await ctx.runner.ok(
    call(ctx, root, 'branch_switch', 'write', ['switch', name], { timeoutMs: GIT_LONG_TIMEOUT_MS }),
  );
}

/** The remote a new upstream goes to: `origin`, else the only remote; null = none (or ambiguous). */
async function pushRemote(ctx: GitContext, root: string): Promise<string | null> {
  const result = await ctx.runner.ok(call(ctx, root, 'push', 'read', ['remote']));
  const remotes = result.stdout
    .split(/\r?\n/)
    .map((r) => r.trim())
    .filter((r) => r !== '');
  if (remotes.includes('origin')) return 'origin';
  return remotes.length === 1 ? (remotes[0] ?? null) : null;
}

function pushFailed(reason: 'auth' | 'rejected' | 'network' | 'other', detail: string): CommandError {
  return new CommandError(makeError('GIT_PUSH_FAILED', { reason, ...(detail === '' ? {} : { detail }) }));
}

/** `git push` (without an upstream `-u <remote> <branch>`). GIT_PUSH_FAILED {reason}. */
export async function push(ctx: GitContext, cwd: string): Promise<void> {
  const status = await readStatus(ctx, cwd);
  if (!status.isRepo || status.root === null)
    throw new CommandError(makeError('NOT_A_GIT_REPO', { path: cwd }));
  if (status.branch === null) throw pushFailed('other', 'detached HEAD');
  const root = status.root;
  let args: string[];
  if (status.upstream === null) {
    const remote = await pushRemote(ctx, root);
    if (remote === null) throw pushFailed('other', 'no remote');
    // SR4: names from the repository's configuration never become options (`--`, ref name rules).
    if (!isValidGitRefName(remote) || !isValidGitRefName(status.branch))
      throw pushFailed('other', 'invalid name');
    args = ['push', '--porcelain', '-u', '--', remote, status.branch];
  } else {
    args = ['push', '--porcelain'];
  }
  let result;
  try {
    result = await ctx.runner.run(call(ctx, root, 'push', 'write', args, { timeoutMs: GIT_LONG_TIMEOUT_MS }));
  } catch (error) {
    if (
      error instanceof CommandError &&
      error.error.code === 'GIT_FAILED' &&
      error.error.params.detail === 'timeout'
    ) {
      throw pushFailed('network', 'timeout');
    }
    throw error;
  }
  if (result.exitCode === 0) return;
  const text = `${result.stderr}\n${result.stdout}`;
  throw pushFailed(
    classifyPushFailure(text),
    scrubGitMessage(result.stderr === '' ? result.stdout : result.stderr),
  );
}

// ---- worktrees ----

export interface WorktreeListResult {
  /** Root of the main worktree (host spelling); null = `cwd` is in no repository. */
  repoRoot: string | null;
  worktrees: GitWorktree[];
}

/** `git worktree list` of the repository of `cwd` (the main worktree first). */
export async function listWorktrees(ctx: GitContext, cwd: string): Promise<WorktreeListResult> {
  const root = await worktreeRoot(ctx, cwd);
  if (root === null) return { repoRoot: null, worktrees: [] };
  const result = await ctx.runner.ok(
    call(ctx, root, 'worktree_list', 'read', ['worktree', 'list', '--porcelain', '-z']),
  );
  const worktrees = parseWorktreeList(result.stdout, ctx.rules)
    .slice(0, LIMITS.worktreesMax)
    .map((w) => ({ ...w, path: rootInCwdSpelling(w.path, cwd, ctx.rules) }));
  const main = worktrees.find((w) => w.main);
  return { repoRoot: main?.path ?? null, worktrees };
}

/**
 * `git worktree add -b <branch> <path> <base>` from the main worktree (a new branch at a commit – never
 * at a remote branch name: the new branch must not get that upstream, a push would go there).
 */
export async function addWorktree(
  ctx: GitContext,
  repoRoot: string,
  path: string,
  branch: string,
  baseSha: string,
): Promise<void> {
  await ctx.runner.ok(
    call(ctx, repoRoot, 'worktree_add', 'write', ['worktree', 'add', '-b', branch, '--', path, baseSha], {
      timeoutMs: GIT_LONG_TIMEOUT_MS,
    }),
  );
}

/** `git worktree remove [--force] <path>`; a folder that is gone already is pruned instead. */
export async function removeWorktree(
  ctx: GitContext,
  repoRoot: string,
  path: string,
  force: boolean,
): Promise<void> {
  if (!(await isFolder(path))) {
    await ctx.runner.ok(call(ctx, repoRoot, 'worktree_remove', 'write', ['worktree', 'prune']));
    return;
  }
  const args = ['worktree', 'remove', ...(force ? ['--force', '--force'] : []), '--', path];
  await ctx.runner.ok(
    call(ctx, repoRoot, 'worktree_remove', 'write', args, { timeoutMs: GIT_LONG_TIMEOUT_MS }),
  );
}

/** `git branch -d|-D <branch>`. */
export async function deleteBranch(
  ctx: GitContext,
  repoRoot: string,
  branch: string,
  force: boolean,
): Promise<void> {
  await ctx.runner.ok(
    call(ctx, repoRoot, 'branch_delete', 'write', ['branch', force ? '-D' : '-d', '--', branch]),
  );
}

/** `WorktreeInspection` with `unpushedCommits: null` = they could not be counted (CR4). */
export interface WorktreeLoss extends Omit<WorktreeInspection, 'unpushedCommits'> {
  unpushedCommits: number | null;
}

/**
 * What deleting a worktree would lose (ADR-250): uncommitted files (incl. untracked), commits on
 * `branch` that are in no remote branch and not in `base` (ref, else the commit), and whether
 * `branch` is contained in `base`. CR4: a count that fails is unknown, never 0 – `worktree.inspect`
 * answers GIT_FAILED, `worktree.remove` treats it as open work (`inspectWorktreeLoss`).
 */
export async function inspectWorktree(
  ctx: GitContext,
  worktreePath: string,
  repoRoot: string,
  branch: string,
  base: { ref: string; sha: string },
): Promise<WorktreeInspection> {
  const loss = await inspectWorktreeLoss(ctx, worktreePath, repoRoot, branch, base);
  if (loss.unpushedCommits === null) {
    throw new CommandError(makeError('GIT_FAILED', { op: 'status', detail: 'unpushed commits unknown' }));
  }
  return { ...loss, unpushedCommits: loss.unpushedCommits };
}

/** Like `inspectWorktree`, with `unpushedCommits: null` when git could not count them. */
export async function inspectWorktreeLoss(
  ctx: GitContext,
  worktreePath: string,
  repoRoot: string,
  branch: string,
  base: { ref: string; sha: string },
): Promise<WorktreeLoss> {
  let dirtyFiles = 0;
  if (await isFolder(worktreePath)) {
    const result = await ctx.runner.run(
      call(ctx, worktreePath, 'status', 'read', ['status', '--porcelain=v2', '-z', '--untracked-files=all'], {
        readsWorktree: true,
      }),
    );
    if (result.exitCode === 0) dirtyFiles = parseStatusV2(result.stdout).files.length;
    else if (!isNotARepoMessage(result.stderr))
      throw new CommandError(
        makeError('GIT_FAILED', { op: 'status', detail: scrubGitMessage(result.stderr) }),
      );
  }
  const tip = await resolveCommit(ctx, repoRoot, `refs/heads/${branch}`);
  if (tip === null) return { dirtyFiles, unpushedCommits: 0, branchMerged: true };
  const baseCommit =
    (await resolveCommit(ctx, repoRoot, base.ref)) ?? (await resolveCommit(ctx, repoRoot, base.sha));
  const count = await ctx.runner.run(
    call(ctx, repoRoot, 'status', 'read', [
      'rev-list',
      '--count',
      tip,
      '--not',
      '--remotes',
      ...(baseCommit === null ? [] : [baseCommit]),
    ]),
  );
  const counted = count.exitCode === 0 ? firstLine(count.stdout) : '';
  const unpushedCommits = /^\d+$/.test(counted) ? Number(counted) : null;
  let branchMerged = false;
  if (baseCommit !== null) {
    const merged = await ctx.runner.run(
      call(ctx, repoRoot, 'status', 'read', ['merge-base', '--is-ancestor', tip, baseCommit]),
    );
    branchMerged = merged.exitCode === 0;
  }
  return { dirtyFiles, unpushedCommits, branchMerged };
}

/**
 * Keeps `<repoRoot>/<relative>` out of the main worktree's status: unless git ignores it already, a
 * line `/<relative>/` goes into `<common git dir>/info/exclude` (local; no file of the repository
 * changes, ADR-250). `relative` is `/`-separated. Returns whether a line was added.
 */
export async function ensureExcluded(ctx: GitContext, repoRoot: string, relative: string): Promise<boolean> {
  const ignored = await ctx.runner.run(
    call(ctx, repoRoot, 'status', 'read', ['check-ignore', '-q', '--', `${relative}/`]),
  );
  if (ignored.exitCode === 0) return false;
  const dir = await ctx.runner.ok(
    call(ctx, repoRoot, 'status', 'read', ['rev-parse', '--path-format=absolute', '--git-common-dir']),
  );
  const common = hostPath(firstLine(dir.stdout), ctx.rules);
  if (ctx.rules.issue(common) !== null) return false;
  const p = pathModuleOf(ctx.rules);
  const file = p.join(common, 'info', 'exclude');
  const line = `/${relative}/`;
  let text = '';
  try {
    text = await readFile(file, 'utf8');
  } catch (error) {
    if (fsErrorCode(error) !== 'ENOENT') throw error;
  }
  if (text.split(/\r?\n/).some((l) => l.trim() === line)) return false;
  await mkdir(p.dirname(file), { recursive: true });
  const prefix = text === '' || text.endsWith('\n') ? '' : '\n';
  await appendFile(file, `${prefix}${line}\n`, 'utf8');
  return true;
}

export interface IncludeResult {
  copied: number;
  skipped: number;
  /** A limit of WORKTREE_INCLUDE_LIMITS stopped the copy. */
  limited: boolean;
}

/** `rel` paths in batches whose argument text stays well below the Windows command line limit. */
function batches(paths: readonly string[], maxChars = 8_000): string[][] {
  const out: string[][] = [];
  let current: string[] = [];
  let size = 0;
  for (const p of paths) {
    if (current.length > 0 && size + p.length + 3 > maxChars) {
      out.push(current);
      current = [];
      size = 0;
    }
    current.push(p);
    size += p.length + 3;
  }
  if (current.length > 0) out.push(current);
  return out;
}

/**
 * SR2: `<root>/<segments…>` leads through no link – every segment that exists is a real folder
 * (`lstat`: a symbolic link or a Windows junction counts as a link). Missing segments are fine (git
 * creates them). False = a link or a file is in the way (a folder of the repository could point the
 * new worktree – and later its deletion – anywhere).
 */
export async function plainFolderChain(
  root: string,
  segments: readonly string[],
  rules: PathRules,
): Promise<boolean> {
  const p = pathModuleOf(rules);
  let current = root;
  for (const segment of segments) {
    current = p.join(current, segment);
    try {
      const info = await lstat(current);
      if (info.isSymbolicLink() || !info.isDirectory()) return false;
    } catch (error) {
      return fsErrorCode(error) === 'ENOENT';
    }
  }
  return true;
}

/** Where `folder` physically lies (it or its deepest existing ancestor, links resolved); null on errors. */
async function physicalAncestor(folder: string, rules: PathRules): Promise<string | null> {
  const p = pathModuleOf(rules);
  let current = folder;
  for (;;) {
    try {
      return await realpath(current);
    } catch (error) {
      if (fsErrorCode(error) !== 'ENOENT') return null;
      const parent = p.dirname(current);
      if (parent === current) return null;
      current = parent;
    }
  }
}

/** The repository-relative paths of `batch` git ignores in `worktree` (`check-ignore`, literal). */
async function ignoredIn(ctx: GitContext, worktree: string, batch: readonly string[]): Promise<string[]> {
  const result = await ctx.runner.run(
    call(ctx, worktree, 'status', 'read', [
      '-c',
      'core.quotePath=false',
      // No `--literal-pathspecs`: check-ignore refuses it; it takes its arguments as plain names anyway.
      'check-ignore',
      '--',
      ...batch,
    ]),
  );
  // 0 = some are ignored, 1 = none; a name git had to quote (control characters, `"`) is never copied.
  if (result.exitCode !== 0) return [];
  const asked = new Set(batch);
  return result.stdout
    .split('\n')
    .map((line) => line.replace(/\r$/, ''))
    .filter((rel) => asked.has(rel));
}

/**
 * `.worktreeinclude` (convention of Claude Code, `.gitignore` syntax) in the main worktree: every
 * untracked file matching it that git IGNORES in the new worktree (SR2: its checkout decides – a file
 * it would show as new is never copied in) is copied there (e.g. `.env`). Regular files only, never
 * over an existing file, never out of either root (SR2: the real folders of source and target are
 * checked right before each copy, a link in between skips the file), never from
 * `.claude/worktrees/`; at most WORKTREE_INCLUDE_LIMITS. No file → nothing.
 */
export async function copyWorktreeInclude(
  ctx: GitContext,
  repoRoot: string,
  worktreePath: string,
): Promise<IncludeResult> {
  const p = pathModuleOf(ctx.rules);
  const includeFile = p.join(repoRoot, '.worktreeinclude');
  const none: IncludeResult = { copied: 0, skipped: 0, limited: false };
  try {
    if (!(await lstat(includeFile)).isFile()) return none;
  } catch {
    return none;
  }
  const listed = await ctx.runner.ok(
    call(
      ctx,
      repoRoot,
      'status',
      'read',
      ['ls-files', '--others', '--ignored', `--exclude-from=${includeFile}`, '-z'],
      {
        timeoutMs: GIT_LONG_TIMEOUT_MS,
      },
    ),
  );
  const own = `${WORKTREES_DIR.join('/')}/`;
  const candidates = splitNul(listed.stdout).filter(
    (rel) => rel !== '' && !rel.endsWith('/') && !rel.startsWith(own),
  );
  // SR2: a file whose folder in the new worktree is reached through a link is never asked about (git
  // would refuse the whole batch) and never copied.
  const plainFolders = new Map<string, Promise<boolean>>();
  const reachable: string[] = [];
  for (const rel of candidates.slice(0, WORKTREE_INCLUDE_LIMITS.files * 4)) {
    const folder = rel.split('/').slice(0, -1);
    const key = folder.join('/');
    let plain = plainFolders.get(key);
    if (plain === undefined) {
      plain = plainFolderChain(worktreePath, folder, ctx.rules);
      plainFolders.set(key, plain);
    }
    if (await plain) reachable.push(rel);
  }
  const ignored: string[] = [];
  for (const batch of batches(reachable)) {
    ignored.push(...(await ignoredIn(ctx, worktreePath, batch)));
  }
  const out: IncludeResult = {
    copied: 0,
    skipped: candidates.length - ignored.length,
    limited: candidates.length > WORKTREE_INCLUDE_LIMITS.files * 4,
  };
  const realRepo = await physicalAncestor(repoRoot, ctx.rules);
  const realWorktree = await physicalAncestor(worktreePath, ctx.rules);
  if (realRepo === null || realWorktree === null) return { ...out, skipped: candidates.length };
  /** `folder` (or, while it does not exist yet, its deepest existing ancestor) really lies in `root`. */
  const inside = async (folder: string, root: string): Promise<boolean> => {
    const real = await physicalAncestor(folder, ctx.rules);
    return real !== null && ctx.rules.isInside(real, root);
  };
  let bytes = 0;
  for (const rel of ignored) {
    if (out.copied >= WORKTREE_INCLUDE_LIMITS.files) {
      out.limited = true;
      break;
    }
    const source = absoluteIn(repoRoot, rel, ctx.rules);
    const target = absoluteIn(worktreePath, rel, ctx.rules);
    if (source === null || target === null) {
      out.skipped += 1;
      continue;
    }
    try {
      const info = await lstat(source);
      if (!info.isFile() || !(await inside(p.dirname(source), realRepo))) {
        out.skipped += 1;
        continue;
      }
      if (bytes + info.size > WORKTREE_INCLUDE_LIMITS.bytes) {
        out.limited = true;
        break;
      }
      const folder = p.dirname(target);
      // Checked before the folders are made (a link must not get folders made through it) and after.
      if (!(await inside(folder, realWorktree))) {
        out.skipped += 1;
        continue;
      }
      await mkdir(folder, { recursive: true });
      if (!(await inside(folder, realWorktree))) {
        out.skipped += 1;
        continue;
      }
      await copyFile(source, target, constants.COPYFILE_EXCL);
      bytes += info.size;
      out.copied += 1;
    } catch (error) {
      out.skipped += 1;
      logger.debug({ code: fsErrorCode(error) }, 'worktree include file not copied');
    }
  }
  return out;
}
