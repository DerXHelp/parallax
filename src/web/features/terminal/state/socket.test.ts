import { afterEach, describe, expect, it, vi } from 'vitest';
import { SAMPLE_IDS } from '@shared/samples';
import { TERMINAL_CLOSE_CODES, TERMINAL_LIMITS, TERMINAL_PROTOCOL_VERSION } from '@shared/terminal';
import {
  createFakeSocketFactory,
  sampleTerminalId,
  sampleTerminalInfo,
  TERMINAL_SOCKET_URL,
  type FakeTerminalSocket,
} from '../testing';
import { splitInput, TerminalConnection, terminalSocketUrl, type TerminalViewSink } from './socket';

const LIMITS = { perEntry: TERMINAL_LIMITS.perEntry, total: TERMINAL_LIMITS.total };

let connection: TerminalConnection | null = null;

afterEach(() => {
  connection?.dispose();
  connection = null;
  vi.useRealTimers();
});

function setup() {
  const sockets = createFakeSocketFactory();
  const created = new TerminalConnection({
    entryId: SAMPLE_IDS.entry,
    url: TERMINAL_SOCKET_URL,
    createSocket: sockets.factory,
    // 0.5 = the exact base delay of the backoff (500 ms, 1 s, …).
    random: () => 0.5,
  });
  connection = created;
  const socket = (index: number): FakeTerminalSocket => {
    const found = sockets.sockets[index];
    if (found === undefined) throw new Error(`no socket ${String(index)}`);
    return found;
  };
  return { connection: created, sockets: sockets.sockets, socket };
}

function welcome(socket: FakeTerminalSocket, available = true) {
  socket.serverSend({
    type: 'welcome',
    protocol: TERMINAL_PROTOCOL_VERSION,
    available,
    error: available ? null : { code: 'TERMINAL_UNAVAILABLE', params: { reason: 'ffi' } },
    limits: LIMITS,
  });
}

/** The server's list right after `welcome` (views attach only to terminals in it). */
function listed(socket: FakeTerminalSocket, ...numbers: number[]) {
  socket.serverSend({
    type: 'terminals',
    items: numbers.map((n) => sampleTerminalInfo({ terminalId: sampleTerminalId(n) })),
  });
}

function sink(cols = 100, rows = 30) {
  const output: string[] = [];
  const decoder = new TextDecoder();
  const view: TerminalViewSink & { attachedCount: number } = {
    attachedCount: 0,
    size: () => ({ cols, rows }),
    onAttached: () => {
      view.attachedCount++;
      output.length = 0;
    },
    onOutput: (data) => {
      output.push(decoder.decode(data));
    },
  };
  return { view, output };
}

