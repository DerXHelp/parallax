/**
 * Close codes of forwarded window connections (docs/wp/WP-76.md §B.6 "Vermittler", WS_CLOSE.HOST_*).
 * The forwarder closes the connection to the other computer; the HTTP layer closes the browser side
 * with the code the forwarder chose (`markWindowClosed`) or, when the other computer ended it, with
 * the mapped code of its close.
 */
import type { WebSocket } from 'ws';
import type { ErrorCode } from '@shared/errors';
import { WS_CLOSE } from '@shared/protocol';

const forced = new WeakMap<WebSocket, number>();

/** The forwarder ends `upstream` on purpose; the browser side gets `code`. */
export function markWindowClosed(upstream: WebSocket, code: number): void {
  if (!forced.has(upstream)) forced.set(upstream, code);
}

/**
 * Close code for the browser when the connection to the other computer closed with `code`: the
 * forwarder's own choice first; otherwise revoked (4403) and protocol errors (4400) pass, a
 * version mismatch becomes HOST_INCOMPATIBLE, everything else (shutdown, restart, network) is
 * HOST_UNREACHABLE – the window retries with backoff.
 */
export function browserCloseCode(upstream: WebSocket, code: number): number {
  const own = forced.get(upstream);
  if (own !== undefined) return own;
  if (code === WS_CLOSE.HOST_REVOKED || code === WS_CLOSE.PROTOCOL_ERROR) return code;
  if (code === WS_CLOSE.PROTOCOL_VERSION_MISMATCH || code === WS_CLOSE.HOST_INCOMPATIBLE) {
    return WS_CLOSE.HOST_INCOMPATIBLE;
  }
  return WS_CLOSE.HOST_UNREACHABLE;
}

/** Close code of a window whose connection could not be made (HostForwarderError code). */
export function forwarderErrorCloseCode(code: ErrorCode): number {
  if (code === 'HOST_INCOMPATIBLE') return WS_CLOSE.HOST_INCOMPATIBLE;
  // A removed computer is final for the window, like a revoked coupling.
  if (code === 'HOST_REVOKED' || code === 'HOST_NOT_FOUND') return WS_CLOSE.HOST_REVOKED;
  return WS_CLOSE.HOST_UNREACHABLE;
}

/** Short close reasons (ASCII, well below 123 bytes). */
export function closeReason(code: number): string {
  switch (code) {
    case WS_CLOSE.HOST_REVOKED:
      return 'coupling revoked';
    case WS_CLOSE.HOST_INCOMPATIBLE:
      return 'other version';
    case WS_CLOSE.HOST_UNREACHABLE:
      return 'computer unreachable';
    case WS_CLOSE.SERVER_SHUTDOWN:
      return 'server shutdown';
    default:
      return '';
  }
}
