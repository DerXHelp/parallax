/**
 * Build id sent in `hello.buildId` (server) and compared by the client (A.2: a new build id
 * triggers a client reload, so no old code keeps running after `git pull`).
 *
 * `pnpm build` injects the same value into the web bundle (vite.config.ts `define`) and the
 * server bundle (scripts/build-server.ts `define`), computed by `resolveBuildId()` in
 * repo.config.ts. Unbundled runs (Vite dev server, tsx, Vitest) have no define → 'dev'.
 */

/** Replaced at build time; undefined when the code runs unbundled. */
declare const __PARALLAX_BUILD_ID__: string | undefined;

export const DEV_BUILD_ID = 'dev';

export const BUILD_ID: string =
  typeof __PARALLAX_BUILD_ID__ === 'string' && __PARALLAX_BUILD_ID__ !== ''
    ? __PARALLAX_BUILD_ID__
    : DEV_BUILD_ID;
