/**
 * Installer entry point (WP-86, docs/wp/WP-83.md §8.3): bundled to `dist/install.js`
 * (scripts/build-server.ts). A package starts it with `install.cmd` (Linux `sh install.sh`) or
 * `node dist/install.js`, an installation through `start.mjs --install | --uninstall | --use`. The
 * flow lives in cli.ts (exit codes: 0 = done, 2 = bad option, else 1).
 */
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { logger } from '../lib/logger';
import { runInstallerCli } from './cli';
import { createNodeInstallerDeps } from './nodeDeps';

// dist/install.js → `..` = the package or version folder.
const installerScript = fileURLToPath(import.meta.url);
const ownDir = path.resolve(path.dirname(installerScript), '..');

// lib/* modules log through the pino singleton; the console belongs to the installer's messages.
logger.level = 'error';
process.exitCode = await runInstallerCli(
  process.argv.slice(2),
  createNodeInstallerDeps({
    ownDir,
    installerScript,
    out: (line) => {
      process.stdout.write(`${line}\n`);
    },
    fail: (line) => {
      process.stderr.write(`${line}\n`);
    },
  }),
);
