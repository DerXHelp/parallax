/**
 * One forwarded window connection (docs/wp/WP-76.md §B.6 "Vermittler"): the browser's WebSocket on
 * `/api/hosts/:hostId/ws` and exactly one connection to the other computer for it (opened by the
 * forwarder over the coupling's pinned agent). Frames pass 1:1 – text stays text, binary stays
 * binary, nothing is parsed or changed; `maxPayload` holds on both sides (the app's WebSocket
 * plugin, REMOTE_WS_CLIENT_OPTIONS).
 *
 * Close codes: the other side's end becomes WS_CLOSE.HOST_* for the browser (`browserCloseCode`),
 * a connection that could not be made the code of its error (`forwarderErrorCloseCode`); the
 * browser's end closes the connection to the other computer. A browser that stops answering pings
 * is dropped, so is another computer that sends nothing (no message, no ping of its hub) for
 * `upstreamIdleMs`; a side that cannot keep up (buffered bytes) closes both like the hub does (1013).
 *
 * WP-107 (E3): the embedded terminal of the other computer uses the same bridge with `flow`
 * (`bridgeTerminal`): a browser that falls behind pauses the other side's socket instead of closing
 * (TCP then holds the other computer's terminal output, which pauses its pty reader); reading resumes
 * below `resumeBytes`, the bridge closes with 1013 above `closeBytes` or after `pauseMaxMs` paused.
 * Frames are never parsed nor logged (terminal input and output are private).
 */
import type { Logger } from 'pino';
import { WebSocket, type RawData } from 'ws';
import { makeError, type ErrorPayload } from '@shared/errors';
import { WS_CLOSE } from '@shared/protocol';
import { HostForwarderError } from '../hosts/ports';
import { browserCloseCode, closeReason, forwarderErrorCloseCode } from '../hosts/windows';
import { TERMINAL_BACKPRESSURE } from '../terminal/service';

export interface BridgeLimits {
  /** Browser messages kept while the other computer is being connected (more → protocol error). */
  earlyMessages: number;
  /** Unsent bytes towards a side before the connection counts as too slow (as HUB_LIMITS). */
  maxBufferedBytes: number;
  /** Ping interval towards the browser; a missing pong by the next tick drops it. */
  heartbeatMs: number;
  /** The other computer's hub pings every 30 s: silence this long ends the window (two misses + margin). */
  upstreamIdleMs: number;
}

export const BRIDGE_LIMITS: BridgeLimits = {
  earlyMessages: 16,
  maxBufferedBytes: 16 * 1024 * 1024,
  heartbeatMs: 30_000,
  upstreamIdleMs: 75_000,
};

/** Same code as the hub's slow consumer: the window reconnects and gets a snapshot. */
const SLOW_CONSUMER = 1013;
/** Normal close towards the other computer (the browser went away). */
const NORMAL = 1000;

/** WP-107: pause instead of close towards the browser (terminal output). */
export interface BridgeFlow {
  /** Browser backlog above which the other side's socket is paused. */
  pauseBytes: number;
  /** … and below which it reads again. */
  resumeBytes: number;
  /** Backlog that closes the bridge (1013). */
  closeBytes: number;
  /** Paused longer than this closes the bridge (1013). */
  pauseMaxMs: number;
  /** How often a paused bridge looks at the browser's backlog. */
  pollMs: number;
}

/** The terminal's own limits (terminal/service.ts) on the forwarded path. */
export const TERMINAL_BRIDGE_FLOW: BridgeFlow = { ...TERMINAL_BACKPRESSURE, pollMs: 50 };

export interface BridgeOptions {
  /** Opens the connection to the other computer (rejects with HostForwarderError). */
  connect(signal: AbortSignal): Promise<WebSocket>;
  limits?: Partial<BridgeLimits>;
  /** WP-107: pause the other side while the browser falls behind (absent = close at `maxBufferedBytes`). */
  flow?: BridgeFlow;
  logger: Logger;
}

/** The error of a failed connect (anything but a HostForwarderError counts as unreachable). */
export function forwardFailure(error: unknown): ErrorPayload {
  return error instanceof HostForwarderError
    ? error.error
    : makeError('HOST_UNREACHABLE', { reason: 'closed' });
}

function toBuffer(data: RawData): Buffer {
  if (Buffer.isBuffer(data)) return data;
  if (Array.isArray(data)) return Buffer.concat(data);
  return Buffer.from(data);
}

function isOpen(ws: WebSocket): boolean {
  return ws.readyState === WebSocket.OPEN;
}

