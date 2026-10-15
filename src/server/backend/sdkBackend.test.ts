import type { CanUseTool, Options, SDKUserMessage } from '@anthropic-ai/claude-agent-sdk';
import { ChildProcess } from 'node:child_process';
import path from 'node:path';
import { PassThrough } from 'node:stream';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { SAMPLE_IDS, sampleId, sampleUuid } from '@shared/samples';
import type { LaunchSpec } from '../claude/ports';
import type { spawnHidden, SpawnHiddenOptions } from '../lib/process';
import { fixturesDir, loadFixture } from './fixture';
import { createHistoryPool, type HistoryOp, type HistoryPool } from './history/pool';
import { AsyncQueue } from './lib/asyncQueue';
import { toPermissionRequest } from './permissionRequest';
import {
  createSdkBackend,
  PERMISSION_FAILURE_MESSAGE,
  SDK_TIMEOUTS,
  stillQueuedOf,
  toSdkUserMessage,
  type SdkQueryFn,
  type SdkQueryHandle,
  type SdkTimeouts,
} from './sdkBackend';
import type { AgentSession, BackendEvent, PermissionHandler, StartSessionRequest } from './types';

// No real SDK and no real process helpers in this file (WP-13 §5.3): a forgotten injection fails loudly.
const sdkQueryMock = vi.hoisted(() => vi.fn());
vi.mock('@anthropic-ai/claude-agent-sdk', () => ({ query: sdkQueryMock }));
vi.mock('../lib/process', () => ({
  spawnHidden: vi.fn(() => {
    throw new Error('real spawnHidden must not run in tests');
  }),
  killProcessTree: vi.fn(() => Promise.reject(new Error('real killProcessTree must not run in tests'))),
}));

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const EXE = 'C:\\Users\\u\\.local\\bin\\claude.exe';
const NOW = new Date('2026-10-15T08:00:00.000Z');
const PID = 4242;

// ---- fakes ----

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
    if (this.exitCode !== null || this.signalCode !== null) return;
    this.exitCode = code;
    this.signalCode = signal;
    this.emit('exit', code, signal);
  }
}

interface FakeQueryBehavior {
  /** What Query.close() does: 'exit' = the CLI ends (exit 0 + iterator end), 'hang' = nothing. */
  onClose?: 'exit' | 'hang';
  /** Throw synchronously from query() after spawning (like an SDK option error). */
  throws?: Error;
  /** Do not call spawnClaudeCodeProcess. */
  noSpawn?: boolean;
}

/** Fake `Query`: async iterator over pushed messages, control methods as mocks, reads the input. */
class FakeQuery implements SdkQueryHandle {
  readonly messages = new AsyncQueue<unknown>();
  readonly inputs: SDKUserMessage[] = [];
  inputEnded = false;
  closeCalls = 0;
  interrupt = vi.fn<SdkQueryHandle['interrupt']>(() => Promise.resolve({ still_queued: [] }));
  setModel = vi.fn<SdkQueryHandle['setModel']>(() => Promise.resolve());
  setPermissionMode = vi.fn<SdkQueryHandle['setPermissionMode']>(() => Promise.resolve());
  applyFlagSettings = vi.fn<SdkQueryHandle['applyFlagSettings']>(() => Promise.resolve());
  getContextUsage = vi.fn<SdkQueryHandle['getContextUsage']>(() => Promise.resolve({ totalTokens: 1 }));
  supportedModels = vi.fn<SdkQueryHandle['supportedModels']>(() => Promise.resolve([{ value: 'haiku' }]));
  supportedCommands = vi.fn<SdkQueryHandle['supportedCommands']>(() => Promise.resolve([{ name: 'clear' }]));
  stopTask = vi.fn<SdkQueryHandle['stopTask']>(() => Promise.resolve());

  constructor(
    readonly options: Options,
    prompt: AsyncIterable<SDKUserMessage>,
    readonly forwardedAbort: AbortController,
    private readonly behavior: FakeQueryBehavior,
    private readonly child: () => FakeChild | undefined,
  ) {
    void this.readInput(prompt);
  }

  private async readInput(prompt: AsyncIterable<SDKUserMessage>): Promise<void> {
    for await (const message of prompt) this.inputs.push(message);
    this.inputEnded = true;
  }

  [Symbol.asyncIterator](): AsyncIterator<unknown> {
    return this.messages[Symbol.asyncIterator]();
  }

  close(): void {
    this.closeCalls += 1;
    if (this.behavior.onClose === 'hang') return;
    queueMicrotask(() => {
      this.cliExit(0);
    });
  }

  push(...messages: unknown[]): void {
    for (const message of messages) this.messages.push(message);
  }

  /** The CLI ends: process exit, then the iterator ends. */
  cliExit(code: number | null, signal: NodeJS.Signals | null = null): void {
    this.child()?.finish(code, signal);
    if (!this.messages.ended) this.messages.end();
  }

  /** The CLI crashes: process exit, then the iterator throws like the SDK does. */
  crash(code: number): void {
    this.child()?.finish(code);
    if (!this.messages.ended) this.messages.end(new Error(`Claude Code process exited with code ${code}`));
  }
}

function fakeHistory(answer: (op: HistoryOp) => unknown = () => null): HistoryPool & {
  runs: { launch: LaunchSpec; op: HistoryOp }[];
  disposed: number;
} {
  const runs: { launch: LaunchSpec; op: HistoryOp }[] = [];
  const pool = {
    runs,
    disposed: 0,
    run(launch: LaunchSpec, op: HistoryOp): Promise<unknown> {
      runs.push({ launch, op });
      try {
        return Promise.resolve(answer(op));
      } catch (error) {
        return Promise.reject(error instanceof Error ? error : new Error(String(error)));
      }
    },
    dispose(): Promise<void> {
      pool.disposed += 1;
      return Promise.resolve();
    },
  };
  return pool;
}

