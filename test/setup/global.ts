import { rmSync } from 'node:fs';
import { ensureTestEnv } from './home';

/**
 * Vitest globalSetup: runs once in the main process before the workers start, so the workers
 * inherit PARALLAX_HOME / PARALLAX_PORT. Always a FRESH temp home – an inherited PARALLAX_HOME
 * (real data directory, a running server's home, WP22-07) is never used. Removed afterwards.
 */
export default function setup(): () => void {
  const created = ensureTestEnv(process.env, { fresh: true });
  return () => {
    if (created !== undefined) {
      rmSync(created, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    }
  };
}
