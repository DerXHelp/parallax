import { describe, expect, it, vi } from 'vitest';
import type { EntryId } from '@shared/common';
import { makeError, type ErrorPayload } from '@shared/errors';
import { DEFAULT_CONSOLE_SETTINGS, type ShellKind } from '@shared/model';
import { SAMPLE_IDS, SAMPLE_TIME, sampleId } from '@shared/samples';
import {
  TERMINAL_CLOSE_CODES,
  TERMINAL_LIMITS,
  TERMINAL_PROTOCOL_VERSION,
  decodeTerminalFrame,
  terminalIdSchema,
  terminalServerMessageSchema,
  type TerminalInfo,
  type TerminalServerMessage,
} from '@shared/terminal';
import { nextMacrotask } from '../lib/async';
import { createLogger } from '../lib/logger';
import { createManualTimers } from '../sessions/lib/timers';
import { CommandError } from '../sync/ports';
import { ConPtyError } from './conpty';
import { createFakePtyFactory, type FakePtyProcess } from './fakePty';
import { POLL_ACTIVE_MS, POLL_IDLE_MS } from './poller';
import type { PtyFactory, TerminalConnection, TerminalEntryInfo, TerminalSink } from './ports';
import {
  EXIT_DRAIN_MAX_MS,
  KILL_FALLBACK_MS,
  TERMINAL_BACKPRESSURE,
  TERMINAL_FRAME_BYTES,
  createTerminalService,
  type TerminalServiceOptions,
} from './service';

const ENTRY = SAMPLE_IDS.entry;
const OTHER = sampleId('en', 2);
const CWD = 'D:\\Projects\\demo';
const EXE: Record<ShellKind, string> = {
  cmd: 'C:\\Windows\\System32\\cmd.exe',
  powershell: 'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe',
  gitbash: 'C:\\Program Files\\Git\\bin\\bash.exe',
};
const PROMPT = `${CWD}>`;

type MessageOf<T extends TerminalServerMessage['type']> = Extract<TerminalServerMessage, { type: T }>;

interface RecordingSink extends TerminalSink {
  readonly messages: TerminalServerMessage[];
  readonly frames: { channel: number; data: Uint8Array }[];
  buffered: number;
  closedWith: { code: number; reason: string } | null;
  of<T extends TerminalServerMessage['type']>(type: T): MessageOf<T>[];
  /** Output text received on `channel`. */
  text(channel: number): string;
}

function recordingSink(): RecordingSink {
  const messages: TerminalServerMessage[] = [];
  const frames: { channel: number; data: Uint8Array }[] = [];
  const sink: RecordingSink = {
    messages,
    frames,
    buffered: 0,
    closedWith: null,
    send(message) {
      // Every outgoing message must satisfy the contract.
      messages.push(terminalServerMessageSchema.parse(message));
    },
    sendFrame(frame) {
      expect(frame.length).toBeLessThanOrEqual(TERMINAL_FRAME_BYTES + 1);
      const decoded = decodeTerminalFrame(frame);
      if (decoded === null) throw new Error('empty frame');
      frames.push({ channel: decoded.channel, data: Uint8Array.from(decoded.data) });
    },
    bufferedAmount: () => sink.buffered,
    close(code, reason) {
      sink.closedWith = { code, reason };
    },
    of<T extends TerminalServerMessage['type']>(type: T): MessageOf<T>[] {
      return messages.filter((m): m is MessageOf<T> => m.type === type);
    },
    text(channel) {
      return frames
        .filter((f) => f.channel === channel)
        .map((f) => Buffer.from(f.data).toString('utf8'))
        .join('');
    },
  };
  return sink;
}

/** Lets the awaits of an `open` (checkCwd, launch) run. */
const flush = nextMacrotask;

interface Client {
  sink: RecordingSink;
  conn: TerminalConnection;
}

