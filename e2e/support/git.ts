/**
 * WP-117 (Ausbau 1): real git repositories for the E2E tests – in the temp folder of the test's
 * server (`E2eServer.makeProject`, removed with it), never in the checkout or a user folder.
 *
 * - The test's own git calls run like the server's: the absolute `git` from PATH (`resolveExecutable`,
 *   never the bare name), an argument array, no shell; isolated from the machine (no global or
 *   system configuration, a fixed author with a `*.example` address, no inherited `GIT_*`).
 * - The server runs git with its own environment (the developer's global configuration applies), so
 *   every repository carries local settings that win over it: author, no signing, an empty hooks
 *   folder (`core.hooksPath`), no line-ending conversion.
 * - `serverSummaries` reads the session list the server sends a fresh node client (`cwd`, `worktree`
 *   of a session – values the UI only shows shortened).
 */
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import type { SessionSummary } from '@shared/model';
import { runFile } from '../../src/server/lib/process';
import { resolveExecutable } from '../../src/server/lib/windows';
import { connectNodeClient, type E2eServer } from './server';

const GIT_TIMEOUT_MS = 30_000;
export const TEST_AUTHOR = { name: 'E2E Author', email: 'author@e2e.example' };

/** The absolute path of `git` on this machine's PATH, or null (the caller skips its test). */
export function findGit(): Promise<string | null> {
  return resolveExecutable('git', process.env);
}

export interface TestGit {
  /** Runs git in `cwd`; throws with git's message on an exit code ≠ 0. Returns stdout. */
  run(cwd: string, args: readonly string[]): Promise<string>;
}

/** The test's git: isolated environment (empty global config file next to the repositories). */
export async function testGit(gitPath: string, scratch: string): Promise<TestGit> {
  const globalConfig = path.join(scratch, 'e2e-gitconfig');
  await writeFile(globalConfig, '', 'utf8');
  const env: Record<string, string> = {};
  for (const [name, value] of Object.entries(process.env)) {
    if (value !== undefined && !name.toUpperCase().startsWith('GIT_')) env[name] = value;
  }
  Object.assign(env, {
    GIT_CONFIG_GLOBAL: globalConfig,
    GIT_CONFIG_NOSYSTEM: '1',
    GIT_TERMINAL_PROMPT: '0',
    GIT_AUTHOR_NAME: TEST_AUTHOR.name,
    GIT_AUTHOR_EMAIL: TEST_AUTHOR.email,
    GIT_COMMITTER_NAME: TEST_AUTHOR.name,
    GIT_COMMITTER_EMAIL: TEST_AUTHOR.email,
  });
  return {
    async run(cwd, args) {
      const result = await runFile(gitPath, args, { cwd, env, timeoutMs: GIT_TIMEOUT_MS });
      if (result.exitCode !== 0) {
        throw new Error(`git ${args.join(' ')} failed (${String(result.exitCode)}): ${result.stderr}`);
      }
      return result.stdout;
    },
  };
}

/**
 * A repository with branch `main` in `dir` (created if missing): local settings that win over the
 * developer's global ones, then `files` (relative `/` paths, LF endings) in one first commit.
 */
export async function initRepo(git: TestGit, dir: string, files: Record<string, string>): Promise<void> {
  await mkdir(dir, { recursive: true });
  await git.run(dir, ['init', '-q', '-b', 'main']);
  const hooks = path.join(dir, '.git', 'e2e-no-hooks');
  await mkdir(hooks, { recursive: true });
  for (const [key, value] of [
    ['user.name', TEST_AUTHOR.name],
    ['user.email', TEST_AUTHOR.email],
    ['commit.gpgsign', 'false'],
    ['tag.gpgsign', 'false'],
    ['core.hooksPath', hooks],
    ['core.autocrlf', 'false'],
  ] as const) {
    await git.run(dir, ['config', '--local', key, value]);
  }
  await writeFiles(dir, files);
  await git.run(dir, ['add', '-A']);
  await git.run(dir, ['commit', '-q', '-m', 'Initial commit']);
}

/** Writes `files` (relative `/` paths) below `dir`. */
export async function writeFiles(dir: string, files: Record<string, string>): Promise<void> {
  for (const [relative, text] of Object.entries(files)) {
    const file = path.join(dir, ...relative.split('/'));
    await mkdir(path.dirname(file), { recursive: true });
    await writeFile(file, text, 'utf8');
  }
}

/** A bare repository at `remoteDir` as `origin` of `repo`, `main` pushed with upstream. */
export async function addBareRemote(git: TestGit, repo: string, remoteDir: string): Promise<void> {
  await mkdir(remoteDir, { recursive: true });
  await git.run(remoteDir, ['init', '-q', '--bare', '-b', 'main']);
  await git.run(repo, ['remote', 'add', 'origin', remoteDir]);
  await git.run(repo, ['push', '-q', '-u', 'origin', 'main']);
}

/** The session summaries the server sends a fresh node client (its handshake snapshot). */
export async function serverSummaries(server: E2eServer): Promise<SessionSummary[]> {
  const client = await connectNodeClient(server);
  try {
    const snapshot = client.messages.find((message) => message.type === 'summaries.snapshot');
    if (snapshot?.type !== 'summaries.snapshot') throw new Error('no summaries.snapshot in the handshake');
    return snapshot.summaries;
  } finally {
    client.socket.terminate();
  }
}