describe('terminal socket (WP-99b)', () => {
  it('builds the URL like the main connection', () => {
    expect(terminalSocketUrl({ protocol: 'http:', host: '127.0.0.1:4712' })).toBe(
      'ws://127.0.0.1:4712/api/terminal/ws',
    );
  });

  it('sends hello with the protocol version and the entry once the socket is open', () => {
    const { connection, sockets, socket } = setup();
    connection.start();
    expect(sockets).toHaveLength(1);
    expect(socket(0).url).toBe(TERMINAL_SOCKET_URL);
    expect(socket(0).sent).toEqual([]);
    socket(0).open();
    expect(socket(0).sent).toEqual([
      { type: 'hello', protocol: TERMINAL_PROTOCOL_VERSION, entryId: SAMPLE_IDS.entry },
    ]);
    expect(connection.status).toBe('connecting');
    welcome(socket(0));
    expect(connection.status).toBe('open');
    expect(connection.isReady).toBe(true);
  });

  it('ignores (and counts) invalid text frames', () => {
    const { connection, socket } = setup();
    const messages = vi.fn();
    connection.onMessage(messages);
    connection.start();
    socket(0).open();
    socket(0).serverSendRaw('not json');
    socket(0).serverSendRaw(JSON.stringify({ type: 'telemetry', value: 1 }));
    socket(0).serverSendRaw(JSON.stringify({ type: 'attached', terminalId: 'tm_bad', channel: 1 }));
    socket(0).serverSendRaw(
      JSON.stringify({ type: 'terminals', items: [{ terminalId: sampleTerminalId(1) }] }),
    );
    expect(connection.ignored).toBe(4);
    expect(messages).not.toHaveBeenCalled();
    socket(0).serverSend({ type: 'terminals', items: [sampleTerminalInfo()] });
    expect(messages).toHaveBeenCalledTimes(1);
    expect(connection.ignored).toBe(4);
  });

  it('attaches views after welcome and the list, and routes binary frames by channel', () => {
    const { connection, socket } = setup();
    const first = sink(100, 30);
    const second = sink(90, 20);
    connection.attachView(sampleTerminalId(1), first.view);
    connection.start();
    socket(0).open();
    // Nothing before welcome and the list.
    expect(socket(0).sentOfType('attach')).toEqual([]);
    welcome(socket(0));
    expect(socket(0).sentOfType('attach')).toEqual([]);
    listed(socket(0), 1);
    expect(socket(0).sentOfType('attach')).toEqual([
      { type: 'attach', terminalId: sampleTerminalId(1), cols: 100, rows: 30 },
    ]);
    // Later lists attach nothing again.
    listed(socket(0), 1, 2);
    expect(socket(0).sentOfType('attach')).toHaveLength(1);
    // A view registered after the list is attached at once.
    connection.attachView(sampleTerminalId(2), second.view);
    expect(socket(0).sentOfType('attach').at(-1)).toEqual({
      type: 'attach',
      terminalId: sampleTerminalId(2),
      cols: 90,
      rows: 20,
    });

    socket(0).serverSend({ type: 'attached', terminalId: sampleTerminalId(1), channel: 3 });
    socket(0).serverSend({ type: 'attached', terminalId: sampleTerminalId(2), channel: 7 });
    expect(first.view.attachedCount).toBe(1);
    socket(0).serverBinary(3, 'C:\\work> ');
    socket(0).serverBinary(7, 'PS C:\\work> ');
    socket(0).serverBinary(9, 'nobody listens');
    socket(0).serverBinaryRaw(new Uint8Array(0));
    expect(first.output).toEqual(['C:\\work> ']);
    expect(second.output).toEqual(['PS C:\\work> ']);

    // Input and resize go out for attached terminals.
    connection.input(sampleTerminalId(1), 'dir\r');
    connection.resize(sampleTerminalId(1), { cols: 120, rows: 40 });
    expect(socket(0).sent.slice(-2)).toEqual([
      { type: 'input', terminalId: sampleTerminalId(1), data: 'dir\r' },
      { type: 'resize', terminalId: sampleTerminalId(1), cols: 120, rows: 40 },
    ]);
  });

  it('detaches a view: `detach` goes out, its channel is no longer routed', () => {
    const { connection, socket } = setup();
    const view = sink();
    const detach = connection.attachView(sampleTerminalId(1), view.view);
    connection.start();
    socket(0).open();
    welcome(socket(0));
    listed(socket(0), 1);
    socket(0).serverSend({ type: 'attached', terminalId: sampleTerminalId(1), channel: 0 });
    detach();
    expect(socket(0).sentOfType('detach')).toEqual([{ type: 'detach', terminalId: sampleTerminalId(1) }]);
    socket(0).serverBinary(0, 'late output');
    expect(view.output).toEqual([]);
  });

  it('reconnects with backoff, says hello again and re-attaches the mounted views still listed', () => {
    vi.useFakeTimers();
    const { connection, sockets, socket } = setup();
    const view = sink(100, 30);
    const gone = sink(80, 24);
    const statuses: string[] = [];
    connection.onStatus((status) => statuses.push(status));
    connection.attachView(sampleTerminalId(1), view.view);
    connection.attachView(sampleTerminalId(2), gone.view);
    connection.start();
    socket(0).open();
    welcome(socket(0));
    listed(socket(0), 1, 2);
    socket(0).serverSend({ type: 'attached', terminalId: sampleTerminalId(1), channel: 0 });
    socket(0).serverBinary(0, 'before');

    socket(0).serverClose(TERMINAL_CLOSE_CODES.overloaded);
    expect(connection.status).toBe('reconnecting');
    expect(connection.isReady).toBe(false);
    // Output of the old socket's channel is gone, nothing goes out meanwhile.
    expect(connection.send({ type: 'detach', terminalId: sampleTerminalId(1) })).toBe(false);
    vi.advanceTimersByTime(499);
    expect(sockets).toHaveLength(1);
    vi.advanceTimersByTime(1);
    expect(sockets).toHaveLength(2);

    socket(1).open();
    expect(socket(1).sent).toEqual([
      { type: 'hello', protocol: TERMINAL_PROTOCOL_VERSION, entryId: SAMPLE_IDS.entry },
    ]);
    welcome(socket(1));
    expect(socket(1).sentOfType('attach')).toEqual([]);
    // Terminal 2 is gone on the server (e.g. after a restart): no attach, so no TERMINAL_NOT_FOUND.
    listed(socket(1), 1);
    expect(socket(1).sentOfType('attach')).toEqual([
      { type: 'attach', terminalId: sampleTerminalId(1), cols: 100, rows: 30 },
    ]);
    socket(1).serverSend({ type: 'attached', terminalId: sampleTerminalId(1), channel: 5 });
    // The view clears its screen; the replay follows on the new channel.
    expect(view.view.attachedCount).toBe(2);
    socket(1).serverBinary(5, 'replay');
    expect(view.output).toEqual(['replay']);
    expect(statuses).toEqual(['open', 'reconnecting', 'open']);

    // welcome reset the attempt counter: the next loss waits the first delay (500 ms) again.
    socket(1).serverClose();
    vi.advanceTimersByTime(500);
    expect(sockets).toHaveLength(3);
  });

  it('backs off further while attempts keep failing', () => {
    vi.useFakeTimers();
    const { connection, sockets, socket } = setup();
    connection.start();
    socket(0).serverClose();
    vi.advanceTimersByTime(500);
    expect(sockets).toHaveLength(2);
    socket(1).serverClose();
    vi.advanceTimersByTime(999);
    expect(sockets).toHaveLength(2);
    vi.advanceTimersByTime(1);
    expect(sockets).toHaveLength(3);
  });

  it('gives up for good on "entry not found" and "protocol"', () => {
    vi.useFakeTimers();
    for (const code of [TERMINAL_CLOSE_CODES.entryNotFound, TERMINAL_CLOSE_CODES.protocol]) {
      const { connection, sockets, socket } = setup();
      connection.start();
      socket(0).open();
      socket(0).serverClose(code);
      expect(connection.status).toBe('failed');
      expect(connection.closeCode).toBe(code);
      vi.advanceTimersByTime(60_000);
      expect(sockets).toHaveLength(1);
      connection.dispose();
    }
  });

  it('dispose closes the socket and never reconnects', () => {
    vi.useFakeTimers();
    const { connection, sockets, socket } = setup();
    connection.start();
    socket(0).open();
    connection.dispose();
    expect(socket(0).closedWith).toBe(1000);
    // A late close event of the old socket is ignored.
    socket(0).serverClose(1000);
    vi.advanceTimersByTime(60_000);
    expect(sockets).toHaveLength(1);
  });

  it('a welcome without availability attaches nothing', () => {
    const { connection, socket } = setup();
    connection.attachView(sampleTerminalId(1), sink().view);
    connection.start();
    socket(0).open();
    welcome(socket(0), false);
    listed(socket(0), 1);
    expect(connection.isReady).toBe(false);
    expect(socket(0).sentOfType('attach')).toEqual([]);
  });

  it('splits long input at the message limit without breaking a surrogate pair', () => {
    expect(splitInput('abcdef', 4)).toEqual(['abcd', 'ef']);
    expect(splitInput('ab😀cd', 3)).toEqual(['ab', '😀c', 'd']);
    const long = 'x'.repeat(TERMINAL_LIMITS.inputMaxChars + 10);
    expect(splitInput(long).map((part) => part.length)).toEqual([TERMINAL_LIMITS.inputMaxChars, 10]);
    expect(splitInput('')).toEqual([]);
  });
});