function setup(overrides: Partial<TerminalServiceOptions> = {}) {
  const timers = createManualTimers();
  const base = Date.parse(SAMPLE_TIME);
  const fake = createFakePtyFactory();
  const entries = new Map<EntryId, TerminalEntryInfo>([
    [ENTRY, { cwd: CWD, archived: false }],
    [OTHER, { cwd: CWD, archived: false }],
  ]);
  const service = createTerminalService({
    pty: fake,
    entry: (id) => entries.get(id) ?? null,
    settings: () => DEFAULT_CONSOLE_SETTINGS,
    now: () => base + timers.elapsed(),
    timers,
    logger: createLogger({ level: 'silent' }),
    checkCwd: () => Promise.resolve(),
    launch: (kind) => Promise.resolve({ executablePath: EXE[kind], args: [], env: { PATH: 'C:\\Windows' } }),
    ...overrides,
  });

  const connect = (entryId: EntryId = ENTRY): Client => {
    const sink = recordingSink();
    const conn = service.connect(entryId, sink);
    if ('code' in conn) throw new Error(conn.code);
    return { sink, conn };
  };

  const open = async (
    client: Client,
    requestId = 'r1',
    shell: ShellKind = 'cmd',
    size: { cols: number; rows: number } = { cols: 80, rows: 24 },
  ): Promise<TerminalInfo> => {
    client.conn.handle({ type: 'open', requestId, shell, ...size });
    await flush();
    const opened = client.sink.of('opened').find((m) => m.requestId === requestId);
    if (opened === undefined) {
      const error = client.sink.of('error').find((m) => m.requestId === requestId);
      throw new Error(`not opened: ${error?.error.code ?? 'no answer'}`);
    }
    return opened.terminal;
  };

  const lastPty = (): FakePtyProcess => {
    const pty = fake.spawned.at(-1);
    if (pty === undefined) throw new Error('nothing spawned');
    return pty;
  };

  /** Answer of a failed open. */
  const openError = async (client: Client, requestId = 'r1'): Promise<ErrorPayload | undefined> => {
    client.conn.handle({ type: 'open', requestId, shell: 'cmd', cols: 80, rows: 24 });
    await flush();
    return client.sink.of('error').find((m) => m.requestId === requestId)?.error;
  };

  return { service, timers, fake, entries, connect, open, openError, lastPty };
}

