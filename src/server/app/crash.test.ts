import { EventEmitter } from 'node:events';
import { describe, expect, it } from 'vitest';
import type { ServerShutdown, ShutdownReason } from '../launcher/shutdown';
import { createLogger } from '../lib/logger';
import { installCrashHandlers, type CrashEventTarget } from './crash';

const log = createLogger({ level: 'silent' });

function fakeShutdown(): ServerShutdown & { calls: { reason: ShutdownReason; code: number | undefined }[] } {
  const calls: { reason: ShutdownReason; code: number | undefined }[] = [];
  return {
    calls,
    get stopping() {
      return calls.length > 0;
    },
    stop(reason, exitCode) {
      calls.push({ reason, code: exitCode });
      return new Promise<void>(() => undefined);
    },
    installSignalHandlers: () => () => undefined,
  };
}

function setup(shutdown: ServerShutdown | null) {
  const target: CrashEventTarget & EventEmitter = new EventEmitter();
  const exits: number[] = [];
  let logClosed = 0;
  const uninstall = installCrashHandlers({
    log,
    shutdown: () => shutdown,
    exit: (code) => exits.push(code),
    closeLog: () => {
      logClosed += 1;
      return Promise.resolve();
    },
    target,
  });
  return { target, exits, logClosed: () => logClosed, uninstall };
}

const flush = () => new Promise((resolve) => setImmediate(resolve));

describe('crash handlers (R3-06)', () => {
  it('an unhandled rejection shuts the running server down in order with exit code 1', () => {
    const shutdown = fakeShutdown();
    const { target, exits } = setup(shutdown);
    target.emit('unhandledRejection', new Error('late orphan result'));
    expect(shutdown.calls).toEqual([{ reason: 'error', code: 1 }]);
    expect(exits).toEqual([]);
  });

  it('a second error during the error shutdown exits at once', async () => {
    const shutdown = fakeShutdown();
    const { target, exits, logClosed } = setup(shutdown);
    target.emit('uncaughtException', new Error('first'));
    target.emit('uncaughtException', new Error('second'));
    await flush();
    expect(shutdown.calls).toHaveLength(1);
    expect(exits).toEqual([1]);
    expect(logClosed()).toBe(1);
  });

  it('an error during a regular shutdown (command, signal) is only logged', async () => {
    const shutdown = fakeShutdown();
    void shutdown.stop('command');
    const { target, exits } = setup(shutdown);
    target.emit('unhandledRejection', new Error('during stop'));
    await flush();
    expect(shutdown.calls).toHaveLength(1);
    expect(exits).toEqual([]);
  });

  it('in the start phase (no shutdown frame yet) the log is closed and the process exits with 1', async () => {
    const { target, exits, logClosed, uninstall } = setup(null);
    target.emit('unhandledRejection', 'not an Error');
    target.emit('unhandledRejection', 'again');
    await flush();
    expect(exits).toEqual([1]);
    expect(logClosed()).toBe(1);
    uninstall();
    expect(target.listenerCount('unhandledRejection')).toBe(0);
    expect(target.listenerCount('uncaughtException')).toBe(0);
  });
});
