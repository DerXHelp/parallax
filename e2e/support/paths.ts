import path from 'node:path';
import { fileURLToPath } from 'node:url';

/** Root of this checkout (e2e/support → ../..). */
export const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
/** The bundled server started by the E2E tests (built by global-setup.ts). */
export const SERVER_BUNDLE = path.join(REPO_ROOT, 'dist', 'server.js');
