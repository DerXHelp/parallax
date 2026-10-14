import { mkdtempSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/**
 * Makes sure tests never touch the real data directory (%LOCALAPPDATA%\Parallax):
 * PARALLAX_HOME defaults to a fresh temp directory and PARALLAX_PORT to 0.
 * Returns the directory it created, or undefined when PARALLAX_HOME was already set.
 */
export function ensureTestEnv(env: NodeJS.ProcessEnv = process.env): string | undefined {
  let created: string | undefined;

  const home = env.PARALLAX_HOME;
  if (home === undefined || home === '') {
    created = mkdtempSync(path.join(os.tmpdir(), 'parallax-test-'));
    env.PARALLAX_HOME = created;
  }

  const port = env.PARALLAX_PORT;
  if (port === undefined || port === '') {
    env.PARALLAX_PORT = '0';
  }

  assertNotRealHome(env.PARALLAX_HOME ?? '', env);
  return created;
}

/** Throws when PARALLAX_HOME points to the productive data directory. */
export function assertNotRealHome(home: string, env: NodeJS.ProcessEnv = process.env): void {
  const localAppData = env.LOCALAPPDATA;
  if (localAppData === undefined || localAppData === '') return;
  const real = path.resolve(localAppData, 'Parallax').toLowerCase();
  if (path.resolve(home).toLowerCase() === real) {
    throw new Error(`Tests must not use the real data directory ${real}. Set PARALLAX_HOME to a temp dir.`);
  }
}
