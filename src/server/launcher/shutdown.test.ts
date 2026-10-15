import { EventEmitter } from 'node:events';
import pino from 'pino';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ProcessInfo } from '../lib/process';
import {
  FORCED_EXIT_CODE,
  createServerShutdown,
  killChildProcessTrees,
  type ServerShutdownOptions,
  type SignalTarget,
} from './shutdown';

const silent = pino({ level: 'silent' });

function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve: () => void = () => undefined;
  const promise = new Promise<void>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

describe('server shutdown frame (C.8, R0-19)', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  function setup(over: Partial<ServerShutdownOptions> = {}) {
    const events: string[] = [];
    const exits: number[] = [];
    const shutdown = createServerShutdown({
      logger: silent,
      exit: (code) => {
        events.push(`exit ${String(code)}`);
        exits.push(code);
      },
      forceKill: () => {
        events.push('force-kill');
        return Promise.resolve();
      },
      steps: [
        { name: 'http', run: () => void events.push('http') },
        {
          name: 'stores',
          run: async () => {
            await Promise.resolve();
            events.push('stores');
          },
        },
        { name: 'lock', run: () => void events.push('lock') },
      ],
      ...over,
    });
    return { shutdown, events, exits };
  }

  it('stops the sessions, then the steps in order, then exits with 0', async () => {
    const { shutdown, events } = setup({
      stopSessions: () => {
        events.push('sessions');
        return Promise.resolve();
      },
    });
    expect(shutdown.stopping).toBe(false);
    const done = shutdown.stop('command');
    expect(shutdown.stopping).toBe(true);
    await vi.runAllTimersAsync();
    await done;
    expect(events).toEqual(['sessions', 'http', 'stores', 'lock', 'exit 0']);
  });

  it('is idempotent: a second stop returns the same run', async () => {
    const { shutdown, exits } = setup({ stopSessions: () => Promise.resolve() });
    const first = shutdown.stop('command');
    const second = shutdown.stop('signal', 9);
    expect(second).toBe(first);
    await vi.runAllTimersAsync();
    await first;
    expect(exits).toEqual([0]);
  });

  it('force-kills the remaining process trees when close() takes longer than the grace period', async () => {
    const closing = deferred();
    const { shutdown, events } = setup({
      graceMs: 5_000,
      stopSessions: async () => {
        events.push('sessions:start');
        await closing.promise;
        events.push('sessions:end');
      },
    });
    const done = shutdown.stop('command');
    await vi.advanceTimersByTimeAsync(4_999);
    expect(events).toEqual(['sessions:start']);
    await vi.advanceTimersByTimeAsync(1);
    expect(events).toEqual(['sessions:start', 'force-kill']);
    // After the kill the queries end (process exit) and the shutdown continues.
    closing.resolve();
    await vi.runAllTimersAsync();
    await done;
    expect(events).toEqual([
      'sessions:start',
      'force-kill',
      'sessions:end',
      'http',
      'stores',
      'lock',
      'exit 0',
    ]);
  });

  it('does not force-kill when the sessions close in time', async () => {
    const { shutdown, events } = setup({
      stopSessions: async () => {
        await new Promise<void>((resolve) => setTimeout(resolve, 1_000));
      },
    });
    const done = shutdown.stop('command');
    await vi.runAllTimersAsync();
    await done;
    expect(events).not.toContain('force-kill');
  });

  it('bounds hanging sessions and steps and still exits', async () => {
    const { shutdown, events, exits } = setup({
      graceMs: 100,
      sessionsTimeoutMs: 1_000,
      stepTimeoutMs: 50,
      stopSessions: () => new Promise<void>(() => undefined),
      steps: [
        { name: 'hangs', run: () => new Promise<void>(() => undefined) },
        {
          name: 'throws',
          run: () => {
            throw new Error('boom');
          },
        },
        { name: 'rejects', run: () => Promise.reject(new Error('nope')) },
        { name: 'last', run: () => void events.push('last') },
      ],
    });
    const done = shutdown.stop('error', 1);
    await vi.runAllTimersAsync();
    await done;
    expect(events).toEqual(['force-kill', 'last', 'exit 1']);
    expect(exits).toEqual([1]);
  });

  it('works without an engine hook (no force kill)', async () => {
    const { shutdown, events } = setup();
    const done = shutdown.stop('signal');
    await vi.runAllTimersAsync();
    await done;
    expect(events).toEqual(['http', 'stores', 'lock', 'exit 0']);
  });

  it('signals: the first stops gracefully, a second one exits at once; uninstall removes the handlers', async () => {
    const emitter = new EventEmitter();
    const target: SignalTarget = {
      on: (event, listener) => emitter.on(event, listener),
      off: (event, listener) => emitter.off(event, listener),
    };
    const closing = deferred();
    const { shutdown, events, exits } = setup({ stopSessions: () => closing.promise });
    const uninstall = shutdown.installSignalHandlers(target);
    for (const signal of ['SIGINT', 'SIGTERM', 'SIGBREAK', 'SIGHUP'])
      expect(emitter.listenerCount(signal)).toBe(1);
    emitter.emit('SIGTERM');
    expect(shutdown.stopping).toBe(true);
    emitter.emit('SIGINT');
    expect(exits).toEqual([FORCED_EXIT_CODE]);
    closing.resolve();
    await vi.runAllTimersAsync();
    expect(events.at(-1)).toBe('exit 0');
    uninstall();
    expect(emitter.listenerCount('SIGINT')).toBe(0);
  });
});

describe('killChildProcessTrees (taskkill /T /F of the remaining children)', () => {
  const child = (pid: number, name: string, startedAt: string): ProcessInfo => ({
    pid,
    name,
    parentPid: 100,
    startedAt: new Date(startedAt),
  });

  it('ends every direct child tree started after the server, except the own CIM query', async () => {
    const killed: number[] = [];
    const count = await killChildProcessTrees({
      parentPid: 100,
      since: new Date('2026-10-15T08:00:00.000Z'),
      list: (pid) => {
        expect(pid).toBe(100);
        return Promise.resolve([
          child(201, 'claude.exe', '2026-10-15T08:05:00.000Z'),
          child(202, 'powershell.exe', '2026-10-15T08:30:00.000Z'),
          child(203, 'claude.exe', '2026-10-14T23:00:00.000Z'),
          child(204, 'node.exe', '2026-10-15T08:10:00.000Z'),
        ]);
      },
      kill: (pid) => {
        killed.push(pid);
        return pid === 204 ? Promise.reject(new Error('access denied')) : Promise.resolve();
      },
      logger: silent,
    });
    expect(killed).toEqual([201, 204]);
    expect(count).toBe(1);
  });
});
