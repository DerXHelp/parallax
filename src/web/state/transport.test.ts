import { describe, expect, it, vi } from 'vitest';
import { sampleClientHello, sampleHello } from '@shared/samples';
import {
  createMemoryTransport,
  createWebSocketTransport,
  webSocketUrl,
  type SocketHandlers,
} from './transport';

function fakeSockets() {
  const sockets: {
    url: string;
    handlers: SocketHandlers;
    sent: string[];
    open: boolean;
    closedWith: number | null;
  }[] = [];
  const factory = (url: string, handlers: SocketHandlers) => {
    const socket = { url, handlers, sent: [] as string[], open: true, closedWith: null as number | null };
    sockets.push(socket);
    return {
      get isOpen() {
        return socket.open;
      },
      send: (text: string) => {
        socket.sent.push(text);
      },
      close: (code?: number) => {
        socket.open = false;
        socket.closedWith = code ?? null;
      },
    };
  };
  return { sockets, factory };
}

describe('createWebSocketTransport', () => {
  it('forwards frames and close codes of the current socket only', () => {
    const { sockets, factory } = fakeSockets();
    const transport = createWebSocketTransport('ws://127.0.0.1:5173/api/ws', factory);
    const onMessage = vi.fn();
    const onClose = vi.fn();
    transport.connect(onMessage, onClose);
    sockets[0]?.handlers.onMessage('{"type":"hello"}');
    transport.send('{"type":"clientHello"}');
    expect(onMessage).toHaveBeenCalledWith('{"type":"hello"}');
    expect(sockets[0]?.sent).toEqual(['{"type":"clientHello"}']);

    // Reconnect: the old socket is closed and muted.
    transport.connect(onMessage, onClose);
    expect(sockets[0]?.closedWith).toBe(1000);
    sockets[0]?.handlers.onClose(1006);
    expect(onClose).not.toHaveBeenCalled();
    sockets[1]?.handlers.onClose(1006);
    expect(onClose).toHaveBeenCalledWith(1006);
    expect(() => {
      transport.send('x');
    }).toThrow();
  });

  it('close() is deliberate: onClose is not called', () => {
    const { sockets, factory } = fakeSockets();
    const transport = createWebSocketTransport('ws://x/api/ws', factory);
    const onClose = vi.fn();
    transport.connect(vi.fn(), onClose);
    transport.close();
    sockets[0]?.handlers.onClose(1000);
    expect(onClose).not.toHaveBeenCalled();
  });

  it('builds ws:// and wss:// URLs from the page location', () => {
    expect(webSocketUrl({ protocol: 'http:', host: '127.0.0.1:5173' }, '/api/ws')).toBe(
      'ws://127.0.0.1:5173/api/ws',
    );
    expect(webSocketUrl({ protocol: 'https:', host: 'example' }, '/api/ws')).toBe('wss://example/api/ws');
  });
});

describe('createMemoryTransport', () => {
  it('delivers server messages and records parsed client messages', () => {
    const transport = createMemoryTransport();
    const onMessage = vi.fn();
    const onClose = vi.fn();
    const onClient = vi.fn();
    const onConnect = vi.fn();
    transport.onClientMessage(onClient);
    transport.onConnect(onConnect);
    transport.connect(onMessage, onClose);
    expect(onConnect).toHaveBeenCalledTimes(1);
    transport.serverSend(sampleHello());
    expect(onMessage).toHaveBeenCalledWith(JSON.stringify(sampleHello()));
    transport.send(JSON.stringify(sampleClientHello()));
    expect(transport.sent).toEqual([sampleClientHello()]);
    expect(transport.sentOfType('clientHello')).toHaveLength(1);
    expect(onClient).toHaveBeenCalledWith(sampleClientHello());
    expect(() => {
      transport.send('{"type":"nope"}');
    }).toThrow(/invalid client message/);
    transport.serverClose(4503);
    expect(onClose).toHaveBeenCalledWith(4503);
    expect(transport.connected).toBe(false);
    expect(() => {
      transport.serverSend(sampleHello());
    }).toThrow();
  });
});
