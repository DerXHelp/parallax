import type { SpawnOptions } from '@anthropic-ai/claude-agent-sdk';
import { ChildProcess } from 'node:child_process';
import { PassThrough } from 'node:stream';
import { describe, expect, it, vi } from 'vitest';
import { spawnHidden, type SpawnHiddenOptions } from '../lib/process';
import { createSpawner, definedEnv, type SpawnerOptions } from './spawn';

const EXE = 'C:\\Users\\u\\.local\\bin\\claude.exe';
const STARTED = new Date('2026-10-15T08:00:00.000Z');

/** A ChildProcess that never ran: pipes are PassThroughs, exit/error are emitted by the test. */
class FakeChild extends ChildProcess {
  override stdin = new PassThrough();
  override stdout = new PassThrough();
  override stderr = new PassThrough();
  override pid: number | undefined;
  override exitCode: number | null = null;
  override signalCode: NodeJS.Signals | null = null;
  override killed = false;

  constructor(pid: number | undefined) {
    super();
    this.pid = pid;
  }

  override kill(): boolean {
    this.killed = true;
    return true;
  }

  finish(code: number | null, signal: NodeJS.Signals | null = null): void {
    this.exitCode = code;
    this.signalCode = signal;
    this.emit('exit', code, signal);
  }
}

interface Calls {
  file: string;
  args: readonly string[];
  options: SpawnHiddenOptions;
}

function setup(
  p: { pid?: number | undefined; throws?: Error; expectedCommand?: string; kill?: () => Promise<void> } = {},
) {
  const child = new FakeChild('pid' in p ? p.pid : 4711);
  const calls: Calls[] = [];
  const spawn = vi.fn(
    (file: string, args: readonly string[], options: SpawnHiddenOptions = {}): ChildProcess => {
      calls.push({ file, args, options });
      if (p.throws !== undefined) throw p.throws;
      // Like spawnHidden: stderr is always consumed and handed to onStderr.
      child.stderr.setEncoding('utf8');
      child.stderr.on('data', (text: string) => options.onStderr?.(text));
      return child;
    },
  );
  const killProcessTree = vi.fn(p.kill ?? (() => Promise.resolve()));
  const events: string[] = [];
  const onSpawned = vi.fn((pid: number, at: Date) => events.push(`spawned ${pid} ${at.toISOString()}`));
  const onError = vi.fn((error: Error) => events.push(`error ${error.name}: ${error.message}`));
  const opts: SpawnerOptions = {
    spawn,
    killProcessTree,
    now: () => STARTED,
    ...(p.expectedCommand === undefined ? {} : { expectedCommand: p.expectedCommand }),
    onSpawned,
    onStderr: (text: string) => events.push(`stderr ${text}`),
    onExit: (code: number | null, signal: string | null) => events.push(`exit ${code} ${signal}`),
    onError,
  };
  const abort = new AbortController();
  const spawnOptions: SpawnOptions = {
    command: EXE,
    args: ['--output-format', 'stream-json'],
    cwd: 'c:\\Work\\Repo',
    env: { PATH: 'C:\\Windows', DROPPED: undefined, CLAUDE_CODE_ENTRYPOINT: 'sdk-ts' },
    signal: abort.signal,
  };
  return {
    child,
    calls,
    spawn,
    killProcessTree,
    events,
    onSpawned,
    onError,
    abort,
    spawnOptions,
    spawner: createSpawner(opts),
  };
}

describe('definedEnv', () => {
  it('drops undefined values and keeps everything else unchanged', () => {
    expect(definedEnv({ A: '1', B: undefined, c: '' })).toEqual({ A: '1', c: '' });
  });
});