describe('createTerminalService – connect and open (WP-99)', () => {
  it('rejects an unknown entry and greets a known one with welcome and terminals', () => {
    const { service, connect } = setup();
    expect(service.available).toBe(true);
    expect(service.connect(sampleId('en', 9), recordingSink())).toEqual(makeError('ENTRY_NOT_FOUND'));
    const { sink } = connect();
    expect(sink.messages).toEqual([
      {
        type: 'welcome',
        protocol: TERMINAL_PROTOCOL_VERSION,
        available: true,
        error: null,
        limits: { perEntry: TERMINAL_LIMITS.perEntry, total: TERMINAL_LIMITS.total },
      },
      { type: 'terminals', items: [] },
    ]);
  });

  it('reports a missing pseudo console in welcome and on open', async () => {
    const { service, connect, openError } = setup({ pty: null, unavailableReason: 'ffi' });
    expect(service.available).toBe(false);
    const client = connect();
    expect(client.sink.of('welcome')[0]).toMatchObject({
      available: false,
      error: makeError('TERMINAL_UNAVAILABLE', { reason: 'ffi' }),
    });
    expect(await openError(client)).toEqual(makeError('TERMINAL_UNAVAILABLE', { reason: 'ffi' }));
  });

  it('opens a shell, answers opened and pushes the list to every socket of the entry', async () => {
    const { connect, open, lastPty } = setup();
    const a = connect();
    const b = connect();
    const other = connect(OTHER);
    const info = await open(a, 'req-1', 'powershell', { cols: 100, rows: 30 });
    expect(terminalIdSchema.safeParse(info.terminalId).success).toBe(true);
    expect(info).toEqual({
      terminalId: info.terminalId,
      entryId: ENTRY,
      shell: 'powershell',
      cwd: CWD,
      createdAt: SAMPLE_TIME,
      cols: 100,
      rows: 30,
      state: 'running',
      exitCode: null,
    });
    expect(lastPty().options).toEqual({
      executablePath: EXE.powershell,
      args: [],
      cwd: CWD,
      env: { PATH: 'C:\\Windows' },
      cols: 100,
      rows: 30,
    });
    expect(a.sink.of('terminals').at(-1)?.items).toEqual([info]);
    expect(b.sink.of('terminals').at(-1)?.items).toEqual([info]);
    expect(b.sink.of('opened')).toEqual([]);
    expect(other.sink.of('terminals')).toEqual([{ type: 'terminals', items: [] }]);
  });

  it('refuses archived and removed entries', async () => {
    const { connect, entries, openError } = setup();
    const client = connect();
    entries.set(ENTRY, { cwd: CWD, archived: true });
    expect(await openError(client, 'a')).toEqual(makeError('SESSION_ARCHIVED'));
    entries.delete(ENTRY);
    expect(await openError(client, 'b')).toEqual(makeError('ENTRY_NOT_FOUND'));
  });

  it('limits terminals per entry, counting exited ones and opens in flight', async () => {
    const { connect, open, openError, timers, lastPty } = setup();
    const client = connect();
    const first = await open(client, 'r0');
    lastPty().exit(0);
    timers.advance(EXIT_DRAIN_MAX_MS + POLL_IDLE_MS);
    expect(client.sink.of('terminals').at(-1)?.items[0]).toMatchObject({
      terminalId: first.terminalId,
      state: 'exited',
    });
    // Four opens at once: three fit next to the exited one, the fourth is refused.
    for (const id of ['r1', 'r2', 'r3', 'r4']) {
      client.conn.handle({ type: 'open', requestId: id, shell: 'cmd', cols: 80, rows: 24 });
    }
    await flush();
    expect(client.sink.of('opened').map((m) => m.requestId)).toEqual(['r0', 'r1', 'r2', 'r3']);
    expect(client.sink.of('error')).toEqual([
      {
        type: 'error',
        requestId: 'r4',
        error: makeError('TERMINAL_LIMIT_REACHED', { scope: 'entry', max: TERMINAL_LIMITS.perEntry }),
      },
    ]);
    expect(await openError(client, 'r5')).toMatchObject({ code: 'TERMINAL_LIMIT_REACHED' });
  });

  it('limits terminals on this computer', async () => {
    const ids = Array.from({ length: 5 }, (_, i) => sampleId('en', 10 + i));
    const { connect, entries, open, openError } = setup();
    for (const id of ids) entries.set(id, { cwd: CWD, archived: false });
    const clients = ids.map((id) => connect(id));
    for (const [index, client] of clients.slice(0, 4).entries()) {
      for (let n = 0; n < TERMINAL_LIMITS.perEntry; n += 1)
        await open(client, `r${String(index)}-${String(n)}`);
    }
    const last = clients[4];
    if (last === undefined) throw new Error('missing client');
    expect(await openError(last)).toEqual(
      makeError('TERMINAL_LIMIT_REACHED', { scope: 'total', max: TERMINAL_LIMITS.total }),
    );
  });

  it('passes check errors through and scrubs start failures', async () => {
    const cwdFailure = setup({
      checkCwd: () => Promise.reject(new CommandError(makeError('CWD_NOT_FOUND'))),
    });
    expect(await cwdFailure.openError(cwdFailure.connect())).toEqual(makeError('CWD_NOT_FOUND'));

    const noGit = setup({
      launch: () => Promise.reject(new CommandError(makeError('SHELL_NOT_FOUND', { shell: 'gitbash' }))),
    });
    expect(await noGit.openError(noGit.connect())).toEqual(
      makeError('SHELL_NOT_FOUND', { shell: 'gitbash' }),
    );

    const conPtyFailure = setup({
      pty: {
        spawn: () => {
          throw new ConPtyError('CreateProcessW', 2);
        },
      },
    });
    expect(await conPtyFailure.openError(conPtyFailure.connect())).toEqual(
      makeError('TERMINAL_START_FAILED', { reason: 'CreateProcessW (2)' }),
    );

    const otherFailure = setup({
      pty: {
        spawn: () => {
          throw new Error(`cannot start ${EXE.cmd} in ${CWD}`);
        },
      },
    });
    const error = await otherFailure.openError(otherFailure.connect());
    expect(error).toEqual(makeError('TERMINAL_START_FAILED', { reason: 'spawn' }));
    expect(JSON.stringify(error)).not.toContain('Projects');
  });
});