function launch(p: Partial<LaunchSpec> = {}): LaunchSpec {
  return {
    profileId: SAMPLE_IDS.profile,
    executablePath: EXE,
    executableVersion: '2.1.300',
    env: { PATH: 'C:\\Windows\\System32', PARALLAX: '1', PARALLAX_ENTRY_ID: SAMPLE_IDS.entry },
    configDir: null,
    sdkOptions: {},
    extraArgs: {},
    allowDangerouslySkipPermissions: false,
    autoCompactWindow: null,
    contextWindow: null,
    ...p,
  };
}

const denyAll: PermissionHandler = () => Promise.resolve({ behavior: 'deny', message: 'no' });

function request(p: Partial<StartSessionRequest> = {}): StartSessionRequest {
  return {
    entryId: SAMPLE_IDS.entry,
    cwd: 'c:\\Work\\Repo',
    launch: launch(),
    resumeSessionId: null,
    model: null,
    permissionMode: null,
    effort: null,
    promptSuggestions: false,
    canUseTool: denyAll,
    ...p,
  };
}

interface HarnessOptions {
  behavior?: FakeQueryBehavior;
  spawnThrows?: Error;
  pid?: number | undefined;
  kill?: (pid: number) => Promise<void>;
  timeouts?: Partial<SdkTimeouts>;
  history?: HistoryPool;
  /** Adjust the fake query before start() continues (readiness, failing calls …). */
  configure?: (q: FakeQuery) => void;
}

const backends: { dispose(): Promise<void> }[] = [];

function harness(p: HarnessOptions = {}) {
  const children: FakeChild[] = [];
  const queries: FakeQuery[] = [];
  const spawn = vi.fn<typeof spawnHidden>(
    (_file: string, _args: readonly string[], options: SpawnHiddenOptions = {}): ChildProcess => {
      if (p.spawnThrows !== undefined) throw p.spawnThrows;
      const child = new FakeChild('pid' in p ? p.pid : PID + children.length);
      // Like spawnHidden: stderr is always consumed and handed to onStderr.
      child.stderr.setEncoding('utf8');
      child.stderr.on('data', (text: string) => options.onStderr?.(text));
      children.push(child);
      return child;
    },
  );
  const killProcessTree = vi.fn<(pid: number) => Promise<void>>(p.kill ?? (() => Promise.resolve()));
  const query = vi.fn<SdkQueryFn>(({ prompt, options }) => {
    const forwardedAbort = new AbortController();
    const index = queries.length;
    if (p.behavior?.noSpawn !== true) {
      // Like the SDK (non-deferred): the process is spawned synchronously inside query().
      options.spawnClaudeCodeProcess?.({
        command: options.pathToClaudeCodeExecutable ?? 'claude',
        args: ['--output-format', 'stream-json', '--verbose', '--input-format', 'stream-json'],
        cwd: options.cwd,
        env: options.env ?? {},
        signal: forwardedAbort.signal,
      });
    }
    if (p.behavior?.throws !== undefined) throw p.behavior.throws;
    const fake = new FakeQuery(options, prompt, forwardedAbort, p.behavior ?? {}, () => children[index]);
    p.configure?.(fake);
    queries.push(fake);
    return fake;
  });
  const history = p.history ?? fakeHistory();
  const backend = createSdkBackend({
    query,
    spawn,
    killProcessTree,
    history,
    now: () => NOW,
    ...(p.timeouts === undefined ? {} : { timeouts: p.timeouts }),
  });
  backends.push(backend);
  const fq = (index = 0): FakeQuery => {
    const found = queries[index];
    if (found === undefined) throw new Error(`no query #${index}`);
    return found;
  };
  const child = (index = 0): FakeChild => {
    const found = children[index];
    if (found === undefined) throw new Error(`no child #${index}`);
    return found;
  };
  return { backend, children, queries, spawn, killProcessTree, query, history, fq, child };
}

/** Consumes the events of a session as they arrive. */
function record(session: AgentSession) {
  const events: BackendEvent[] = [];
  const done = (async () => {
    for await (const event of session.events) events.push(event);
  })();
  return { events, done, types: () => events.map((event) => event.type) };
}

/** Lets microtasks and immediates run (setImmediate is never faked in this file). */
async function settle(rounds = 5): Promise<void> {
  for (let i = 0; i < rounds; i += 1) {
    await new Promise<void>((resolve) => {
      setImmediate(resolve);
    });
  }
}

function useFakeTimeouts(): void {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
}

afterEach(async () => {
  vi.useRealTimers();
  await Promise.all(backends.splice(0).map((backend) => backend.dispose()));
});

let fixtureMessages: unknown[] = [];
beforeAll(async () => {
  const parsed = await loadFixture(path.join(fixturesDir(REPO_ROOT), 'auth-probe.jsonl'));
  fixtureMessages = parsed.events.filter((event) => event.kind === 'message').map((event) => event.payload);
});

// ---- tests ----

