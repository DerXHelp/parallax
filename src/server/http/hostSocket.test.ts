import type { AddressInfo } from 'node:net';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { WebSocket, WebSocketServer } from 'ws';
import { createLogger } from '../lib/logger';
import { bridgeTerminal, type BridgeFlow } from './hostSocket';

// Moves a few MB over loopback: generous limits for a busy machine.
vi.setConfig({ testTimeout: 60_000 });

const SILENT = createLogger({ level: 'silent' });
const CHUNK = Buffer.alloc(64 * 1024, 0x61);

const cleanups: (() => Promise<void> | void)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

async function server(): Promise<{ port: number; sockets: WebSocket[]; next(): Promise<WebSocket> }> {
  const wss = new WebSocketServer({ host: '127.0.0.1', port: 0, perMessageDeflate: false });
  await new Promise<void>((resolve) => wss.once('listening', resolve));
  const sockets: WebSocket[] = [];
  const waiting: ((ws: WebSocket) => void)[] = [];
  wss.on('connection', (ws) => {
    ws.on('error', () => undefined);
    sockets.push(ws);
    waiting.shift()?.(ws);
  });
  cleanups.push(
    () =>
      new Promise<void>((resolve) => {
        for (const ws of wss.clients) ws.terminate();
        wss.close(() => {
          resolve();
        });
      }),
  );
  return {
    port: (wss.address() as AddressInfo).port,
    sockets,
    next: () => {
      const ready = sockets.shift();
      if (ready !== undefined) return Promise.resolve(ready);
      return new Promise((resolve) => waiting.push(resolve));
    },
  };
}

function open(url: string): Promise<WebSocket> {
  const ws = new WebSocket(url, { perMessageDeflate: false });
  ws.on('error', () => undefined);
  cleanups.push(() => {
    ws.terminate();
  });
  return new Promise((resolve, reject) => {
    ws.once('open', () => {
      resolve(ws);
    });
    ws.once('close', () => {
      reject(new Error('closed before open'));
    });
  });
}

/** Browser ↔ bridge ↔ upstream on loopback; the browser socket does not read until `resume`. */
async function bridged(flow: BridgeFlow): Promise<{ browser: WebSocket; upstream: WebSocket }> {
  const up = await server();
  const front = await server();
  const browser = await open(`ws://127.0.0.1:${String(front.port)}`);
  browser.pause();
  const facing = await front.next();
  bridgeTerminal(facing, {
    connect: () => open(`ws://127.0.0.1:${String(up.port)}`),
    flow,
    logger: SILENT,
  });
  return { browser, upstream: await up.next() };
}

const tick = (): Promise<void> => new Promise((resolve) => setImmediate(resolve));

describe('forwarded terminal: pacing by pausing (WP-107, E3)', () => {
  it('a browser that falls behind pauses the other side (TCP holds its output); all of it arrives later', async () => {
    const { browser, upstream } = await bridged({
      pauseBytes: 256 * 1024,
      resumeBytes: 64 * 1024,
      closeBytes: 1024 * 1024 * 1024,
      pauseMaxMs: 30_000,
      pollMs: 10,
    });
    let sent = 0;
    // Without the pause the bridge would read everything into its own memory: the other side would
    // never see a backlog of its own.
    while (upstream.bufferedAmount < 1024 * 1024 && sent < 96 * 1024 * 1024) {
      upstream.send(CHUNK);
      sent += CHUNK.length;
      await tick();
    }
    expect(upstream.bufferedAmount).toBeGreaterThanOrEqual(1024 * 1024);
    let received = 0;
    browser.on('message', (data: Buffer) => {
      received += data.length;
    });
    browser.resume();
    await vi.waitFor(
      () => {
        expect(received).toBe(sent);
      },
      { timeout: 30_000 },
    );
    expect(browser.readyState).toBe(WebSocket.OPEN);
  });

  it('paused longer than pauseMaxMs: both sides close (1013 for the browser)', async () => {
    const { browser, upstream } = await bridged({
      pauseBytes: 64 * 1024,
      resumeBytes: 16 * 1024,
      closeBytes: 1024 * 1024 * 1024,
      pauseMaxMs: 200,
      pollMs: 10,
    });
    const upstreamClosed = new Promise<void>((resolve) =>
      upstream.once('close', () => {
        resolve();
      }),
    );
    for (let i = 0; i < 512 && upstream.readyState === WebSocket.OPEN; i++) {
      upstream.send(CHUNK);
      await tick();
    }
    await upstreamClosed;
    const code = new Promise<number>((resolve) =>
      browser.once('close', (value: number) => {
        resolve(value);
      }),
    );
    browser.resume();
    expect(await code).toBe(1013);
  });
});
