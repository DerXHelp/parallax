import type { CanUseTool, Options, SDKUserMessage } from '@anthropic-ai/claude-agent-sdk';
import { ChildProcess } from 'node:child_process';
import path from 'node:path';
import { PassThrough } from 'node:stream';
import { fileURLToPath } from 'node:url';
import { pino, type Logger } from 'pino';
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
  loadAgentSdk,
  PERMISSION_FAILURE_MESSAGE,
  SDK_TIMEOUTS,
  stillQueuedOf,
  toSdkUserMessage,
  type SdkQueryFn,
  type SdkQueryHandle,
  type SdkTimeouts,
} from './sdkBackend';
import type {
  AgentSession,
  BackendEvent,
  PermissionHandler,
  SideQuestionOptions,
  StartSessionRequest,
} from './types';

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
  /** WP-64: internal SDK methods – absent unless a test sets them (runtime check). */
  enableRemoteControl?: SdkQueryHandle['enableRemoteControl'];
  getSettings?: SdkQueryHandle['getSettings'];

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
  /** Backend logger (default: the module logger). */
  logger?: Logger;
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
    ...(p.logger === undefined ? {} : { logger: p.logger }),
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
      titleMs: 60000,
      sideQuestionMs: 120000,
      infoMs: 30000,
      infoActionMs: 60000,
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

  it('a document title goes into DocumentBlockParam.title', async () => {
    const h = harness();
    const session = h.backend.start(request());
    session.send({
      uuid: sampleUuid(8),
      priority: 'next',
      content: [{ type: 'document', mediaType: 'application/pdf', base64: 'JVBERi0=', title: 'Angebot.pdf' }],
    });
    await settle();
    expect(h.fq().inputs.map((input) => input.message.content)).toEqual([
      [
        {
          type: 'document',
          source: { type: 'base64', media_type: 'application/pdf', data: 'JVBERi0=' },
          title: 'Angebot.pdf',
        },
      ],
    ]);
  });

  it('Phase 3: inlinePastes → inline_pastes only when not empty, documents unchanged, no client_composed', async () => {
    const h = harness();
    const session = h.backend.start(request());
    const content = [
      { type: 'text' as const, text: 'See\npasted one\nand pasted two' },
      { type: 'document' as const, mediaType: 'application/pdf' as const, base64: 'JVBERi0=' },
    ];
    session.send({
      uuid: sampleUuid(10),
      priority: 'next',
      content,
      inlinePastes: ['pasted one', 'pasted two'],
    });
    session.send({
      uuid: sampleUuid(11),
      priority: 'next',
      content: [{ type: 'text', text: 'none' }],
      inlinePastes: [],
    });
    session.send({ uuid: sampleUuid(12), priority: 'next', content: [{ type: 'text', text: 'absent' }] });
    await settle();
    const [withPastes, empty, absent] = h.fq().inputs;
    expect(withPastes).toMatchObject({
      uuid: sampleUuid(10),
      inline_pastes: ['pasted one', 'pasted two'],
      message: {
        content: [
          { type: 'text', text: 'See\npasted one\nand pasted two' },
          { type: 'document', source: { type: 'base64', media_type: 'application/pdf', data: 'JVBERi0=' } },
        ],
      },
    });
    expect(empty).not.toHaveProperty('inline_pastes');
    expect(absent).not.toHaveProperty('inline_pastes');
    for (const input of h.fq().inputs) expect(input).not.toHaveProperty('client_composed');
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

describe('SdkBackend – Remote Control (WP-64)', () => {
  /** Answer of the spike (rc-events.log, 12.11.2026). */
  const ANSWER = {
    session_url: 'https://claude.ai/code/session_01QKkfSZajXxCTUVAWr5SbHm',
    connect_url: 'https://claude.ai/code?environment=',
    environment_id: '',
    bridge_epoch: 1,
    bridge_session_id: 'cse_01QKkfSZajXxCTUVAWr5SbHm',
  };

  function withRemoteControl(answer: () => Promise<unknown>) {
    const enable = vi.fn<NonNullable<SdkQueryHandle['enableRemoteControl']>>(answer);
    const settings = vi.fn<NonNullable<SdkQueryHandle['getSettings']>>(() =>
      Promise.resolve({ effective: { remoteControlAtStartup: true }, sources: [] }),
    );
    const h = harness({
      configure: (q) => {
        q.enableRemoteControl = enable;
        q.getSettings = settings;
      },
    });
    return { h, enable, settings, session: h.backend.start(request()) };
  }

  it('enables with keepSessionOnExit, name and reattach id and returns the checked answer', async () => {
    const { enable, session } = withRemoteControl(() => Promise.resolve(ANSWER));
    await expect(
      session.setRemoteControl(true, { name: 'Fix login', reattachSessionId: 'cse_01QKkfSZajXxCTUVAWr5SbHm' }),
    ).resolves.toEqual({
      ok: true,
      info: {
        bridgeSessionId: 'cse_01QKkfSZajXxCTUVAWr5SbHm',
        sessionUrl: 'https://claude.ai/code/session_01QKkfSZajXxCTUVAWr5SbHm',
      },
    });
    expect(enable).toHaveBeenCalledWith(true, 'Fix login', {
      keepSessionOnExit: true,
      reattachSessionId: 'cse_01QKkfSZajXxCTUVAWr5SbHm',
    });
  });

  it('without name and reattach id passes neither; disabling answers info null', async () => {
    const { enable, session } = withRemoteControl(() => Promise.resolve(undefined));
    await expect(session.setRemoteControl(false, { name: null, reattachSessionId: null })).resolves.toEqual({
      ok: true,
      info: null,
    });
    expect(enable).toHaveBeenCalledWith(false, undefined, { keepSessionOnExit: true });
  });

  it('a session url that is not https://claude.ai is dropped, a garbage answer is UNAVAILABLE', async () => {
    const answers = [
      { ...ANSWER, session_url: 'http://evil.example/x' },
      { session_url: ANSWER.session_url },
    ];
    const { session } = withRemoteControl(() => Promise.resolve(answers.shift()));
    await expect(session.setRemoteControl(true, { name: null, reattachSessionId: null })).resolves.toEqual({
      ok: true,
      info: { bridgeSessionId: ANSWER.bridge_session_id, sessionUrl: null },
    });
    await expect(session.setRemoteControl(true, { name: null, reattachSessionId: null })).resolves.toEqual({
      ok: false,
      error: { code: 'REMOTE_CONTROL_UNAVAILABLE', params: { reason: 'answer' } },
    });
  });

  it('runtime check: without the SDK methods → REMOTE_CONTROL_UNAVAILABLE and default null, no crash', async () => {
    const h = harness();
    const session = h.backend.start(request());
    await expect(session.setRemoteControl(true, { name: null, reattachSessionId: null })).resolves.toEqual({
      ok: false,
      error: { code: 'REMOTE_CONTROL_UNAVAILABLE', params: { reason: 'sdk' } },
    });
    await expect(session.readRemoteControlDefault()).resolves.toBeNull();
  });

  it.each<[string, Error, string, Record<string, unknown>]>([
    [
      'auth',
      Object.assign(new Error('Remote Control requires a claude.ai login'), { errorCode: 'remote_control_auth' }),
      'REMOTE_CONTROL_AUTH',
      {},
    ],
    [
      'policy',
      Object.assign(new Error('disabled by policy'), { errorCode: 'remote_control_policy_disabled' }),
      'REMOTE_CONTROL_POLICY_DISABLED',
      {},
    ],
    [
      'other code',
      Object.assign(new Error('ended'), { errorCode: 'remote_control_ended_elsewhere' }),
      'REMOTE_CONTROL_FAILED',
      { reason: 'remote_control_ended_elsewhere', detail: 'ended' },
    ],
    [
      'old CLI',
      new Error('Unsupported control request subtype: remote_control'),
      'REMOTE_CONTROL_UNAVAILABLE',
      { reason: 'cli' },
    ],
    ['plain error', new Error('boom'), 'REMOTE_CONTROL_FAILED', { reason: 'control', detail: 'boom' }],
  ])('control error %s → %s (never rejects)', async (_label, error, code, params) => {
    const { session } = withRemoteControl(() => Promise.reject(error));
    const result = await session.setRemoteControl(true, { name: null, reattachSessionId: null });
    expect(result).toMatchObject({ ok: false, error: { code, params } });
  });

  it('a hanging enable request fails with reason timeout after controlMs', async () => {
    useFakeTimeouts();
    const { session } = withRemoteControl(() => new Promise(() => undefined));
    const pending = session.setRemoteControl(true, { name: null, reattachSessionId: null });
    await vi.advanceTimersByTimeAsync(SDK_TIMEOUTS.controlMs);
    await expect(pending).resolves.toMatchObject({
      ok: false,
      error: { code: 'REMOTE_CONTROL_FAILED', params: { reason: 'timeout' } },
    });
  });

  it.each<[string, unknown, boolean | null]>([
    ['true', { effective: { remoteControlAtStartup: true } }, true],
    ['false', { effective: { remoteControlAtStartup: false } }, false],
    ['not set', { effective: {} }, null],
    ['garbage', 'x', null],
    ['not a boolean', { effective: { remoteControlAtStartup: 'yes' } }, null],
  ])('readRemoteControlDefault: %s', async (_label, answer, expected) => {
    const { settings, session } = withRemoteControl(() => Promise.resolve(ANSWER));
    settings.mockResolvedValueOnce(answer);
    await expect(session.readRemoteControlDefault()).resolves.toBe(expected);
  });

  it('readRemoteControlDefault: a failing getSettings is null', async () => {
    const { settings, session } = withRemoteControl(() => Promise.resolve(ANSWER));
    settings.mockRejectedValueOnce(new Error('nope'));
    await expect(session.readRemoteControlDefault()).resolves.toBeNull();
  });
});

describe('SdkBackend – overview methods (WP-65)', () => {
  function withOverview(configure: (q: SdkQueryHandle) => void) {
    const h = harness({ configure });
    return { h, session: h.backend.start(request()) };
  }

  it('generateTitle: persist goes through, the answer is checked; missing → unavailable, errors → failed', async () => {
    const title = vi.fn<NonNullable<SdkQueryHandle['generateSessionTitle']>>(() =>
      Promise.resolve('  Login-Fehlschlag   nach Token-Ablauf '),
    );
    const { session } = withOverview((q) => {
      q.generateSessionTitle = title;
    });
    await expect(session.generateTitle('Login fails after the token expired', { persist: true })).resolves.toEqual({
      ok: true,
      title: 'Login-Fehlschlag nach Token-Ablauf',
    });
    expect(title).toHaveBeenCalledWith('Login fails after the token expired', { persist: true });
    title.mockResolvedValueOnce(42);
    await expect(session.generateTitle('x', { persist: false })).resolves.toEqual({ ok: true, title: null });
    title.mockRejectedValueOnce(new Error('model error'));
    await expect(session.generateTitle('x', { persist: false })).resolves.toEqual({ ok: false, reason: 'failed' });

    const { session: old } = withOverview(() => undefined);
    await expect(old.generateTitle('x', { persist: true })).resolves.toEqual({ ok: false, reason: 'unavailable' });
  });

  it('backgroundTasks: with and without tool use id; false = nothing matched; missing method rejects', async () => {
    const move = vi.fn<NonNullable<SdkQueryHandle['backgroundTasks']>>(() => Promise.resolve(true));
    const { session } = withOverview((q) => {
      q.backgroundTasks = move;
    });
    await expect(session.backgroundTasks('toolu_1')).resolves.toBe(true);
    await expect(session.backgroundTasks(null)).resolves.toBe(true);
    expect(move.mock.calls).toEqual([['toolu_1'], []]);
    move.mockResolvedValueOnce(false);
    await expect(session.backgroundTasks('toolu_x')).resolves.toBe(false);
    move.mockRejectedValueOnce(new Error('Background tasks are disabled'));
    await expect(session.backgroundTasks(null)).rejects.toThrow();

    const { session: old } = withOverview(() => undefined);
    await expect(old.backgroundTasks(null)).rejects.toThrow();
  });

  it('readUsage: skipBehaviors, 0–100 → fractions; missing, failing, no plan → null', async () => {
    const usage = vi.fn<NonNullable<SdkQueryHandle['usage_EXPERIMENTAL_MAY_CHANGE_DO_NOT_RELY_ON_THIS_API_YET']>>(() =>
      Promise.resolve({
        rate_limits_available: true,
        rate_limits: {
          five_hour: { utilization: 42, resets_at: '2026-11-12T18:00:00Z' },
          seven_day: { utilization: 81.5, resets_at: null },
          seven_day_opus: null,
          seven_day_cowork: null,
        },
      }),
    );
    const { session } = withOverview((q) => {
      q.usage_EXPERIMENTAL_MAY_CHANGE_DO_NOT_RELY_ON_THIS_API_YET = usage;
    });
    await expect(session.readUsage()).resolves.toEqual({
      windows: {
        five_hour: { utilization: 0.42, resetsAt: '2026-11-12T18:00:00.000Z' },
        seven_day: { utilization: 0.815, resetsAt: null },
      },
      cleared: ['seven_day_opus'],
    });
    expect(usage).toHaveBeenCalledWith({ skipBehaviors: true });
    usage.mockResolvedValueOnce({ rate_limits_available: false, rate_limits: null });
    await expect(session.readUsage()).resolves.toBeNull();
    usage.mockRejectedValueOnce(new Error('nope'));
    await expect(session.readUsage()).resolves.toBeNull();

    const { session: old } = withOverview(() => undefined);
    await expect(old.readUsage()).resolves.toBeNull();
  });
});

describe('SdkBackend – side questions and withdraw (WP-66)', () => {
  type Ask = NonNullable<SdkQueryHandle['askSideQuestion']>;

  function withSide(configure: (q: SdkQueryHandle) => void, timeouts?: Partial<SdkTimeouts>) {
    const h = harness({ configure, ...(timeouts === undefined ? {} : { timeouts }) });
    const session = h.backend.start(request());
    record(session);
    return { h, session };
  }

  function sideOptions(o: Partial<SideQuestionOptions> = {}): SideQuestionOptions {
    return { history: [], signal: new AbortController().signal, ...o };
  }

  /** A request that only ends when its signal aborts (rejects like the SDK). */
  const hanging: Ask = (_question, opts) =>
    new Promise((_resolve, reject) => {
      opts?.signal?.addEventListener('abort', () => {
        reject(new Error('aborted'));
      });
    });

  it('askSideQuestion: answer checked, history only when given; null answer; unknown shape and missing → unavailable', async () => {
    const ask = vi.fn<Ask>(() =>
      Promise.resolve({ response: 'It is fine.', synthetic: false, refusalFallback: { fallbackModel: 'sonnet' } }),
    );
    const { session } = withSide((q) => {
      q.askSideQuestion = ask;
    });
    await expect(session.askSideQuestion('Why?', sideOptions())).resolves.toEqual({
      ok: true,
      answer: { response: 'It is fine.', synthetic: false, fallbackModel: 'sonnet' },
    });
    expect(ask.mock.calls[0]?.[1]).not.toHaveProperty('history');
    expect(ask.mock.calls[0]?.[1]?.signal).toBeInstanceOf(AbortSignal);
    const history = [{ question: 'Why?', response: 'It is fine.' }];
    ask.mockResolvedValueOnce({ response: 'Because.' });
    await expect(session.askSideQuestion('And?', sideOptions({ history }))).resolves.toEqual({
      ok: true,
      answer: { response: 'Because.', synthetic: false, fallbackModel: null },
    });
    expect(ask.mock.calls[1]?.[1]?.history).toEqual(history);
    ask.mockResolvedValueOnce(null);
    await expect(session.askSideQuestion('x', sideOptions())).resolves.toEqual({ ok: true, answer: null });
    ask.mockResolvedValueOnce({ text: 'other shape' });
    await expect(session.askSideQuestion('x', sideOptions())).resolves.toEqual({ ok: false, reason: 'unavailable' });

    const { session: old } = withSide(() => undefined);
    await expect(old.askSideQuestion('x', sideOptions())).resolves.toEqual({ ok: false, reason: 'unavailable' });
  });

  it('side_question_busy (errorCode or message) → busy; any other error → failed', async () => {
    const ask = vi.fn<Ask>(() => Promise.reject(Object.assign(new Error('busy'), { errorCode: 'side_question_busy' })));
    const { session } = withSide((q) => {
      q.askSideQuestion = ask;
    });
    await expect(session.askSideQuestion('x', sideOptions())).resolves.toEqual({ ok: false, reason: 'busy' });
    ask.mockRejectedValueOnce(new Error('control error: side_question_busy'));
    await expect(session.askSideQuestion('x', sideOptions())).resolves.toEqual({ ok: false, reason: 'busy' });
    ask.mockRejectedValueOnce(new Error('model error'));
    await expect(session.askSideQuestion('x', sideOptions())).resolves.toEqual({ ok: false, reason: 'failed' });
  });

  it('the caller aborts → cancelled (the SDK request is aborted too); an aborted signal never asks', async () => {
    const ask = vi.fn<Ask>(hanging);
    const { session } = withSide((q) => {
      q.askSideQuestion = ask;
    });
    const controller = new AbortController();
    const pending = session.askSideQuestion('x', sideOptions({ signal: controller.signal }));
    await settle();
    controller.abort();
    await expect(pending).resolves.toEqual({ ok: false, reason: 'cancelled' });
    expect(ask.mock.calls[0]?.[1]?.signal?.aborted).toBe(true);
    await expect(session.askSideQuestion('x', sideOptions({ signal: controller.signal }))).resolves.toEqual({
      ok: false,
      reason: 'cancelled',
    });
    expect(ask).toHaveBeenCalledTimes(1);
  });

  it('a hanging request fails after sideQuestionMs and is aborted (control_cancel_request)', async () => {
    useFakeTimeouts();
    const ask = vi.fn<Ask>(hanging);
    const { session } = withSide((q) => {
      q.askSideQuestion = ask;
    });
    const pending = session.askSideQuestion('x', sideOptions());
    await vi.advanceTimersByTimeAsync(SDK_TIMEOUTS.sideQuestionMs);
    await expect(pending).resolves.toEqual({ ok: false, reason: 'failed' });
    expect(ask.mock.calls[0]?.[1]?.signal?.aborted).toBe(true);
  });

  it('api_retry progress reaches the only open side question – not while a title request runs or two are open', async () => {
    const answers: ((value: unknown) => void)[] = [];
    let titleDone: (value: unknown) => void = () => undefined;
    const { h, session } = withSide((q) => {
      q.askSideQuestion = () =>
        new Promise((resolve) => {
          answers.push(resolve);
        });
      q.generateSessionTitle = () =>
        new Promise((resolve) => {
          titleDone = resolve;
        });
    });
    const retry = (attempt: number) => ({
      type: 'system',
      subtype: 'control_request_progress',
      request_id: 'r1',
      status: 'api_retry',
      attempt,
      max_retries: 10,
    });
    const onRetry = vi.fn();
    const first = session.askSideQuestion('x', sideOptions({ onRetry }));
    await settle();
    h.fq().push({ type: 'system', subtype: 'control_request_progress', request_id: 'r1', status: 'started' });
    h.fq().push(retry(1));
    await settle();
    expect(onRetry.mock.calls).toEqual([[{ attempt: 1, maxRetries: 10 }]]);

    const title = session.generateTitle('x', { persist: false });
    await settle();
    h.fq().push(retry(2));
    await settle();
    titleDone('A title');
    await title;

    const onRetry2 = vi.fn();
    const second = session.askSideQuestion('y', sideOptions({ onRetry: onRetry2 }));
    await settle();
    h.fq().push(retry(3));
    await settle();
    expect(onRetry).toHaveBeenCalledTimes(1);
    expect(onRetry2).not.toHaveBeenCalled();
    for (const answer of answers) answer({ response: 'ok' });
    await expect(first).resolves.toMatchObject({ ok: true });
    await expect(second).resolves.toMatchObject({ ok: true });
  });

  it('withdrawQueued: the cancelled flag of the CLI; a missing method and a failure reject', async () => {
    const cancel = vi.fn<NonNullable<SdkQueryHandle['cancelAsyncMessage']>>(() => Promise.resolve(true));
    const { session } = withSide((q) => {
      q.cancelAsyncMessage = cancel;
    });
    await expect(session.withdrawQueued(sampleUuid(1))).resolves.toBe(true);
    expect(cancel).toHaveBeenCalledWith(sampleUuid(1));
    cancel.mockResolvedValueOnce(false);
    await expect(session.withdrawQueued(sampleUuid(1))).resolves.toBe(false);
    cancel.mockResolvedValueOnce({ cancelled: true });
    await expect(session.withdrawQueued(sampleUuid(1))).resolves.toBe(true);
    cancel.mockResolvedValueOnce('yes');
    await expect(session.withdrawQueued(sampleUuid(1))).resolves.toBe(false);
    cancel.mockRejectedValueOnce(new Error('nope'));
    await expect(session.withdrawQueued(sampleUuid(1))).rejects.toThrow('nope');

    const { session: old } = withSide(() => undefined);
    await expect(old.withdrawQueued(sampleUuid(1))).rejects.toThrow(/cancelAsyncMessage/);
  });
});

describe('SdkBackend – session info, MCP actions, reloads (WP-67)', () => {
  function withInfo(configure: (q: SdkQueryHandle) => void, logger?: Logger) {
    const h = harness({ configure, ...(logger === undefined ? {} : { logger }) });
    const session = h.backend.start(request());
    record(session);
    return { h, session };
  }

  function capture() {
    const lines: Record<string, unknown>[] = [];
    const logger = pino({ level: 'debug' }, { write: (line: string) => lines.push(JSON.parse(line) as Record<string, unknown>) });
    return { logger, lines };
  }

  it('each tab calls its method once and parses the answer (mcpServerStatus typed, the rest internal)', async () => {
    const status = vi.fn(() => Promise.resolve({ sections: [{ title: 'Session', rows: [{ label: 'Version', value: '2.1.323' }] }] }));
    const mcp = vi.fn(() => Promise.resolve([{ name: 'docs', status: 'connected' }]));
    const exportConversation = vi.fn(() => Promise.resolve({ text: 'hi', default_filename: 'a.txt' }));
    const { session } = withInfo((q) => {
      q.getStatus = status;
      q.mcpServerStatus = mcp;
      q.exportConversation = exportConversation;
    });
    await expect(session.readInfo('status')).resolves.toEqual({
      section: 'status',
      groups: [{ title: 'Session', rows: [{ label: 'Version', value: '2.1.323' }] }],
      extra: [],
    });
    await expect(session.readInfo('mcp')).resolves.toMatchObject({ servers: [{ name: 'docs', status: 'connected' }] });
    await expect(session.readInfo('export')).resolves.toMatchObject({ text: 'hi', filename: 'a.txt' });
    expect([status.mock.calls.length, mcp.mock.calls.length, exportConversation.mock.calls.length]).toEqual([1, 1, 1]);
  });

  it('missing method, refused request, unknown shape → null (logged once, never the answer); other errors reject', async () => {
    const { logger, lines } = capture();
    const skills = vi.fn<() => Promise<unknown>>(() => Promise.reject(new Error('Unsupported control request subtype: get_skills_dialog')));
    const status = vi.fn<() => Promise<unknown>>(() => Promise.resolve({ unexpected: 'user@example.com' }));
    const memory = vi.fn<() => Promise<unknown>>(() => Promise.reject(new Error('Request timed out')));
    const { session } = withInfo((q) => {
      q.getSkillsDialog = skills;
      q.getStatus = status;
      q.getMemoryDialog = memory;
    }, logger);
    await expect(session.readInfo('hooks')).resolves.toBeNull();
    await expect(session.readInfo('hooks')).resolves.toBeNull();
    await expect(session.readInfo('skills')).resolves.toBeNull();
    await expect(session.readInfo('status')).resolves.toBeNull();
    await expect(session.readInfo('memory')).rejects.toThrow('Request timed out');
    const info = lines.filter((line) => typeof line.msg === 'string' && line.msg.startsWith('session info'));
    // The second "hooks" request only logs at debug level.
    expect(info.filter((line) => line.section === 'hooks').map((line) => line.level)).toEqual([30, 20]);
    expect(info.map((line) => line.msg)).toEqual(
      expect.arrayContaining([
        'session info: method missing in this SDK/CLI',
        'session info: this CLI does not answer the request',
        'session info: unknown answer shape – tab not available',
        'session info request failed',
      ]),
    );
    expect(JSON.stringify(lines)).not.toContain('user@example.com');
  });

  it('unknown fields are logged once as keys only', async () => {
    const { logger, lines } = capture();
    const { session } = withInfo((q) => {
      q.getSkillsDialog = () => Promise.resolve({ skills: [{ name: 'a', secretField: 'value-xyz' }] });
    }, logger);
    await session.readInfo('skills');
    await session.readInfo('skills');
    const unknown = lines.filter((line) => line.msg === 'session info: unknown fields ignored');
    expect(unknown.map((line) => [line.level, line.unknown])).toEqual([
      [30, ['skills.skills:secretField']],
      [20, ['skills.skills:secretField']],
    ]);
    expect(JSON.stringify(lines)).not.toContain('value-xyz');
  });

  it('mcpAction: reconnect / toggle(true|false); reload: skills / plugins; missing methods and failures reject', async () => {
    const reconnect = vi.fn<NonNullable<SdkQueryHandle['reconnectMcpServer']>>(() => Promise.resolve());
    const toggle = vi.fn<NonNullable<SdkQueryHandle['toggleMcpServer']>>(() => Promise.resolve());
    const reloadSkills = vi.fn(() => Promise.resolve({ skills: [] }));
    const reloadPlugins = vi.fn(() => Promise.resolve({ commands: [], error_count: 0 }));
    const { session } = withInfo((q) => {
      q.reconnectMcpServer = reconnect;
      q.toggleMcpServer = toggle;
      q.reloadSkills = reloadSkills;
      q.reloadPlugins = reloadPlugins;
    });
    await session.mcpAction('docs', 'reconnect');
    await session.mcpAction('docs', 'disable');
    await session.mcpAction('docs', 'enable');
    expect(reconnect.mock.calls).toEqual([['docs']]);
    expect(toggle.mock.calls).toEqual([
      ['docs', false],
      ['docs', true],
    ]);
    await session.reload('skills');
    await session.reload('plugins');
    expect([reloadSkills.mock.calls.length, reloadPlugins.mock.calls.length]).toEqual([1, 1]);
    reconnect.mockRejectedValueOnce(new Error('MCP server "docs" is disabled'));
    await expect(session.mcpAction('docs', 'reconnect')).rejects.toThrow('is disabled');

    const { session: old } = withInfo(() => undefined);
    await expect(old.mcpAction('docs', 'reconnect')).rejects.toThrow(/reconnectMcpServer/);
    await expect(old.mcpAction('docs', 'enable')).rejects.toThrow(/toggleMcpServer/);
    await expect(old.reload('skills')).rejects.toThrow(/reload skills/);
    await expect(old.reload('plugins')).rejects.toThrow(/reload plugins/);
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

  it('WP61-02: a settings file alone gets no flag settings after the start (no todoFeatureEnabled)', async () => {
    const h = harness();
    h.backend.start(request({ launch: launch({ sdkOptions: { settings: 'D:\\cfg\\settings.json' } }) }));
    await settle();
    expect(h.fq().options.settings).toBe('D:\\cfg\\settings.json');
    expect(h.fq().applyFlagSettings).not.toHaveBeenCalled();
    const plain = harness();
    plain.backend.start(request());
    await settle();
    expect(plain.fq().options).not.toHaveProperty('settings');
    expect(plain.fq().applyFlagSettings).not.toHaveBeenCalled();
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

  it('Phase 2 fast mode: inline with settings.fastMode, after readiness with a settings file', async () => {
    const inline = harness();
    inline.backend.start(request({ fastMode: true }));
    await settle();
    expect(inline.fq().options.settings).toEqual({ fastMode: true });
    expect(inline.fq().applyFlagSettings).not.toHaveBeenCalled();
    const file = harness();
    file.backend.start(request({ fastMode: false, launch: both }));
    await settle();
    expect(file.fq().options.settings).toBe('D:\\cfg\\settings.json');
    expect(file.fq().applyFlagSettings).toHaveBeenCalledExactlyOnceWith({
      autoCompactWindow: 400_000,
      fastMode: false,
    });
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

describe('SdkBackend – credential expiry in the log (WP61-04, B15)', () => {
  const EXPIRY_MSG = 'first result: credential expiry';

  function capture() {
    const lines: string[] = [];
    const logger = pino({ level: 'debug' }, { write: (line: string) => lines.push(line) });
    const expiry = () =>
      lines
        .map((line) => JSON.parse(line) as Record<string, unknown>)
        .filter((line) => line.msg === EXPIRY_MSG);
    return { logger, expiry };
  }

  const resultMessage = (extra: Record<string, unknown>) => ({
    type: 'result',
    subtype: 'success',
    is_error: false,
    total_cost_usd: 0.002,
    session_id: SAMPLE_IDS.sessionId,
    ...extra,
  });

  it('one debug line at the first result of a process – only the expiry, nothing else of the result', async () => {
    const { logger, expiry } = capture();
    const h = harness({ logger });
    const session = h.backend.start(request());
    const rec = record(session);
    h.fq().push(
      { type: 'system', subtype: 'init', session_id: SAMPLE_IDS.sessionId },
      resultMessage({ credential_expires_at: '2026-12-10T08:00:00.000Z' }),
      resultMessage({ credential_expires_at: '2026-12-11T08:00:00.000Z' }),
    );
    await settle();
    expect(rec.events.filter((event) => event.type === 'message')).toHaveLength(3);
    const lines = expiry();
    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatchObject({
      level: 20,
      entryId: SAMPLE_IDS.entry,
      credentialExpiresAt: '2026-12-10T08:00:00.000Z',
    });
    expect(Object.keys(lines[0] ?? {}).sort()).toEqual(
      ['credentialExpiresAt', 'entryId', 'hostname', 'level', 'module', 'msg', 'pid', 'time'].sort(),
    );
  });

  it('a result without the field logs null; every process logs its own first result', async () => {
    const { logger, expiry } = capture();
    const h = harness({ logger });
    h.backend.start(request());
    h.fq().push(resultMessage({}), resultMessage({ credential_expires_at: '2026-12-10T08:00:00.000Z' }));
    h.backend.start(request());
    h.fq(1).push(resultMessage({ credential_expires_at: 42 }));
    await settle();
    expect(expiry().map((line) => line.credentialExpiresAt)).toEqual([null, null]);
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

  it('without a query, createSdkBackend needs loadAgentSdk() first (the SDK is loaded lazily)', async () => {
    vi.resetModules();
    const fresh = await import('./sdkBackend');
    expect(() => fresh.createSdkBackend({ history: fakeHistory(), now: () => NOW })).toThrow(
      'await loadAgentSdk()',
    );
    expect(sdkQueryMock).not.toHaveBeenCalled();
  });

  it('uses the SDK query() by default once loadAgentSdk() resolved (mocked here – never the real CLI)', async () => {
    expect(await loadAgentSdk()).toBe(sdkQueryMock);
    expect(await loadAgentSdk()).toBe(sdkQueryMock);
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
    await loadAgentSdk();
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