describe('createTerminalService – attach and output (WP-99)', () => {
  it('assigns the lowest free channel, keeps it on re-attach and frees it on detach', async () => {
    const { connect, open } = setup();
    const client = connect();
    const t1 = await open(client, 'a');
    const t2 = await open(client, 'b');
    const t3 = await open(client, 'c');
    const attach = (terminalId: string) => {
      client.conn.handle({ type: 'attach', terminalId, cols: 80, rows: 24 });
      return client.sink.of('attached').at(-1)?.channel;
    };
    expect(attach(t1.terminalId)).toBe(0);
    expect(attach(t2.terminalId)).toBe(1);
    expect(attach(t1.terminalId)).toBe(0);
    client.conn.handle({ type: 'detach', terminalId: t1.terminalId });
    expect(attach(t3.terminalId)).toBe(0);
    expect(attach(t1.terminalId)).toBe(2);
  });

  it('refuses terminals of another entry and unknown ones', async () => {
    const { connect, open } = setup();
    const owner = connect();
    const stranger = connect(OTHER);
    const info = await open(owner);
    for (const message of [
      { type: 'attach', terminalId: info.terminalId, cols: 80, rows: 24 },
      { type: 'input', terminalId: info.terminalId, data: 'x' },
      { type: 'resize', terminalId: info.terminalId, cols: 80, rows: 24 },
      { type: 'close', terminalId: info.terminalId },
    ] as const) {
      stranger.conn.handle(message);
    }
    const expected = {
      type: 'error',
      terminalId: info.terminalId,
      error: makeError('TERMINAL_NOT_FOUND', { terminalId: info.terminalId }),
    };
    expect(stranger.sink.of('error')).toEqual([expected, expected, expected, expected]);
    expect(owner.sink.of('exit')).toEqual([]);
  });

  it('replays the ring on attach, then resizes and nudges a running shell', async () => {
    const { connect, open, timers, lastPty } = setup();
    const client = connect();
    const info = await open(client);
    timers.advance(POLL_ACTIVE_MS);
    const pty = lastPty();
    client.conn.handle({ type: 'attach', terminalId: info.terminalId, cols: 120, rows: 40 });
    expect(client.sink.text(0)).toBe(PROMPT);
    expect(pty.resizes).toEqual([
      [120, 40],
      [121, 40],
      [120, 40],
    ]);
    // The info follows the attach size.
    client.conn.handle({ type: 'resize', terminalId: info.terminalId, cols: 90, rows: 20 });
    expect(pty.resizes.at(-1)).toEqual([90, 20]);
    expect(
      (() => {
        const other = connect();
        return other.sink.of('terminals')[0]?.items[0];
      })(),
    ).toMatchObject({ cols: 90, rows: 20 });
  });

  it('nudges one column narrower at the maximum width', async () => {
    const { connect, open, lastPty } = setup();
    const client = connect();
    const info = await open(client);
    client.conn.handle({
      type: 'attach',
      terminalId: info.terminalId,
      cols: TERMINAL_LIMITS.colsMax,
      rows: 24,
    });
    expect(lastPty().resizes).toEqual([
      [TERMINAL_LIMITS.colsMax, 24],
      [TERMINAL_LIMITS.colsMax - 1, 24],
      [TERMINAL_LIMITS.colsMax, 24],
    ]);
  });

  it('splits a large replay into frames of at most 64 KiB', async () => {
    const { connect, open, timers, lastPty } = setup();
    const client = connect();
    const info = await open(client);
    const pty = lastPty();
    pty.write('flood 30000\r');
    for (let i = 0; i < 40; i += 1) timers.advance(POLL_ACTIVE_MS);
    client.conn.handle({ type: 'attach', terminalId: info.terminalId, cols: 80, rows: 24 });
    const replay = client.sink.frames;
    const total = replay.reduce((sum, f) => sum + f.data.length, 0);
    expect(total).toBeLessThanOrEqual(TERMINAL_LIMITS.scrollbackBytes);
    expect(total).toBeGreaterThan(TERMINAL_LIMITS.scrollbackBytes - 4096);
    expect(replay.length).toBe(Math.ceil(total / TERMINAL_FRAME_BYTES));
    expect(replay.length).toBeGreaterThan(1);
    // The trimmed replay starts at a line.
    expect(client.sink.text(0).startsWith('line ')).toBe(true);
    expect(client.sink.text(0).endsWith(PROMPT)).toBe(true);
  });

  it('sends one frame per socket and terminal per tick, and wakes the poller on input', async () => {
    const { connect, open, timers, lastPty } = setup();
    const a = connect();
    const b = connect();
    const info = await open(a);
    a.conn.handle({ type: 'attach', terminalId: info.terminalId, cols: 80, rows: 24 });
    b.conn.handle({ type: 'attach', terminalId: info.terminalId, cols: 80, rows: 24 });
    timers.advance(POLL_ACTIVE_MS);
    a.sink.frames.length = 0;
    b.sink.frames.length = 0;
    const pty = lastPty();
    // Let the poller fall back to the idle cadence.
    timers.advance(POLL_ACTIVE_MS);
    expect(timers.pending().map((t) => t.ms)).toEqual([POLL_IDLE_MS]);
    pty.emit('one ');
    pty.emit('two ');
    a.conn.handle({ type: 'input', terminalId: info.terminalId, data: 'x' });
    // Input pulls the next tick forward to 16 ms.
    expect(timers.pending().map((t) => t.ms)).toEqual([POLL_ACTIVE_MS]);
    timers.advance(POLL_ACTIVE_MS);
    expect(a.sink.frames).toHaveLength(1);
    expect(b.sink.frames).toHaveLength(1);
    expect(a.sink.text(0)).toBe('one two x');
    expect(pty.writes).toEqual(['x']);
  });

  it('never logs input content', async () => {
    const lines: string[] = [];
    const logger = createLogger({
      level: 'trace',
      destination: { write: (line: string) => lines.push(line) },
    });
    const { connect, open, timers } = setup({ logger });
    const client = connect();
    const info = await open(client);
    client.conn.handle({ type: 'input', terminalId: info.terminalId, data: 'secret-typed-text\r' });
    timers.advance(POLL_ACTIVE_MS);
    client.conn.handle({ type: 'close', terminalId: info.terminalId });
    client.conn.handle({ type: 'input', terminalId: info.terminalId, data: 'secret-typed-text' });
    expect(lines.length).toBeGreaterThan(0);
    expect(lines.join('\n')).not.toContain('secret-typed-text');
  });

  it('keeps the shell running after disconnect and replays to the next socket', async () => {
    const { connect, open, timers, lastPty } = setup();
    const first = connect();
    const info = await open(first);
    first.conn.handle({ type: 'attach', terminalId: info.terminalId, cols: 80, rows: 24 });
    first.conn.disconnect();
    lastPty().emit('while away');
    timers.advance(POLL_ACTIVE_MS);
    expect(first.sink.text(0)).toBe('');
    expect(lastPty().closed).toBe(false);
    const second = connect();
    expect(second.sink.of('terminals')[0]?.items.map((t) => t.terminalId)).toEqual([info.terminalId]);
    second.conn.handle({ type: 'attach', terminalId: info.terminalId, cols: 80, rows: 24 });
    expect(second.sink.text(0)).toBe(`${PROMPT}while away`);
  });
});

