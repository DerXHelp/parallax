/**
 * Launcher entry point. In a checkout it runs with tsx from the repo root:
 * `node node_modules/tsx/dist/cli.mjs --tsconfig src/server/tsconfig.json src/server/launcher/main.ts`
 * (`parallax.cmd`, `parallax.ps1`, the autostart shortcut with `--autostart` and the protocol
 * handler with `--open "%1"`, ADR-109/110). In a release package it is bundled to `dist/launcher.js`
 * (WP-85, `scripts/build-launcher.ts`) and `release.json` next to `dist/` switches on package mode.
 * Not part of the server bundle. The flow and the exit codes live in cli.ts (0 = done, 2 = bad
 * option or link, 3 = data of a newer Parallax, else 1).
 *
 * WP-87b: with `--apply-update` this process is the orchestrator of a version switch
 * (applyUpdate.ts), started by the server with stdout as a pipe that carries only the handshake –
 * the server closes it right after. So in that mode nothing else is written to stdout (the pino
 * singleton is silenced) and a failing write to the closed pipe never crashes the process.
 */
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { logger } from '../lib/logger';
import { createNodeApplyUpdateDeps, runApplyUpdate } from './applyUpdate';
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

/** One line to stdout; false when it could not be delivered (the reader closed the pipe). */
function handshake(line: string): Promise<boolean> {
  return new Promise((resolve) => {
    try {
      process.stdout.write(`${line}\n`, (error) => {
        resolve(error === undefined || error === null);
      });
    } catch {
      resolve(false);
    }
  });
}

/** Orchestrator mode: stdout is the handshake pipe only (see the file comment). */
function quietForHandshake(): void {
  logger.level = 'silent';
  const ignore = (): void => undefined;
  process.stdout.on('error', ignore);
  process.stderr.on('error', ignore);
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
    applyUpdate: (request) => {
      quietForHandshake();
      return runApplyUpdate(
        request,
        createNodeApplyUpdateDeps({ own: { release, dir: repoRoot }, home: request.home, handshake }),
      );
    },
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