/** Bridges `browser` to a new connection of the other computer; everything ends with the browser socket. */
export function bridgeWindow(browser: WebSocket, options: BridgeOptions): void {
  const limits: BridgeLimits = { ...BRIDGE_LIMITS, ...options.limits };
  const log = options.logger;
  const controller = new AbortController();
  const early: { data: Buffer; binary: boolean }[] = [];
  let upstream: WebSocket | null = null;
  let ended = false;
  let alive = true;
  let upstreamIdle: NodeJS.Timeout | null = null;
  /** WP-107: the poll of a paused bridge and when it paused. */
  let pausePoll: NodeJS.Timeout | null = null;
  let pausedSince = 0;

  const heartbeat = setInterval(() => {
    if (!alive) {
      browser.terminate();
      return;
    }
    alive = false;
    if (isOpen(browser)) browser.ping();
  }, limits.heartbeatMs);
  heartbeat.unref();

  /** Ends the bridge: the browser gets `code` (when still open), the other side a normal close. */
  const end = (code: number): void => {
    if (ended) return;
    ended = true;
    clearInterval(heartbeat);
    if (upstreamIdle !== null) clearTimeout(upstreamIdle);
    if (pausePoll !== null) clearInterval(pausePoll);
    controller.abort();
    // A paused socket would never read the other side's close frame (WP-107 `flow`).
    if (upstream?.isPaused === true) upstream.resume();
    if (upstream !== null && upstream.readyState !== WebSocket.CLOSED) upstream.close(NORMAL);
    if (browser.readyState === WebSocket.OPEN || browser.readyState === WebSocket.CONNECTING) {
      browser.close(code, closeReason(code));
    }
  };

  /** Sends one frame unchanged; ends the bridge when `target` cannot keep up. */
  const relay = (target: WebSocket, data: RawData, binary: boolean): void => {
    if (!isOpen(target)) return;
    if (target.bufferedAmount > limits.maxBufferedBytes) {
      log.warn({ side: target === browser ? 'browser' : 'computer' }, 'forwarded window too slow, closing');
      end(SLOW_CONSUMER);
      return;
    }
    target.send(toBuffer(data), { binary });
  };

  /** WP-107 (`flow`): sends to the browser; pauses the other side while the browser falls behind. */
  const relayPaced = (flow: BridgeFlow, source: WebSocket, data: RawData, binary: boolean): void => {
    if (!isOpen(browser)) return;
    browser.send(toBuffer(data), { binary });
    const backlog = browser.bufferedAmount;
    if (backlog > flow.closeBytes) {
      log.warn('forwarded terminal too slow, closing');
      end(SLOW_CONSUMER);
      return;
    }
    if (backlog <= flow.pauseBytes || pausePoll !== null) return;
    source.pause();
    pausedSince = Date.now();
    pausePoll = setInterval(() => {
      if (ended) return;
      if (browser.bufferedAmount < flow.resumeBytes) {
        if (pausePoll !== null) clearInterval(pausePoll);
        pausePoll = null;
        source.resume();
        return;
      }
      if (Date.now() - pausedSince > flow.pauseMaxMs) {
        log.warn('forwarded terminal paused too long, closing');
        end(SLOW_CONSUMER);
      }
    }, flow.pollMs);
    pausePoll.unref();
  };

  browser.on('pong', () => {
    alive = true;
  });
  // The close event follows every error; nothing may become uncaught.
  browser.on('error', () => undefined);
  browser.on('message', (data: RawData, binary: boolean) => {
    if (ended) return;
    if (upstream !== null) {
      relay(upstream, data, binary);
      return;
    }
    if (early.length >= limits.earlyMessages) {
      end(WS_CLOSE.PROTOCOL_ERROR);
      return;
    }
    early.push({ data: Buffer.from(toBuffer(data)), binary });
  });
  browser.on('close', () => {
    end(NORMAL);
  });

  options.connect(controller.signal).then(
    (ws) => {
      ws.on('error', () => undefined);
      if (ended) {
        ws.terminate();
        return;
      }
      upstream = ws;
      const heard = (): void => {
        if (upstreamIdle !== null) clearTimeout(upstreamIdle);
        if (ended) return;
        upstreamIdle = setTimeout(() => {
          log.info('forwarded window silent – closing');
          ws.terminate();
        }, limits.upstreamIdleMs);
        upstreamIdle.unref();
      };
      heard();
      ws.on('ping', heard);
      ws.on('message', (data: RawData, binary: boolean) => {
        heard();
        if (ended) return;
        if (options.flow === undefined) relay(browser, data, binary);
        else relayPaced(options.flow, ws, data, binary);
      });
      ws.on('close', (code: number) => {
        end(browserCloseCode(ws, code));
      });
      if (!isOpen(ws)) {
        end(browserCloseCode(ws, 1006));
        return;
      }
      for (const message of early.splice(0)) ws.send(message.data, { binary: message.binary });
    },
    (error: unknown) => {
      const failure = forwardFailure(error);
      if (!ended)
        log.info({ code: failure.code, reason: failure.params.reason ?? null }, 'window not forwarded');
      end(forwarderErrorCloseCode(failure.code));
    },
  );
}

/** WP-107 (E3): a forwarded terminal connection (`bridgeWindow` with `flow`). */
export function bridgeTerminal(
  browser: WebSocket,
  options: Omit<BridgeOptions, 'flow'> & { flow?: BridgeFlow },
): void {
  bridgeWindow(browser, { ...options, flow: options.flow ?? TERMINAL_BRIDGE_FLOW });
}
