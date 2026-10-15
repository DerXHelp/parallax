/**
 * Last line of defence of the server process (R3-06, ADR-064): an unhandled rejection or uncaught
 * exception would otherwise end Node with a stack trace in `server.out.log` only – no line in the
 * pino log, no WS close 4503 for the windows, sessions cut hard (orphans), lock file left behind.
 *
 * Here it is logged as `fatal` and the server shuts down in order with exit code 1
 * (`shutdown.stop('error', 1)`). Before the shutdown frame exists (start phase) the log is closed
 * and the process exits with 1. A second error during the error shutdown exits at once (the
 * process state is no longer trustworthy); an error while a regular shutdown (command, signal) is
 * already running is only logged – that shutdown finishes.
 */
import type { Logger } from 'pino';
import type { ServerShutdown } from '../launcher/shutdown';
import { SERVER_EXIT_CODES } from '../launcher/exitCodes';

export type CrashKind = 'unhandledRejection' | 'uncaughtException';

/** Something that emits the two process events (`process`). */
export interface CrashEventTarget {
  on(event: CrashKind, listener: (error: unknown) => void): unknown;
  off(event: CrashKind, listener: (error: unknown) => void): unknown;
}

export interface CrashHandlerOptions {
  log: Logger;
  /** The running server's shutdown frame; null during the start phase. */
  shutdown: () => ServerShutdown | null;
  /** Immediate exit (start phase after the log was closed, second error). */
  exit: (code: number) => void;
  /** Closes the log file before an immediate exit (bounded by the caller). */
  closeLog?: () => Promise<void>;
  /** Default `process`. */
  target?: CrashEventTarget;
}

/** Installs the handlers; returns the uninstall function. */
export function installCrashHandlers(options: CrashHandlerOptions): () => void {
  const target: CrashEventTarget = options.target ?? process;
  let errorShutdown = false;
  let exiting = false;

  const exitNow = (): void => {
    if (exiting) return;
    exiting = true;
    const close = options.closeLog ?? (() => Promise.resolve());
    void close()
      .catch(() => undefined)
      .finally(() => {
        options.exit(SERVER_EXIT_CODES.failure);
      });
  };

  const handle =
    (kind: CrashKind) =>
    (error: unknown): void => {
      options.log.fatal({ err: error, kind }, 'unexpected error - shutting the server down');
      const shutdown = options.shutdown();
      if (shutdown === null) {
        exitNow();
        return;
      }
      if (!shutdown.stopping) {
        errorShutdown = true;
        void shutdown.stop('error', SERVER_EXIT_CODES.failure);
        return;
      }
      if (errorShutdown) {
        options.log.fatal('second unexpected error during the error shutdown - exiting now');
        exitNow();
      }
      // A regular shutdown is running: it ends the process.
    };

  const onRejection = handle('unhandledRejection');
  const onException = handle('uncaughtException');
  target.on('unhandledRejection', onRejection);
  target.on('uncaughtException', onException);
  return () => {
    target.off('unhandledRejection', onRejection);
    target.off('uncaughtException', onException);
  };
}
