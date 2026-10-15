/**
 * Default dev port of the Vite dev server (ADR-006). Kept free of imports on purpose: the root
 * configs (repo.config.ts → vite.config.ts) load it through Vite's native config loader, which
 * warns about every extensionless relative import of an imported module. `@shared/http` re-exports
 * it (allowed Origin/Host with `--dev`).
 */

/** Vite dev server (proxies /api to the dev server on 4712); the server's `--dev` origin. */
export const DEV_WEB_PORT = 5173;