describe('createSpawner', () => {
  it('spawns through spawnHidden with an argument array, piped stdio and without the signal', () => {
    const s = setup();
    const result = s.spawner(s.spawnOptions);
    expect(result).toBe(s.child);
    expect(s.calls).toHaveLength(1);
    const call = s.calls[0];
    expect(call?.file).toBe(EXE);
    expect(call?.args).toEqual(['--output-format', 'stream-json']);
    expect(call?.options.cwd).toBe('c:\\Work\\Repo');
    expect(call?.options.env).toEqual({ PATH: 'C:\\Windows', CLAUDE_CODE_ENTRYPOINT: 'sdk-ts' });
    expect(call?.options.stdio).toEqual(['pipe', 'pipe', 'pipe']);
    expect(typeof call?.options.onStderr).toBe('function');
    // Never Node's own abort handling (TerminateProcess would leave the children running).
    expect(call?.options).not.toHaveProperty('signal');
    expect(call?.options).not.toHaveProperty('shell');
  });

  it('reports PID + start time synchronously, then stderr and exit', () => {
    const s = setup();
    s.spawner(s.spawnOptions);
    expect(s.events).toEqual(['spawned 4711 2026-10-15T08:00:00.000Z']);
    s.child.stderr.write('warning: something\n');
    s.child.finish(0);
    s.child.finish(0); // a second exit is ignored (once)
    expect(s.events).toEqual([
      'spawned 4711 2026-10-15T08:00:00.000Z',
      'stderr warning: something\n',
      'exit 0 null',
    ]);
  });

  it('kills the whole tree when the forwarded signal aborts', () => {
    const s = setup();
    s.spawner(s.spawnOptions);
    s.abort.abort();
    expect(s.killProcessTree).toHaveBeenCalledExactlyOnceWith(4711);
  });

  it('kills at once when the signal is already aborted', () => {
    const s = setup();
    s.abort.abort();
    s.spawner(s.spawnOptions);
    expect(s.killProcessTree).toHaveBeenCalledExactlyOnceWith(4711);
  });

  it('does not kill after the process exited', () => {
    const s = setup();
    s.spawner(s.spawnOptions);
    s.child.finish(1, null);
    s.abort.abort();
    expect(s.killProcessTree).not.toHaveBeenCalled();
  });

  it('logs a failing taskkill instead of throwing', async () => {
    const s = setup({ kill: () => Promise.reject(new Error('access denied')) });
    s.spawner(s.spawnOptions);
    s.abort.abort();
    await Promise.resolve();
    expect(s.killProcessTree).toHaveBeenCalledOnce();
  });

  it('reports a synchronous spawn failure and rethrows it to the SDK', () => {
    const failure = new TypeError('spawn: only .exe files are started');
    const s = setup({ throws: failure });
    expect(() => s.spawner(s.spawnOptions)).toThrow(failure);
    expect(s.events).toEqual(['error TypeError: spawn: only .exe files are started']);
    expect(s.onSpawned).not.toHaveBeenCalled();
  });

  it('reports an asynchronous spawn failure without PID (ENOENT) and never kills', () => {
    const s = setup({ pid: undefined });
    s.spawner(s.spawnOptions);
    const enoent = Object.assign(new Error('spawn C:\\x\\claude.exe ENOENT'), { code: 'ENOENT' });
    s.child.emit('error', enoent);
    s.abort.abort();
    expect(s.events).toEqual(['error Error: spawn C:\\x\\claude.exe ENOENT']);
    expect(s.killProcessTree).not.toHaveBeenCalled();
  });

  it('refuses a command other than the resolved executable (case-insensitive compare)', () => {
    const s = setup({ expectedCommand: 'c:\\users\\U\\.local\\bin\\CLAUDE.EXE' });
    expect(s.spawner(s.spawnOptions)).toBe(s.child);

    const other = setup({ expectedCommand: EXE });
    expect(() =>
      other.spawner({ ...other.spawnOptions, command: 'C:\\Program Files\\nodejs\\node.exe' }),
    ).toThrow(TypeError);
    expect(other.spawn).not.toHaveBeenCalled();
    expect(other.onError).toHaveBeenCalledOnce();
  });

  it.each(['claude', 'claude.cmd', 'bin\\claude.exe'])(
    'with the real spawnHidden a non-absolute or non-.exe command (%s) is refused before any spawn',
    (command) => {
      const onError = vi.fn();
      const spawner = createSpawner({
        spawn: spawnHidden,
        killProcessTree: () => Promise.resolve(),
        now: () => STARTED,
        onSpawned: vi.fn(),
        onStderr: vi.fn(),
        onExit: vi.fn(),
        onError,
      });
      const abort = new AbortController();
      expect(() => spawner({ command, args: [], env: {}, signal: abort.signal })).toThrow(TypeError);
      expect(onError).toHaveBeenCalledOnce();
    },
  );
});
