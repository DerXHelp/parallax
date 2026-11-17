import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { describe, expect, it, vi } from 'vitest';
import { nextMacrotask } from '../lib/async';
import { logger } from '../lib/logger';
import { handOver, type OrchestratorChild } from './apply';
import { APPLY_READY_LINE, APPLY_TIMEOUTS, orchestratorCommand, type OrchestratorCommand } from './handoff';

class FakeChild extends EventEmitter implements OrchestratorChild {
  readonly stdout = new PassThrough();
  readonly unref = vi.fn();
  pid: number | undefined = 4242;
}

const log = logger.child({ test: 'apply' });
const COMMAND: OrchestratorCommand = orchestratorCommand(
  {
    version: '1.0.1',
    restore: false,
    waitPid: 100,
    installRoot: 'C:\\Programs\\Parallax',
    serverArgs: ['--port=4711'],
  },
  'C:\\Programs\\Parallax\\versions\\1.0.0',
  'C:\\Program Files\\nodejs\\node.exe',
);

function setup(child: FakeChild, timeoutMs = 1000) {
  const spawned: OrchestratorCommand[] = [];
  const killed: number[] = [];
  const deps = {
    spawn: (command: OrchestratorCommand) => {
      spawned.push(command);
      return child;
    },
    kill: (pid: number) => {
      killed.push(pid);
      return Promise.resolve();
    },
    log,
    timeoutMs,
  };
  return { spawned, killed, deps };
}

describe('handOver', () => {
  it('READY: closes the pipe, unrefs the child and reports its pid', async () => {
    const child = new FakeChild();
    const { spawned, killed, deps } = setup(child);
    const pending = handOver(COMMAND, deps);
    child.stdout.write('\r\nPARALLAX-APP');
    child.stdout.write('LY-READY\r\n');
    expect(await pending).toEqual({ kind: 'ready', pid: 4242 });
    expect(spawned).toEqual([COMMAND]);
    expect(child.unref).toHaveBeenCalledOnce();
    expect(child.stdout.destroyed).toBe(true);
    expect(killed).toEqual([]);
  });

  it('FAILED <reason>: the reason, nothing killed', async () => {
    const child = new FakeChild();
    const { killed, deps } = setup(child);
    const pending = handOver(COMMAND, deps);
    child.stdout.write('PARALLAX-APPLY-FAILED lock\n');
    expect(await pending).toEqual({ kind: 'failed', reason: 'lock' });
    expect(child.unref).not.toHaveBeenCalled();
    expect(killed).toEqual([]);
  });

  it('a FAILED line right before the end still counts; the end alone is a handshake failure', async () => {
    const child = new FakeChild();
    const pending = handOver(COMMAND, setup(child).deps);
    child.stdout.write('PARALLAX-APPLY-FAILED package');
    await nextMacrotask(); // a real child emits `close` only after its stdout ended
    child.emit('close', 1, null);
    expect(await pending).toEqual({ kind: 'failed', reason: 'package' });

    const silent = new FakeChild();
    const quiet = handOver(COMMAND, setup(silent).deps);
    silent.emit('close', 1, null);
    expect(await quiet).toEqual({ kind: 'failed', reason: 'handshake' });

    const dead = new FakeChild();
    const late = handOver(COMMAND, setup(dead).deps);
    dead.stdout.write(APPLY_READY_LINE);
    await nextMacrotask();
    dead.emit('close', 0, null);
    expect(await late).toEqual({ kind: 'failed', reason: 'handshake' });
  });

  it('silence: kills the orchestrator before answering', async () => {
    const child = new FakeChild();
    const { killed, deps } = setup(child, 20);
    expect(await handOver(COMMAND, deps)).toEqual({ kind: 'failed', reason: 'handshake' });
    expect(killed).toEqual([4242]);
  });

  it('waits exactly handshakeMs for the line, then kills; a later READY changes nothing', async () => {
    vi.useFakeTimers();
    try {
      const child = new FakeChild();
      const { killed, deps } = setup(child, APPLY_TIMEOUTS.handshakeMs);
      const pending = handOver(COMMAND, deps);
      child.stdout.write('PARALLAX-APPLY-');
      await vi.advanceTimersByTimeAsync(APPLY_TIMEOUTS.handshakeMs - 1);
      expect(killed).toEqual([]);
      await vi.advanceTimersByTimeAsync(1);
      expect(await pending).toEqual({ kind: 'failed', reason: 'handshake' });
      expect(killed).toEqual([4242]);
      expect(child.stdout.destroyed).toBe(true);
      expect(child.unref).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });

  it('an unreadable line: kills the orchestrator at once (stdout carries only the handshake)', async () => {
    for (const output of [
      'PARALLAX-APPLY-MAYBE\n',
      'PARALLAX-APPLY-FAILED\n',
      'node: warning\nPARALLAX-APPLY-READY\n',
    ]) {
      const child = new FakeChild();
      const { killed, deps } = setup(child, 60_000);
      const pending = handOver(COMMAND, deps);
      child.stdout.write(output);
      expect(await pending).toEqual({ kind: 'failed', reason: 'handshake' });
      expect(killed).toEqual([4242]);
      expect(child.unref).not.toHaveBeenCalled();
    }
    const flood = new FakeChild();
    const { killed, deps } = setup(flood, 60_000);
    const pending = handOver(COMMAND, deps);
    flood.stdout.write('x'.repeat(70 * 1024));
    expect(await pending).toEqual({ kind: 'failed', reason: 'handshake' });
    expect(killed).toEqual([4242]);
  });

  it('spawn failures: a throw, a child without pid, an error event', async () => {
    const throwing = {
      ...setup(new FakeChild()).deps,
      spawn: () => {
        throw new TypeError('spawn: only .exe files are started');
      },
    };
    expect(await handOver(COMMAND, throwing)).toEqual({ kind: 'failed', reason: 'spawn' });

    const noPid = new FakeChild();
    noPid.pid = undefined;
    expect(await handOver(COMMAND, setup(noPid).deps)).toEqual({ kind: 'failed', reason: 'spawn' });
    expect(() => noPid.emit('error', new Error('ENOENT'))).not.toThrow();

    const erroring = new FakeChild();
    const pending = handOver(COMMAND, setup(erroring).deps);
    erroring.emit('error', new Error('EACCES'));
    expect(await pending).toEqual({ kind: 'failed', reason: 'spawn' });
  });
});
