import { rmSync } from 'node:fs';
import { ensureTestEnv } from './home';

/**
 * Vitest globalSetup: runs once in the main process before the workers start,
 * so the workers inherit PARALLAX_HOME / PARALLAX_PORT. Removes the temp home afterwards.
 */
export default function setup(): () => void {
  const created = ensureTestEnv();
  return () => {
    if (created !== undefined) {
      rmSync(created, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    }
  };
}