describe('createTerminalService – backpressure (WP-99)', () => {
  it('stops reading a slow socket’s terminals and resumes below the low mark', async () => {
    const { connect, open, timers, lastPty } = setup();
    const client = connect();
    const info = await open(client);
    client.conn.handle({ type: 'attach', terminalId: info.terminalId, cols: 80, rows: 24 });
    timers.advance(POLL_ACTIVE_MS);
    client.sink.frames.length = 0;
    const pty = lastPty();
    client.sink.buffered = TERMINAL_BACKPRESSURE.pauseBytes + 1;
    pty.emit('held back');
    timers.advance(POLL_IDLE_MS);
    expect(client.sink.frames).toHaveLength(0);
    expect(pty.pendingBytes()).toBe('held back'.length);
    // Between the marks: still paused.
    client.sink.buffered = TERMINAL_BACKPRESSURE.resumeBytes + 1;
    timers.advance(POLL_IDLE_MS);
    expect(client.sink.frames).toHaveLength(0);
    client.sink.buffered = TERMINAL_BACKPRESSURE.resumeBytes - 1;
    timers.advance(POLL_IDLE_MS);
    expect(client.sink.text(0)).toBe('held back');
    expect(client.sink.closedWith).toBeNull();
  });

  it('closes a socket over the high mark with 1013', async () => {
    const { connect, open, timers, lastPty } = setup();
    const client = connect();
    const info = await open(client);
    client.conn.handle({ type: 'attach', terminalId: info.terminalId, cols: 80, rows: 24 });
    client.sink.buffered = TERMINAL_BACKPRESSURE.closeBytes + 1;
    timers.advance(POLL_ACTIVE_MS);
    expect(client.sink.closedWith?.code).toBe(TERMINAL_CLOSE_CODES.overloaded);
    // Its terminals are read again (the socket is gone).
    lastPty().emit('more');
    timers.advance(POLL_IDLE_MS);
    expect(lastPty().pendingBytes()).toBe(0);
  });

  it('closes a socket that stays paused longer than 30 s', async () => {
    const { connect, open, timers } = setup();
    const client = connect();
    const info = await open(client);
    client.conn.handle({ type: 'attach', terminalId: info.terminalId, cols: 80, rows: 24 });
    client.sink.buffered = TERMINAL_BACKPRESSURE.pauseBytes + 1;
    timers.advance(TERMINAL_BACKPRESSURE.pauseMaxMs);
    expect(client.sink.closedWith).toBeNull();
    timers.advance(POLL_IDLE_MS * 2);
    expect(client.sink.closedWith).toEqual({ code: TERMINAL_CLOSE_CODES.overloaded, reason: 'overloaded' });
  });
});

