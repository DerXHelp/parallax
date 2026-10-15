/**
 * Launcher entry point, run by tsx from the repo root:
 * `node node_modules/tsx/dist/cli.mjs --tsconfig src/server/tsconfig.json src/server/launcher/main.ts`
 * (`parallax.cmd`, `parallax.ps1`; `pnpm start` once package.json points here). Not part of the
 * server bundle. Exit code 0 = window opened, 3 = data of a newer Parallax, 2 = bad option, else 1.
 */
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { serverOrigin } from '@shared/http';
import { ConfigError, loadConfig, type ServerConfig } from '../config';
import { logger } from '../lib/logger';
import { LAUNCHER_USAGE, parseLauncherArgs, serverArgsFor } from './args';
import { SERVER_BUNDLE } from './build';
import { LauncherError, createNodeLauncherDeps, runLauncher } from './launcher';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..');

function out(line: string): void {
  process.stdout.write(`${line}\n`);
}

function fail(line: string): void {
  process.stderr.write(`${line}\n`);
}

async function main(argv: readonly string[]): Promise<number> {
  const args = parseLauncherArgs(argv);
  if (args.help) {
    out(LAUNCHER_USAGE);
    return 0;
  }
  // lib/* modules log through the pino singleton; the console belongs to the launcher's messages.
  logger.level = 'error';
  let config: ServerConfig;
  try {
    config = loadConfig({ argv: args.serverArgv });
  } catch (error) {
    if (!(error instanceof ConfigError)) throw error;
    fail(`Invalid option: ${error.message}\n\n${LAUNCHER_USAGE}`);
    return 2;
  }
  if (config.dev) {
    fail('--dev is for "pnpm dev" (Vite + dev server); the launcher starts the built app.');
    return 2;
  }
  const deps = createNodeLauncherDeps({
    repoRoot,
    home: config.home,
    serverScript: path.join(repoRoot, SERVER_BUNDLE),
    out,
  });
  try {
    const result = await runLauncher(
      {
        home: config.home,
        port: config.port,
        serverArgs: serverArgsFor(config),
        build: args.build,
        printUrl: args.printUrl,
      },
      deps,
    );
    const origin = serverOrigin(result.port);
    out(
      result.mode === 'started'
        ? `Parallax runs on ${origin} (PID ${String(result.pid)}, data: ${config.home}).`
        : `Parallax already runs on ${origin} - ${args.printUrl ? 'new sign-in code above' : 'opened another window'}.`,
    );
    return 0;
  } catch (error) {
    if (error instanceof LauncherError) {
      fail(error.message);
      return error.exitCode;
    }
    fail(
      `Unexpected launcher error: ${error instanceof Error ? (error.stack ?? error.message) : String(error)}`,
    );
    return 1;
  }
}

process.exitCode = await main(process.argv.slice(2));
// Nothing may keep the launcher alive (server and Edge are detached and unref'd).
setTimeout(() => {
  process.exit();
}, 2_000).unref();
