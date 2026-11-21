/**
 * Test helper (WP-111): real git repositories in temp folders below the test home (`test/setup` gives
 * every run its own `PARALLAX_HOME`). The environment isolates git from the machine: no global or system
 * configuration (`GIT_CONFIG_GLOBAL` = an empty file, `GIT_CONFIG_NOSYSTEM`), a fixed author, so a
 * signing or hook setting of the developer never applies. Never used by production code.
 */
import { mkdir, realpath, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { makeTempHome } from '../http/testServer';
import { HOST_PATH_RULES } from '../lib/paths';
import type { GitContext } from './repo';
import { createGitRunner, type GitRunner } from './runner';

export interface TestRepo {
  /** Root of the repository (real path, host spelling). */
  root: string;
  env: Record<string, string>;
  runner: GitRunner;
  ctx: GitContext;
  /** Runs git (write mode) in `cwd` (default the root); throws on an exit code ≠ 0. */
  git(args: readonly string[], cwd?: string): Promise<string>;
  /** Writes a file below the root (`/`-separated relative path). */
  write(relative: string, text: string | Uint8Array): Promise<string>;
  /** `git add -A && git commit -m <message>`; returns the new HEAD. */
  commitAll(message: string): Promise<string>;
}

let isolated: Promise<Record<string, string>> | null = null;

/** The isolated base environment (created once per test file). */
export function gitTestEnv(): Promise<Record<string, string>> {
  isolated ??= (async () => {
    const dir = await makeTempHome('gitcfg-');
    const config = path.join(dir, 'gitconfig');
    await writeFile(config, '', 'utf8');
    const env: Record<string, string> = {};
    for (const [name, value] of Object.entries(process.env)) if (value !== undefined) env[name] = value;
    return {
      ...env,
      GIT_CONFIG_GLOBAL: config,
      GIT_CONFIG_NOSYSTEM: '1',
      GIT_AUTHOR_NAME: 'Test Author',
      GIT_AUTHOR_EMAIL: 'author@test.example',
      GIT_COMMITTER_NAME: 'Test Author',
      GIT_COMMITTER_EMAIL: 'author@test.example',
    };
  })();
  return isolated;
}

/** A new repository (branch `main`) with one commit of `README.md` unless `empty`. */
export async function createTestRepo(options: { empty?: boolean; bare?: boolean } = {}): Promise<TestRepo> {
  const env = await gitTestEnv();
  const root = await realpath(await makeTempHome('repo-'));
  const runner = createGitRunner();
  const git = async (args: readonly string[], cwd = root): Promise<string> =>
    (await runner.ok({ cwd, env, args, op: 'status', mode: 'write' })).stdout;
  await git(['init', '-q', ...(options.bare === true ? ['--bare'] : []), '-b', 'main']);
  const write = async (relative: string, text: string | Uint8Array): Promise<string> => {
    const file = path.join(root, ...relative.split('/'));
    await mkdir(path.dirname(file), { recursive: true });
    await writeFile(file, text);
    return file;
  };
  const commitAll = async (message: string): Promise<string> => {
    await git(['add', '-A']);
    await git(['commit', '-q', '-m', message]);
    return (await git(['rev-parse', 'HEAD'])).trim();
  };
  const repo: TestRepo = {
    root,
    env,
    runner,
    ctx: { runner, env, rules: HOST_PATH_RULES },
    git,
    write,
    commitAll,
  };
  if (options.empty !== true && options.bare !== true) {
    await write('README.md', 'hello\n');
    await commitAll('initial');
  }
  return repo;
}