describe('createTerminalService – exit and close (WP-99)', () => {
  it('drains, closes and lists an exited shell; a later attach replays its end', async () => {
    const { connect, open, timers, lastPty } = setup();
    const client = connect();
    const watcher = connect();
    const info = await open(client);
    client.conn.handle({ type: 'attach', terminalId: info.terminalId, cols: 80, rows: 24 });
    const pty = lastPty();
    client.conn.handle({ type: 'input', terminalId: info.terminalId, data: 'echo bye\rexit 3\r' });
    timers.advance(POLL_ACTIVE_MS);
    expect(client.sink.of('exit')).toEqual([]);
    for (let i = 0; i < 10; i += 1) timers.advance(POLL_ACTIVE_MS);
    const exit = { type: 'exit', terminalId: info.terminalId, exitCode: 3, reason: 'exited' };
    expect(client.sink.of('exit')).toEqual([exit]);
    expect(watcher.sink.of('exit')).toEqual([exit]);
    expect(watcher.sink.of('terminals').at(-1)?.items).toEqual([{ ...info, state: 'exited', exitCode: 3 }]);
    expect(pty.closed).toBe(true);
    // Input to an exited shell is dropped quietly.
    client.conn.handle({ type: 'input', terminalId: info.terminalId, data: 'x' });
    expect(client.sink.of('error')).toEqual([]);
    expect(pty.writes).toEqual(['echo bye\rexit 3\r']);
    // The poller stops with no running shell.
    expect(timers.pending()).toEqual([]);
    const late = connect();
    late.conn.handle({ type: 'attach', terminalId: info.terminalId, cols: 80, rows: 24 });
    expect(late.sink.text(0)).toBe(`${PROMPT}echo bye\r\nbye\r\n${PROMPT}exit 3\r\n`);
    expect(pty.resizes).toEqual([
      [80, 24],
      [81, 24],
      [80, 24],
    ]);
  });

  it('closes a terminal on request: exit reason closed and a new list', async () => {
    const { connect, open, lastPty } = setup();
    const client = connect();
    const watcher = connect();
    const keep = await open(client, 'a');
    const info = await open(client, 'b');
    client.conn.handle({ type: 'attach', terminalId: info.terminalId, cols: 80, rows: 24 });
    client.conn.handle({ type: 'close', terminalId: info.terminalId });
    expect(lastPty().closed).toBe(true);
    const exit = { type: 'exit', terminalId: info.terminalId, exitCode: null, reason: 'closed' };
    expect(watcher.sink.of('exit')).toEqual([exit]);
    expect(watcher.sink.of('terminals').at(-1)?.items).toEqual([keep]);
    client.conn.handle({ type: 'close', terminalId: info.terminalId });
    expect(client.sink.of('error').at(-1)?.error).toEqual(
      makeError('TERMINAL_NOT_FOUND', { terminalId: info.terminalId }),
    );
    // The channel is free again.
    client.conn.handle({ type: 'attach', terminalId: keep.terminalId, cols: 80, rows: 24 });
    expect(client.sink.of('attached').at(-1)?.channel).toBe(0);
  });

  it('closeEntry ends the entry’s terminals, pushes the empty list and fails opens in flight', async () => {
    let releaseCwd: () => void = () => undefined;
    let slow = false;
    const { service, connect, open, fake } = setup({
      checkCwd: () =>
        slow
          ? new Promise<void>((resolve) => {
              releaseCwd = resolve;
            })
          : Promise.resolve(),
    });
    const client = connect();
    const other = connect(OTHER);
    const a = await open(client, 'a');
    const b = await open(client, 'b');
    const foreign = await open(other, 'x');
    slow = true;
    client.conn.handle({ type: 'open', requestId: 'late', shell: 'cmd', cols: 80, rows: 24 });
    await flush();
    service.closeEntry(ENTRY, 'archived');
    expect(client.sink.of('exit')).toEqual([
      { type: 'exit', terminalId: a.terminalId, exitCode: null, reason: 'archived' },
      { type: 'exit', terminalId: b.terminalId, exitCode: null, reason: 'archived' },
    ]);
    expect(client.sink.of('terminals').at(-1)?.items).toEqual([]);
    expect(service.list(OTHER)).toEqual([foreign]);
    releaseCwd();
    await flush();
    expect(client.sink.of('error')).toEqual([
      { type: 'error', requestId: 'late', error: makeError('SESSION_ARCHIVED') },
    ]);
    expect(fake.spawned.filter((p) => !p.closed)).toHaveLength(1);
    service.closeEntry(OTHER, 'removed');
    expect(other.sink.of('exit').at(-1)?.reason).toBe('removed');
  });

  it('closeAll ends every terminal and refuses new ones', async () => {
    const { service, connect, open, openError, fake } = setup();
    const a = connect();
    const b = connect(OTHER);
    await open(a, 'a');
    await open(b, 'b');
    await service.closeAll();
    expect(a.sink.of('exit').map((m) => m.reason)).toEqual(['shutdown']);
    expect(b.sink.of('exit').map((m) => m.reason)).toEqual(['shutdown']);
    expect(fake.spawned.every((p) => p.closed)).toBe(true);
    expect(await openError(a, 'later')).toEqual(makeError('TERMINAL_UNAVAILABLE', { reason: 'disabled' }));
  });

  it('kills the tree of a shell still running 2 s after close', async () => {
    const fake = createFakePtyFactory();
    const alive = new Set([4242, 4243]);
    const killTree = vi.fn((pid: number) => {
      alive.delete(pid);
      return Promise.resolve();
    });
    let nextPid = 4242;
    // The fake's methods are closures, so a copy with a pid behaves the same. Liveness comes from
    // `exitCode()` (as with ConPTY after `close()`), never from the bare pid.
    const pty: PtyFactory = {
      spawn: (options) => {
        const pid = nextPid++;
        return { ...fake.spawn(options), pid, exitCode: () => (alive.has(pid) ? null : 0) };
      },
    };
    const { service, connect, open, timers } = setup({ pty, killTree });
    const client = connect();
    await open(client, 'a');
    await open(client, 'b');
    // 4243 ends on its own shortly after the close; 4242 hangs.
    const done = service.closeAll();
    let settled = false;
    void done.then(() => {
      settled = true;
    });
    timers.advance(300);
    alive.delete(4243);
    for (let elapsed = 300; elapsed <= KILL_FALLBACK_MS + 200; elapsed += 100) {
      await flush();
      timers.advance(100);
    }
    await flush();
    await done;
    expect(settled).toBe(true);
    expect(killTree).toHaveBeenCalledTimes(1);
    expect(killTree).toHaveBeenCalledWith(4242);
  });
});