describe('SdkBackend – start, events, close', () => {
  it('is the sdk backend with the default timeouts of the design', () => {
    expect(harness().backend.kind).toBe('sdk');
    expect(SDK_TIMEOUTS).toEqual({
      closeGraceMs: 5000,
      killWaitMs: 5000,
      controlMs: 15000,
      contextFullMs: 60000,
      readyMs: 60000,
      iteratorAfterExitMs: 2000,
    });
  });

  it('emits spawned first, every raw message in order and exit last (fixture auth-probe)', async () => {
    const h = harness();
    const session = h.backend.start(request());
    const rec = record(session);
    expect(session.entryId).toBe(SAMPLE_IDS.entry);
    expect(session.pid).toBe(PID);
    h.fq().push(...fixtureMessages);
    await settle();
    await session.close();
    await rec.done;

    expect(fixtureMessages.length).toBeGreaterThan(10);
    expect(rec.events[0]).toEqual({ type: 'spawned', pid: PID, at: NOW });
    const messages = rec.events.filter((event) => event.type === 'message');
    expect(messages.map((event) => event.message)).toEqual(fixtureMessages);
    expect(messages.every((event) => event.at === NOW)).toBe(true);
    expect(rec.events.at(-1)).toEqual({ type: 'exit', code: 0, signal: null, expected: true, at: NOW });
    expect(rec.types().filter((type) => type === 'exit')).toHaveLength(1);
    expect(h.killProcessTree).not.toHaveBeenCalled();
  });

  it('starts query() in streaming-input mode with the mapped options and the spawn wrapper', () => {
    const h = harness();
    const req = request({
      permissionMode: 'acceptEdits',
      resumeSessionId: SAMPLE_IDS.sessionId,
      model: 'haiku',
    });
    h.backend.start(req);
    const call = h.query.mock.calls[0]?.[0];
    expect(call?.prompt).toBeInstanceOf(AsyncQueue);
    const options = h.fq().options;
    expect(options).toMatchObject({
      cwd: 'c:\\Work\\Repo',
      pathToClaudeCodeExecutable: EXE,
      env: req.launch.env,
      settingSources: ['user', 'project', 'local'],
      systemPrompt: { type: 'preset', preset: 'claude_code' },
      includePartialMessages: true,
      thinking: { type: 'adaptive', display: 'summarized' },
      toolConfig: { askUserQuestion: { previewFormat: 'markdown' } },
      permissionMode: 'acceptEdits',
      resume: SAMPLE_IDS.sessionId,
      model: 'haiku',
      promptSuggestions: false,
    });
    expect(options.canUseTool).not.toBe(req.canUseTool);
    expect(typeof options.spawnClaudeCodeProcess).toBe('function');
    // The real spawn options: argument array, env without undefined, pipes, no signal.
    const [file, args, spawnOptions] = h.spawn.mock.calls[0] ?? [];
    expect(file).toBe(EXE);
    expect(args).toEqual(['--output-format', 'stream-json', '--verbose', '--input-format', 'stream-json']);
    expect(spawnOptions).toMatchObject({
      cwd: 'c:\\Work\\Repo',
      env: req.launch.env,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    expect(spawnOptions).not.toHaveProperty('signal');
  });

  it('forwards stderr of the pipe as stderr events between the messages', async () => {
    const h = harness();
    const session = h.backend.start(request());
    const rec = record(session);
    h.fq().push({ type: 'system', subtype: 'init' });
    await settle();
    h.child().stderr.write('MCP server failed\n');
    await settle();
    h.fq().push({ type: 'result', subtype: 'success' });
    await settle();
    await session.close();
    await rec.done;
    expect(rec.types()).toEqual(['spawned', 'message', 'stderr', 'message', 'exit']);
    expect(rec.events[2]).toEqual({ type: 'stderr', data: 'MCP server failed\n', at: NOW });
  });

  it('close() ends the input, calls Query.close() once, resolves after exit and is idempotent', async () => {
    const h = harness();
    const session = h.backend.start(request());
    const rec = record(session);
    const first = session.close();
    const second = session.close();
    await Promise.all([first, second]);
    expect(rec.types().at(-1)).toBe('exit');
    expect(h.fq().closeCalls).toBe(1);
    await settle();
    expect(h.fq().inputEnded).toBe(true);
    await session.close();
    expect(h.fq().closeCalls).toBe(1);
    await rec.done;
  });

  it('close() kills the process tree after closeGraceMs and waits for the exit (C.8)', async () => {
    useFakeTimeouts();
    const h = harness({
      behavior: { onClose: 'hang' },
      kill: (pid) => {
        expect(pid).toBe(PID);
        h.fq().cliExit(1);
        return Promise.resolve();
      },
    });
    const session = h.backend.start(request());
    const rec = record(session);
    let closed = false;
    void session.close().then(() => {
      closed = true;
    });
    await vi.advanceTimersByTimeAsync(4_999);
    expect(h.killProcessTree).not.toHaveBeenCalled();
    expect(closed).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    expect(h.killProcessTree).toHaveBeenCalledExactlyOnceWith(PID);
    await vi.advanceTimersByTimeAsync(0);
    await settle();
    expect(closed).toBe(true);
    expect(rec.events.at(-1)).toEqual({ type: 'exit', code: 1, signal: null, expected: true, at: NOW });
    await rec.done;
  });

  it('close() synthesizes exit {code:null, signal:SIGKILL, expected:true} when even taskkill does not help', async () => {
    useFakeTimeouts();
    const h = harness({ behavior: { onClose: 'hang' } });
    const session = h.backend.start(request());
    const rec = record(session);
    let closed = false;
    void session.close().then(() => {
      closed = true;
    });
    await vi.advanceTimersByTimeAsync(5_000);
    expect(h.killProcessTree).toHaveBeenCalledOnce();
    await vi.advanceTimersByTimeAsync(4_999);
    expect(closed).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    await settle();
    expect(closed).toBe(true);
    expect(rec.events.at(-1)).toEqual({
      type: 'exit',
      code: null,
      signal: 'SIGKILL',
      expected: true,
      at: NOW,
    });
    await rec.done;
    // A late message and exit of the process change nothing any more.
    h.fq().push({ type: 'late' });
    h.fq().cliExit(0);
    await settle();
    expect(rec.types().filter((type) => type === 'exit')).toHaveLength(1);
  });

  it('a failing taskkill is logged and the exit is still synthesized', async () => {
    useFakeTimeouts();
    const h = harness({
      behavior: { onClose: 'hang' },
      kill: () => Promise.reject(new Error('access denied')),
    });
    const session = h.backend.start(request());
    const rec = record(session);
    const closing = session.close();
    await vi.advanceTimersByTimeAsync(10_000);
    await closing;
    await rec.done;
    expect(rec.events.at(-1)).toMatchObject({ type: 'exit', signal: 'SIGKILL', expected: true });
  });

  it('a hanging taskkill does not extend close() beyond closeGraceMs + killWaitMs', async () => {
    useFakeTimeouts();
    const h = harness({ behavior: { onClose: 'hang' }, kill: () => new Promise<void>(() => undefined) });
    const session = h.backend.start(request());
    const rec = record(session);
    let closed = false;
    void session.close().then(() => {
      closed = true;
    });
    await vi.advanceTimersByTimeAsync(9_999);
    expect(h.killProcessTree).toHaveBeenCalledOnce();
    expect(closed).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    await settle();
    expect(closed).toBe(true);
    await rec.done;
    expect(rec.events.at(-1)).toMatchObject({ type: 'exit', code: null, signal: 'SIGKILL', expected: true });
  });

  it('kills the tree when the SDK aborts the forwarded signal', () => {
    const h = harness();
    h.backend.start(request());
    h.fq().forwardedAbort.abort();
    expect(h.killProcessTree).toHaveBeenCalledExactlyOnceWith(PID);
  });

  it('honours custom timeouts', async () => {
    useFakeTimeouts();
    const h = harness({ behavior: { onClose: 'hang' }, timeouts: { closeGraceMs: 100, killWaitMs: 50 } });
    const session = h.backend.start(request());
    const rec = record(session);
    const closing = session.close();
    await vi.advanceTimersByTimeAsync(100);
    expect(h.killProcessTree).toHaveBeenCalledOnce();
    await vi.advanceTimersByTimeAsync(50);
    await closing;
    await rec.done;
    expect(rec.events.at(-1)).toMatchObject({ type: 'exit', signal: 'SIGKILL' });
  });
});

describe('SdkBackend – crash and iterator end', () => {
  it('process crash: error{iterator} and exit{code:1, expected:false} as the last two events', async () => {
    const h = harness();
    const session = h.backend.start(request());
    const rec = record(session);
    h.fq().push({ type: 'system', subtype: 'init' });
    await settle();
    h.fq().crash(1);
    await rec.done;
    expect(rec.types()).toEqual(['spawned', 'message', 'error', 'exit']);
    expect(rec.events[2]).toEqual({
      type: 'error',
      where: 'iterator',
      name: 'Error',
      message: 'Claude Code process exited with code 1',
      at: NOW,
    });
    expect(rec.events[3]).toEqual({ type: 'exit', code: 1, signal: null, expected: false, at: NOW });
    expect(() => {
      session.send({ uuid: sampleUuid(1), content: [{ type: 'text', text: 'hi' }], priority: 'next' });
    }).toThrow('session closed');
    await expect(session.interrupt()).rejects.toThrow('session closed');
  });

  it('exit waits at most iteratorAfterExitMs for the iterator end', async () => {
    useFakeTimeouts();
    const h = harness();
    const session = h.backend.start(request());
    const rec = record(session);
    h.child().finish(0, null);
    await vi.advanceTimersByTimeAsync(1_999);
    expect(rec.types()).toEqual(['spawned']);
    h.fq().push({ type: 'result', subtype: 'success' });
    await settle();
    expect(rec.types()).toEqual(['spawned', 'message']);
    await vi.advanceTimersByTimeAsync(1);
    await rec.done;
    expect(rec.events.at(-1)).toEqual({ type: 'exit', code: 0, signal: null, expected: false, at: NOW });
    // The iterator is released (Query.close()); nothing follows the exit.
    expect(h.fq().closeCalls).toBe(1);
    await settle();
    expect(rec.types()).toEqual(['spawned', 'message', 'exit']);
  });

  it('an iterator that ends while the CLI still runs closes the session (exit stays unexpected)', async () => {
    const h = harness();
    const session = h.backend.start(request());
    const rec = record(session);
    h.fq().messages.end();
    await rec.done;
    expect(h.fq().closeCalls).toBe(1);
    expect(rec.events.at(-1)).toEqual({ type: 'exit', code: 0, signal: null, expected: false, at: NOW });
  });

  it('iterator errors while closing are not reported as crashes', async () => {
    const h = harness({ behavior: { onClose: 'hang' } });
    const session = h.backend.start(request());
    const rec = record(session);
    const closing = session.close();
    h.fq().crash(1);
    await closing;
    await rec.done;
    expect(rec.types()).toEqual(['spawned', 'exit']);
    expect(rec.events.at(-1)).toMatchObject({ code: 1, expected: true });
  });
});

describe('SdkBackend – spawn failures', () => {
  it('a synchronous spawn failure → error{spawn} + exit{code:null, expected:false}, nothing else', async () => {
    const h = harness({ spawnThrows: new TypeError('spawn: only .exe files are started') });
    const session = h.backend.start(request());
    const rec = record(session);
    await rec.done;
    expect(rec.events).toEqual([
      {
        type: 'error',
        where: 'spawn',
        name: 'TypeError',
        message: 'spawn: only .exe files are started',
        at: NOW,
      },
      { type: 'exit', code: null, signal: null, expected: false, at: NOW },
    ]);
    expect(session.pid).toBeNull();
    expect(() => {
      session.send({ uuid: sampleUuid(1), content: [{ type: 'text', text: 'x' }], priority: 'next' });
    }).toThrow('session closed');
  });

  it('a synchronous query() error after the spawn kills the started process', async () => {
    const h = harness({
      behavior: { throws: new Error('Invalid pluginDelivery') },
      kill: () => {
        h.child().finish(null, 'SIGKILL');
        return Promise.resolve();
      },
      timeouts: { closeGraceMs: 10 },
    });
    const session = h.backend.start(request());
    const rec = record(session);
    await rec.done;
    expect(rec.types()).toEqual(['spawned', 'error', 'exit']);
    expect(rec.events[1]).toMatchObject({ where: 'spawn', message: 'Invalid pluginDelivery' });
    expect(h.killProcessTree).toHaveBeenCalledExactlyOnceWith(PID);
    expect(rec.events[2]).toMatchObject({ code: null, signal: 'SIGKILL', expected: false });
  });

  it('a query() error without spawn → error{spawn} + exit', async () => {
    const h = harness({ behavior: { noSpawn: true, throws: new Error('bad options') } });
    const rec = record(h.backend.start(request()));
    await rec.done;
    expect(rec.types()).toEqual(['error', 'exit']);
    expect(h.spawn).not.toHaveBeenCalled();
  });

  it('an asynchronous spawn failure (ENOENT, no PID) → one error{spawn} + exit, the iterator error is swallowed', async () => {
    const h = harness({ pid: undefined });
    const session = h.backend.start(request());
    const rec = record(session);
    expect(session.pid).toBeNull();
    h.child().emit('error', Object.assign(new Error('spawn C:\\x\\claude.exe ENOENT'), { code: 'ENOENT' }));
    h.fq().messages.end(new Error('Failed to spawn Claude Code process: spawn C:\\x\\claude.exe ENOENT'));
    await rec.done;
    expect(rec.events).toEqual([
      { type: 'error', where: 'spawn', name: 'Error', message: 'spawn C:\\x\\claude.exe ENOENT', at: NOW },
      { type: 'exit', code: null, signal: null, expected: false, at: NOW },
    ]);
    expect(h.killProcessTree).not.toHaveBeenCalled();
  });

  it('refuses an executable other than launch.executablePath', async () => {
    const h = harness();
    const fake = vi.fn<SdkQueryFn>(({ options }) => {
      options.spawnClaudeCodeProcess?.({
        command: 'C:\\Program Files\\nodejs\\node.exe',
        args: ['cli.js'],
        env: {},
        signal: new AbortController().signal,
      });
      throw new Error('unreachable');
    });
    const backend = createSdkBackend({
      query: fake,
      spawn: h.spawn,
      killProcessTree: h.killProcessTree,
      history: fakeHistory(),
      now: () => NOW,
    });
    backends.push(backend);
    const rec = record(backend.start(request()));
    await rec.done;
    expect(h.spawn).not.toHaveBeenCalled();
    expect(rec.events[0]).toMatchObject({ type: 'error', where: 'spawn', name: 'TypeError' });
    expect(rec.types()).toEqual(['error', 'exit']);
  });

  it('start after dispose fails like a spawn error', async () => {
    const h = harness();
    await h.backend.dispose();
    const rec = record(h.backend.start(request()));
    await rec.done;
    expect(rec.events[0]).toMatchObject({ type: 'error', where: 'spawn', message: 'backend disposed' });
    expect(h.query).not.toHaveBeenCalled();
  });
});

describe('SdkBackend – send', () => {
  it('sends exactly one text block as a plain string with uuid, priority, origin human (F.1)', async () => {
    const h = harness();
    const session = h.backend.start(request());
    session.send({ uuid: sampleUuid(7), content: [{ type: 'text', text: 'Hello' }], priority: 'now' });
    await settle();
    expect(h.fq().inputs).toEqual([
      {
        type: 'user',
        message: { role: 'user', content: 'Hello' },
        parent_tool_use_id: null,
        uuid: sampleUuid(7),
        priority: 'now',
        origin: { kind: 'human' },
      },
    ]);
  });

  it('sends several blocks with base64 image/document sources, buffered before the input is read', async () => {
    const h = harness();
    const session = h.backend.start(request());
    session.send({
      uuid: sampleUuid(8),
      priority: 'next',
      content: [
        { type: 'text', text: 'Look at this' },
        { type: 'image', mediaType: 'image/png', base64: 'iVBORw0KGgo=' },
        { type: 'document', mediaType: 'application/pdf', base64: 'JVBERi0=' },
      ],
    });
    session.send({
      uuid: sampleUuid(9),
      priority: 'next',
      content: [{ type: 'image', mediaType: 'image/webp', base64: 'UklG' }],
    });
    await settle();
    expect(h.fq().inputs.map((input) => input.message.content)).toEqual([
      [
        { type: 'text', text: 'Look at this' },
        { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'iVBORw0KGgo=' } },
        { type: 'document', source: { type: 'base64', media_type: 'application/pdf', data: 'JVBERi0=' } },
      ],
      [{ type: 'image', source: { type: 'base64', media_type: 'image/webp', data: 'UklG' } }],
    ]);
    expect(h.fq().inputs.map((input) => input.uuid)).toEqual([sampleUuid(8), sampleUuid(9)]);
  });

  it('rejects a prompt uuid that is not a UUID', () => {
    expect(() => toSdkUserMessage({ uuid: 'not-a-uuid', content: [], priority: 'next' })).toThrow(TypeError);
  });

  it('throws after close()', () => {
    const h = harness({ behavior: { onClose: 'hang' } });
    const session = h.backend.start(request());
    void session.close();
    expect(() => {
      session.send({ uuid: sampleUuid(1), content: [{ type: 'text', text: 'x' }], priority: 'next' });
    }).toThrow('session closed');
    h.fq().cliExit(0);
  });
});

describe('SdkBackend – control methods', () => {
  it.each<[string, unknown, string[]]>([
    ['receipt with still_queued', { still_queued: ['u1', 'u2'] }, ['u1', 'u2']],
    ['old CLI without receipt (F.10)', undefined, []],
    ['non-string entries dropped', { still_queued: ['u1', 3, null] }, ['u1']],
    ['garbage', 'yes', []],
  ])('interrupt: %s', async (_label, answer, stillQueued) => {
    const h = harness();
    const session = h.backend.start(request());
    h.fq().interrupt.mockResolvedValueOnce(answer);
    await expect(session.interrupt()).resolves.toEqual({ stillQueued });
    expect(h.fq().interrupt).toHaveBeenCalledOnce();
    expect(stillQueuedOf(answer)).toEqual(stillQueued);
  });

  it('passes the other control calls through', async () => {
    const h = harness();
    const session = h.backend.start(request());
    const q = h.fq();
    await session.setModel(null);
    await session.setModel('opus');
    expect(q.setModel.mock.calls).toEqual([[undefined], ['opus']]);
    await session.setPermissionMode('plan');
    expect(q.setPermissionMode).toHaveBeenCalledWith('plan');
    await session.applyFlagSettings({ effortLevel: null, fastMode: false });
    expect(q.applyFlagSettings).toHaveBeenCalledWith({ effortLevel: null, fastMode: false });
    q.getContextUsage.mockResolvedValueOnce({ raw: 'summary' }).mockResolvedValueOnce({ raw: 'full' });
    await expect(session.getContextUsage('summary')).resolves.toEqual({ raw: 'summary' });
    await expect(session.getContextUsage('full')).resolves.toEqual({ raw: 'full' });
    expect(q.getContextUsage.mock.calls).toEqual([[{ detail: 'summary' }], [{ detail: 'full' }]]);
    await expect(session.supportedModels()).resolves.toEqual([{ value: 'haiku' }]);
    await expect(session.supportedCommands()).resolves.toEqual([{ name: 'clear' }]);
    await session.stopTask('task-1');
    expect(q.stopTask).toHaveBeenCalledWith('task-1');
  });

  it('a rejected control call rejects with an Error', async () => {
    const h = harness();
    const session = h.backend.start(request());
    h.fq().setPermissionMode.mockRejectedValueOnce(new Error('Invalid mode'));
    await expect(session.setPermissionMode('auto')).rejects.toThrow('Invalid mode');
  });

  it.each<[string, (s: AgentSession) => Promise<unknown>, (q: FakeQuery) => void, number]>([
    [
      'interrupt',
      (s) => s.interrupt(),
      (q) => q.interrupt.mockReturnValue(new Promise(() => undefined)),
      15_000,
    ],
    [
      'setModel',
      (s) => s.setModel('x'),
      (q) => q.setModel.mockReturnValue(new Promise(() => undefined)),
      15_000,
    ],
    [
      'setPermissionMode',
      (s) => s.setPermissionMode('default'),
      (q) => q.setPermissionMode.mockReturnValue(new Promise(() => undefined)),
      15_000,
    ],
    [
      'applyFlagSettings',
      (s) => s.applyFlagSettings({ fastMode: null }),
      (q) => q.applyFlagSettings.mockReturnValue(new Promise(() => undefined)),
      15_000,
    ],
    [
      'stopTask',
      (s) => s.stopTask('t'),
      (q) => q.stopTask.mockReturnValue(new Promise(() => undefined)),
      15_000,
    ],
    [
      'supportedModels (readiness, R2-04)',
      (s) => s.supportedModels(),
      (q) => q.supportedModels.mockReturnValue(new Promise(() => undefined)),
      60_000,
    ],
    [
      'supportedCommands',
      (s) => s.supportedCommands(),
      (q) => q.supportedCommands.mockReturnValue(new Promise(() => undefined)),
      15_000,
    ],
    [
      'getContextUsage summary',
      (s) => s.getContextUsage('summary'),
      (q) => q.getContextUsage.mockReturnValue(new Promise(() => undefined)),
      15_000,
    ],
    [
      'getContextUsage full (C.1)',
      (s) => s.getContextUsage('full'),
      (q) => q.getContextUsage.mockReturnValue(new Promise(() => undefined)),
      60_000,
    ],
  ])('%s times out after its limit', async (_label, call, hang, limit) => {
    useFakeTimeouts();
    const h = harness();
    const session = h.backend.start(request());
    hang(h.fq());
    let error: unknown = null;
    const pending = call(session).catch((e: unknown) => {
      error = e;
    });
    await vi.advanceTimersByTimeAsync(limit - 1);
    expect(error).toBeNull();
    await vi.advanceTimersByTimeAsync(1);
    await pending;
    expect(error).toBeInstanceOf(Error);
    expect(error).toHaveProperty('name', 'TimeoutError');
    expect(error instanceof Error ? error.message : '').toContain(`timed out after ${limit} ms`);
  });

  it('control calls are refused once closing', async () => {
    const h = harness({ behavior: { onClose: 'hang' } });
    const session = h.backend.start(request());
    void session.close();
    await expect(session.setModel('x')).rejects.toThrow('session closed');
    expect(h.fq().setModel).not.toHaveBeenCalled();
    h.fq().cliExit(0);
  });
});

describe('SdkBackend – canUseTool wrapper (F.3)', () => {
  const suggestion = { type: 'setMode', mode: 'acceptEdits', destination: 'session' } as const;

  it('passes toPermissionRequest(...) and the SDK signal to the handler and returns its result', async () => {
    const handler = vi.fn<PermissionHandler>(() =>
      Promise.resolve({ behavior: 'allow', updatedInput: { command: 'ls' } }),
    );
    const h = harness();
    h.backend.start(request({ canUseTool: handler }));
    const signal = new AbortController().signal;
    const options: Parameters<CanUseTool>[2] = {
      signal,
      toolUseID: SAMPLE_IDS.toolUseId,
      requestId: 'req-1',
      suggestions: [suggestion],
      blockedPath: 'C:\\outside',
      displayName: 'Run command',
    };
    const result = await h.fq().options.canUseTool?.('Bash', { command: 'ls' }, options);
    expect(result).toEqual({ behavior: 'allow', updatedInput: { command: 'ls' } });
    expect(handler).toHaveBeenCalledExactlyOnceWith(
      toPermissionRequest('Bash', { command: 'ls' }, options),
      signal,
    );
    const [passed] = handler.mock.calls[0] ?? [];
    expect(passed).toMatchObject({
      toolName: 'Bash',
      toolUseId: SAMPLE_IDS.toolUseId,
      requestId: 'req-1',
      suggestions: [suggestion],
      blockedPath: 'C:\\outside',
    });
    expect(passed?.raw).not.toHaveProperty('signal');
  });

  it('a throwing handler → deny with the fixed message + error{control}', async () => {
    const handler = vi.fn<PermissionHandler>(() => Promise.reject(new Error('broker exploded')));
    const h = harness();
    const session = h.backend.start(request({ canUseTool: handler }));
    const rec = record(session);
    const result = await h
      .fq()
      .options.canUseTool?.(
        'Write',
        { file_path: 'a.txt' },
        { signal: new AbortController().signal, toolUseID: 't', requestId: 'r' },
      );
    expect(result).toEqual({ behavior: 'deny', message: PERMISSION_FAILURE_MESSAGE });
    await session.close();
    await rec.done;
    expect(rec.events.find((event) => event.type === 'error')).toEqual({
      type: 'error',
      where: 'control',
      name: 'Error',
      message: 'broker exploded',
      at: NOW,
    });
  });
});

describe('SdkBackend – autoCompactWindow with a settings file (C.1)', () => {
  const both = launch({ sdkOptions: { settings: 'D:\\cfg\\settings.json' }, autoCompactWindow: 400_000 });

  it('applies autoCompactWindow via applyFlagSettings once supportedModels answered', async () => {
    const readiness = Promise.withResolvers<unknown[]>();
    const h = harness({
      configure: (q) => {
        q.supportedModels.mockReturnValue(readiness.promise);
      },
    });
    h.backend.start(request({ launch: both }));
    expect(h.fq().options.settings).toBe('D:\\cfg\\settings.json');
    await settle();
    expect(h.fq().supportedModels).toHaveBeenCalledOnce();
    expect(h.fq().applyFlagSettings).not.toHaveBeenCalled();
    readiness.resolve([]);
    await settle();
    expect(h.fq().applyFlagSettings).toHaveBeenCalledExactlyOnceWith({ autoCompactWindow: 400_000 });
  });

  it('waits up to readyMs (not controlMs) for the readiness before the flag settings (R2-04)', async () => {
    useFakeTimeouts();
    const readiness = Promise.withResolvers<unknown[]>();
    const h = harness({
      configure: (q) => {
        q.supportedModels.mockReturnValue(readiness.promise);
      },
    });
    const session = h.backend.start(request({ launch: both }));
    const rec = record(session);
    await vi.advanceTimersByTimeAsync(SDK_TIMEOUTS.controlMs + 1);
    readiness.resolve([]);
    await settle();
    expect(h.fq().applyFlagSettings).toHaveBeenCalledExactlyOnceWith({ autoCompactWindow: 400_000 });
    expect(rec.events.some((event) => event.type === 'error')).toBe(false);
  });

  it('inline autoCompactWindow needs no flag settings', async () => {
    const h = harness();
    h.backend.start(request({ launch: launch({ autoCompactWindow: 400_000 }) }));
    await settle();
    expect(h.fq().options.settings).toEqual({ autoCompactWindow: 400_000 });
    expect(h.fq().applyFlagSettings).not.toHaveBeenCalled();
  });

  it('a failing applyFlagSettings is reported as error{control}', async () => {
    const h = harness({
      configure: (q) => {
        q.applyFlagSettings.mockRejectedValue(new Error('unknown setting'));
      },
    });
    const session = h.backend.start(request({ launch: both }));
    const rec = record(session);
    await settle();
    await session.close();
    await rec.done;
    expect(rec.events.find((event) => event.type === 'error')).toMatchObject({
      where: 'control',
      message: 'unknown setting',
    });
  });
});

describe('SdkBackend – history (A.3, F.15)', () => {
  const msg = (uuid: string, timestamp: string | null, parent: string | null = null) => ({
    type: 'assistant',
    uuid,
    session_id: SAMPLE_IDS.sessionId,
    message: { role: 'assistant', content: [] },
    parent_tool_use_id: parent,
    timestamp,
  });

  it('readHistory = main messages + every subagent, merged by time (R0-18)', async () => {
    const history = fakeHistory((op) => {
      switch (op.op) {
        case 'messages':
          return [
            msg('m1', '2026-10-15T08:00:01.000Z'),
            msg('m3', '2026-10-15T08:00:03.000Z'),
            msg('m4', null),
          ];
        case 'subagents':
          return ['agent-a', 42, 'agent-b'];
        case 'subagentMessages':
          return op.agentId === 'agent-a'
            ? [msg('a2', '2026-10-15T08:00:02.000Z', 'toolu_a')]
            : [msg('b5', '2026-10-15T08:00:05.000Z', 'toolu_b')];
        default:
          return null;
      }
    });
    const h = harness({ history });
    const l = launch({ configDir: 'D:\\cfg' });
    const messages = await h.backend.readHistory({
      sessionId: SAMPLE_IDS.sessionId,
      cwd: 'c:\\Work',
      launch: l,
    });
    expect(messages.map((m) => m.uuid)).toEqual(['m1', 'a2', 'm3', 'm4', 'b5']);
    expect(messages[1]).toMatchObject({ parentToolUseId: 'toolu_a', sessionId: SAMPLE_IDS.sessionId });
    expect(history.runs.map((run) => run.op)).toEqual([
      { op: 'messages', sessionId: SAMPLE_IDS.sessionId },
      { op: 'subagents', sessionId: SAMPLE_IDS.sessionId },
      { op: 'subagentMessages', sessionId: SAMPLE_IDS.sessionId, agentId: 'agent-a' },
      { op: 'subagentMessages', sessionId: SAMPLE_IDS.sessionId, agentId: 'agent-b' },
    ]);
    expect(history.runs.every((run) => run.launch === l)).toBe(true);
  });

  it('readHistory tolerates a non-list subagent answer and rejects when the main lookup fails', async () => {
    const tolerant = harness({
      history: fakeHistory((op) => (op.op === 'messages' ? [msg('m1', null)] : { not: 'a list' })),
    });
    const req = { sessionId: SAMPLE_IDS.sessionId, cwd: 'c:\\Work', launch: launch() };
    await expect(tolerant.backend.readHistory(req)).resolves.toHaveLength(1);

    const failing = harness({
      history: fakeHistory(() => {
        throw new Error('history messages timed out after 30000 ms');
      }),
    });
    await expect(failing.backend.readHistory(req)).rejects.toThrow('timed out');
  });

  it('getSessionInfo maps the SDK info, unknown sessions → null; renameSession → rename op', async () => {
    const history = fakeHistory((op) =>
      op.op === 'info' && op.sessionId === SAMPLE_IDS.sessionId
        ? {
            sessionId: op.sessionId,
            summary: 'AI title',
            customTitle: undefined,
            firstPrompt: 'hi',
            lastModified: 5,
          }
        : null,
    );
    const h = harness({ history });
    const req = { sessionId: SAMPLE_IDS.sessionId, cwd: 'c:\\Work', launch: launch() };
    await expect(h.backend.getSessionInfo(req)).resolves.toEqual({
      sessionId: SAMPLE_IDS.sessionId,
      summary: 'AI title',
      customTitle: null,
      firstPrompt: 'hi',
      lastModified: 5,
    });
    await expect(h.backend.getSessionInfo({ ...req, sessionId: 'other' })).resolves.toBeNull();
    await h.backend.renameSession({ ...req, title: 'New name' });
    expect(history.runs.at(-1)?.op).toEqual({
      op: 'rename',
      sessionId: SAMPLE_IDS.sessionId,
      title: 'New name',
    });
  });

  // A real worker needs real time: a generous limit keeps it stable under parallel load.
  it('readHistory through the real worker pool (data: URL SDK)', { timeout: 60_000 }, async () => {
    const fakeSdk = `
      const m = (uuid, timestamp, parent) => ({ type: 'user', uuid, session_id: 's', message: { role: 'user', content: 'x' },
        parent_tool_use_id: parent, timestamp, origin: { kind: 'human' } });
      export async function getSessionMessages() {
        return [m('m1', '2026-10-15T08:00:01.000Z', null), m('m3', '2026-10-15T08:00:03.000Z', null)];
      }
      export async function listSubagents() { return ['a']; }
      export async function getSubagentMessages() { return [m('a2', '2026-10-15T08:00:02.000Z', 'toolu_a')]; }
      export async function getSessionInfo() { return undefined; }
      export async function renameSession() {}
    `;
    const pool = createHistoryPool({ sdkModuleUrl: `data:text/javascript,${encodeURIComponent(fakeSdk)}` });
    const h = harness({ history: pool });
    const req = { sessionId: 's', cwd: 'c:\\Work', launch: launch({ configDir: 'D:\\cfg' }) };
    const messages = await h.backend.readHistory(req);
    expect(messages.map((m) => [m.uuid, m.parentToolUseId, m.origin])).toEqual([
      ['m1', null, { kind: 'human' }],
      ['a2', 'toolu_a', { kind: 'human' }],
      ['m3', null, { kind: 'human' }],
    ]);
    await expect(h.backend.getSessionInfo(req)).resolves.toBeNull();
    await h.backend.dispose();
    expect(pool.size).toBe(0);
  });
});

describe('SdkBackend – dispose and defaults', () => {
  it('dispose closes every live session (expected) and disposes the history pool', async () => {
    const h = harness();
    const a = record(h.backend.start(request()));
    const b = record(h.backend.start(request({ entryId: sampleId('en', 2) })));
    await h.backend.dispose();
    await Promise.all([a.done, b.done]);
    expect(a.events.at(-1)).toMatchObject({ type: 'exit', expected: true });
    expect(b.events.at(-1)).toMatchObject({ type: 'exit', expected: true });
    expect(h.queries.map((q) => q.closeCalls)).toEqual([1, 1]);
    expect(h.history).toMatchObject({ disposed: 1 });
  });

  it('a finished session is no longer closed by dispose', async () => {
    const h = harness();
    const session = h.backend.start(request());
    const rec = record(session);
    h.fq().crash(2);
    await rec.done;
    await h.backend.dispose();
    expect(h.fq().closeCalls).toBe(0);
  });

  it('uses the SDK query() by default (mocked here – never the real CLI)', async () => {
    sdkQueryMock.mockImplementationOnce(() => {
      throw new Error('mocked sdk query');
    });
    const backend = createSdkBackend({ history: fakeHistory(), now: () => NOW });
    backends.push(backend);
    const rec = record(backend.start(request()));
    await rec.done;
    expect(sdkQueryMock).toHaveBeenCalledOnce();
    expect(rec.events).toEqual([
      { type: 'error', where: 'spawn', name: 'Error', message: 'mocked sdk query', at: NOW },
      { type: 'exit', code: null, signal: null, expected: false, at: NOW },
    ]);
  });

  it('the default spawn is spawnHidden (mocked here – it refuses to run)', async () => {
    sdkQueryMock.mockImplementationOnce(({ options }: { options: Options }) => {
      options.spawnClaudeCodeProcess?.({
        command: EXE,
        args: [],
        env: {},
        signal: new AbortController().signal,
      });
      throw new Error('unreachable');
    });
    const backend = createSdkBackend({ history: fakeHistory(), now: () => NOW });
    backends.push(backend);
    const rec = record(backend.start(request()));
    await rec.done;
    expect(rec.events[0]).toMatchObject({
      where: 'spawn',
      message: 'real spawnHidden must not run in tests',
    });
  });
});
