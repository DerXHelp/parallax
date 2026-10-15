/**
 * Server entry point (bundled to dist/server.js; `pnpm dev` runs it with tsx watch).
 *
 * Flags (config.ts): `--dev`, `--backend=fake|sdk`, `--port=<0..65535>`, `--host=127.0.0.1`,
 * `--home=<dir>`, `--log-level=<level>`; env `PARALLAX_HOME`, `PARALLAX_PORT`, `PARALLAX_BACKEND`,
 * `PARALLAX_DEV`, `PARALLAX_LOG_LEVEL`. Without `--backend`: dev → fake, otherwise sdk.
 *
 * Order: config → logging → `startServer()` (app/compose.ts: single instance, stores, engine, hub,
 * app, shutdown frame, listen, lock file). Exit codes (launcher/exitCodes.ts): 0 regular shutdown,
 * 1 failure (also invalid options), 3 data of a newer Parallax, 4 port in use, 5 already running
 * for this PARALLAX_HOME. The reason of a failed start is the LAST line on stderr (the launcher
 * shows it from logs/server.out.log), so nothing is written after it.
 */
import path from 'node:path';
import { isatty } from 'node:tty';
import { fileURLToPath } from 'node:url';
import { StartupError, startServer } from './app/compose';
import { ConfigError, loadConfig, type ServerConfig } from './config';
import { SERVER_EXIT_CODES } from './launcher/exitCodes';
import { initLogging, logger, type LoggingHandle } from './lib/logger';

/** Writes the line to stderr, then exits (stderr to a pipe may be asynchronous on Windows). */
function exitWith(code: number, line: string): void {
  process.exitCode = code;
  process.stderr.write(`${line}\n`, () => {
    process.exit(code);
  });
}

function describe(error: unknown): string {
  return error instanceof Error ? (error.stack ?? error.message) : String(error);
}

async function main(): Promise<void> {
  let config: ServerConfig;
  try {
    config = loadConfig();
  } catch (error) {
    if (!(error instanceof ConfigError)) throw error;
    exitWith(SERVER_EXIT_CODES.failure, `Invalid option: ${error.message}`);
    return;
  }

  // Started by the launcher, stdout goes to logs/server.out.log: the pino file log is enough there
  // (WP-21). Dev (concurrently, no TTY) keeps the pretty console.
  const stdoutIsTty = isatty(1);
  let logging: LoggingHandle;
  try {
    logging = await initLogging({
      home: config.home,
      dev: config.dev,
      level: config.logLevel,
      console: config.dev || stdoutIsTty,
    });
  } catch (error) {
    exitWith(SERVER_EXIT_CODES.failure, `The log in ${config.home} could not be opened: ${describe(error)}`);
    return;
  }

  // In the bundle this file is dist/server.js and the built UI dist/web; dev mode uses Vite.
  const webRoot = config.dev ? null : path.join(path.dirname(fileURLToPath(import.meta.url)), 'web');

  try {
    await startServer({ config, webRoot, logging });
  } catch (error) {
    const exitCode = error instanceof StartupError ? error.exitCode : SERVER_EXIT_CODES.failure;
    const message =
      error instanceof StartupError
        ? error.message
        : `Unexpected error at the server start: ${describe(error)}`;
    const cause = error instanceof StartupError && error.cause !== undefined ? error.cause : error;
    logger.error({ err: cause, exitCode }, message);
    await logging.close();
    exitWith(exitCode, message);
  }
}

await main();
