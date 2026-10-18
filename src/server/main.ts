/**
 * Server entry point (bundled to dist/server.js; `pnpm dev` runs it with tsx watch).
 *
 * Flags (config.ts): `--dev`, `--backend=fake|sdk`, `--port=<0..65535>`, `--host=127.0.0.1`,
 * `--home=<dir>`, `--log-level=<level>`; env `PARALLAX_HOME`, `PARALLAX_PORT`, `PARALLAX_BACKEND`,
 * `PARALLAX_DEV`, `PARALLAX_LOG_LEVEL`. Without `--backend`: dev → fake, otherwise sdk.
 *
 * Order: config → home lock (R2-05, before anything touches the home) → logging → `startServer()`
 * (app/compose.ts: single instance, stores, engine, hub, app, shutdown frame, listen, lock file,
 * access check of the home). Exit codes (launcher/exitCodes.ts): 0 regular shutdown, 1 failure
 * (also invalid options), 3 data of a newer Parallax, 4 port in use, 5 already running for this
 * PARALLAX_HOME. The reason of a failed start is the LAST line on stderr (the launcher shows it
 * from logs/server.out.log), so nothing is written after it. Unexpected errors (unhandled
 * rejection, uncaught exception) are logged and end the server in order with 1 (app/crash.ts,
 * R3-06).
 */
import path from 'node:path';
import { isatty } from 'node:tty';
import { fileURLToPath } from 'node:url';
import { StartupError, startServer, type RunningServer } from './app/compose';
import { installCrashHandlers } from './app/crash';
import { ConfigError, loadConfig, type ServerConfig } from './config';
import { SERVER_EXIT_CODES } from './launcher/exitCodes';
import type { ServerShutdown } from './launcher/shutdown';
import { settleWithin } from './lib/async';
import { acquireHomeLock, type HomeLock } from './lib/homeLock';
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

  // R2-05: the exclusive lock of the data directory BEFORE the log (it lives in the home) and the
  // first store – a second server on this home (double click, another --port, dev:live) never
  // opens a file. Busy → 5: the launcher then finds the winner and opens a window there.
  let homeLock: HomeLock;
  try {
    const acquired = await acquireHomeLock(config.home);
    if (acquired.kind === 'busy') {
      exitWith(
        SERVER_EXIT_CODES.alreadyRunning,
        acquired.reason === 'access_denied'
          ? `The lock of ${config.home} (${acquired.pipe}) belongs to another Windows user - another ` +
              'user runs Parallax with this data folder.'
          : `Another Parallax server already uses ${config.home}.`,
      );
      return;
    }
    homeLock = acquired.lock;
  } catch (error) {
    exitWith(
      SERVER_EXIT_CODES.failure,
      `The data folder ${config.home} cannot be locked: ${describe(error)}`,
    );
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

  // Hints of loadConfig, e.g. an ignored settings.json (port from the defaults, WP-33).
  for (const note of config.notes) logger.warn(note);

  // R3-06: from here on an unexpected error ends the server in order (exit 1), never silently.
  // CR-10: already during the start – from the shutdown frame on (step 5, before listen and the
  // lock file). Before it (no lock file yet) the crash handler only closes the log and exits.
  let running: RunningServer | null = null;
  let frame: ServerShutdown | null = null;
  const openLog = logging;
  installCrashHandlers({
    log: logger,
    shutdown: () => running?.shutdown ?? frame,
    closeLog: async () => {
      await settleWithin(() => openLog.close(), 2_000);
    },
    exit: (code) => process.exit(code),
  });

  // In the bundle this file is dist/server.js and the built UI dist/web; dev mode uses Vite.
  const here = path.dirname(fileURLToPath(import.meta.url));
  const webRoot = config.dev ? null : path.join(here, 'web');
  // The checkout (system integration: launcher command, ADR-110): dist/server.js → `..`,
  // src/server/main.ts under tsx (dev, tests) → `../..`.
  const repoRoot = path.resolve(here, path.basename(here) === 'dist' ? '..' : path.join('..', '..'));

  try {
    running = await startServer({
      config,
      webRoot,
      repoRoot,
      logging,
      homeLock,
      onShutdownFrame: (shutdown) => {
        frame = shutdown;
      },
    });
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
