/**
 * Installer entry point (WP-86, docs/wp/WP-83.md §8.3): bundled to `dist/install.js`
 * (scripts/build-server.ts). A package starts it with `install.cmd` (Linux `sh install.sh`) or
 * `node dist/install.js`, an installation through `start.mjs --install | --uninstall | --use`. The
 * flow lives in cli.ts (exit codes: 0 = done, 2 = bad option, else 1).
 */
import { readFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { systemdUnitPath, uninstallService } from '../launcher/systemdService';
import { logger } from '../lib/logger';
import { runInstallerCli } from './cli';
import { START_SCRIPT } from './layout';
import { createNodeInstallerDeps } from './nodeDeps';

// dist/install.js → `..` = the package or version folder.
const installerScript = fileURLToPath(import.meta.url);
const ownDir = path.resolve(path.dirname(installerScript), '..');

/**
 * WP-109 (WP-107 `parallax service install`): `--uninstall` on Linux also removes the systemd user
 * service – only when its unit starts THIS installation (`<root>/start.mjs`; the uninstaller runs
 * from `<root>/versions/<v>`), never the service of another installation or a checkout. Null = done
 * or nothing to do, else the problem for the uninstaller's report.
 */
async function removeOwnService(): Promise<string | null> {
  if (process.platform !== 'linux') return null;
  let unit: string;
  try {
    unit = await readFile(systemdUnitPath(process.env, os.homedir()), 'utf8');
  } catch {
    return null;
  }
  const startScript = path.join(path.resolve(ownDir, '..', '..'), START_SCRIPT);
  if (!unit.includes(startScript)) return null;
  const lines: string[] = [];
  const code = await uninstallService({
    platform: process.platform,
    env: process.env,
    out: (line) => {
      lines.push(line);
    },
  });
  return code === 0 ? null : lines.join('; ') || `exit ${String(code)}`;
}

// lib/* modules log through the pino singleton; the console belongs to the installer's messages.
logger.level = 'error';
process.exitCode = await runInstallerCli(
  process.argv.slice(2),
  createNodeInstallerDeps({
    ownDir,
    installerScript,
    removeService: removeOwnService,
    out: (line) => {
      process.stdout.write(`${line}\n`);
    },
    fail: (line) => {
      process.stderr.write(`${line}\n`);
    },
  }),
);
