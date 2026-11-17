/**
 * Launcher entry point. In a checkout it runs with tsx from the repo root:
 * `node node_modules/tsx/dist/cli.mjs --tsconfig src/server/tsconfig.json src/server/launcher/main.ts`
 * (`parallax.cmd`, `parallax.ps1`, the autostart shortcut with `--autostart` and the protocol
 * handler with `--open "%1"`, ADR-109/110). In a release package it is bundled to `dist/launcher.js`
 * (WP-85, `scripts/build-launcher.ts`) and `release.json` next to `dist/` switches on package mode.
 * Not part of the server bundle. The flow and the exit codes live in cli.ts (0 = done, 2 = bad
 * option or link, 3 = data of a newer Parallax, else 1).
 */
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { logger } from '../lib/logger';
import { SERVER_BUNDLE } from './build';
import { runLauncherCli } from './cli';
import { createNodeLauncherDeps, runLauncher } from './launcher';
import { readReleaseInfo, ReleaseInfoError } from './release';

// Like the server (main.ts): dist/launcher.js → `..`, src/server/launcher/main.ts → `../../..`.
const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, path.basename(here) === 'dist' ? '..' : path.join('..', '..', '..'));

function out(line: string): void {
  process.stdout.write(`${line}\n`);
}

function fail(line: string): void {
  process.stderr.write(`${line}\n`);
}

// lib/* modules log through the pino singleton; the console belongs to the launcher's messages.
logger.level = 'error';
try {
  const release = await readReleaseInfo(repoRoot);
  process.exitCode = await runLauncherCli(process.argv.slice(2), {
    env: process.env,
    out,
    fail,
    launch: (options) =>
      runLauncher(
        options,
        createNodeLauncherDeps({
          repoRoot,
          release,
          workDir: options.installRoot ?? null,
          home: options.home,
          serverScript: path.join(repoRoot, SERVER_BUNDLE),
          out,
        }),
      ),
  });
} catch (error) {
  if (!(error instanceof ReleaseInfoError)) throw error;
  fail(`This Parallax installation is damaged: ${error.message}. Install Parallax again.`);
  process.exitCode = 1;
}
// Nothing may keep the launcher alive (server and Chrome are detached and unref'd).
setTimeout(() => {
  process.exit();
}, 2_000).unref();
