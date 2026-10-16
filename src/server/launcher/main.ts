/**
 * Launcher entry point, run by tsx from the repo root:
 * `node node_modules/tsx/dist/cli.mjs --tsconfig src/server/tsconfig.json src/server/launcher/main.ts`
 * (`parallax.cmd`, `parallax.ps1`, the autostart shortcut with `--autostart` and the protocol
 * handler with `--open "%1"`, ADR-109/110). Not part of the server bundle. The flow and the exit
 * codes live in cli.ts (0 = done, 2 = bad option or link, 3 = data of a newer Parallax, else 1).
 */
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { logger } from '../lib/logger';
import { SERVER_BUNDLE } from './build';
import { runLauncherCli } from './cli';
import { createNodeLauncherDeps, runLauncher } from './launcher';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..');

function out(line: string): void {
  process.stdout.write(`${line}\n`);
}

function fail(line: string): void {
  process.stderr.write(`${line}\n`);
}

// lib/* modules log through the pino singleton; the console belongs to the launcher's messages.
logger.level = 'error';
process.exitCode = await runLauncherCli(process.argv.slice(2), {
  env: process.env,
  out,
  fail,
  launch: (options) =>
    runLauncher(
      options,
      createNodeLauncherDeps({
        repoRoot,
        home: options.home,
        serverScript: path.join(repoRoot, SERVER_BUNDLE),
        out,
      }),
    ),
});
// Nothing may keep the launcher alive (server and Edge are detached and unref'd).
setTimeout(() => {
  process.exit();
}, 2_000).unref();
