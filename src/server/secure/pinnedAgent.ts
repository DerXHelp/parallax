/**
 * The client of a controlling computer to ONE coupled sharing computer (docs/wp/WP-76.md §B.6
 * "Steuernder Rechner: Client", Review A2/t8). One agent per coupling, created when the coupling is
 * loaded or made, destroyed when it is removed or replaced (`destroy()` also zeroes kAuth).
 *
 * - Every TLS option lives in the agent (one SecureContext: §B.3 profile, the coupling's key and
 *   certificate, `ca` = the pinned certificate of the sharing computer); options of a single request
 *   are ignored except `host`/`port`. No SNI (`servername: ''`), no session cache, no resumption.
 * - `checkServerIdentity` compares the pin from `cert.raw` in constant time and never throws.
 * - `createConnection` is asynchronous: TLS handshake → re-check (`!isSessionReused()`, `authorized`,
 *   profile, pin again from `getPeerX509Certificate().raw`) → connection proof (§B.9) → only then
 *   the socket goes to HTTP / `ws`. Any failure destroys the socket: no HTTP byte reaches an
 *   unchecked peer.
 * - At most HANDSHAKES_IN_FLIGHT connections are being set up at a time (the rest wait in order):
 *   the sharing computer counts unproven sockets per address (remote/limits.ts), many windows
 *   opening at once must not run into that limit. A connection waits at most `queueTimeoutMs` for
 *   its turn (then 'timeout'); `destroy()` ends every waiting one at once ('destroyed').
 *
 * Use: `https.request({agent, host, port, path, headers: remoteVersionHeaders(v)})` and
 * `new WebSocket(url, {agent, ...REMOTE_WS_CLIENT_OPTIONS, headers: remoteVersionHeaders(v)})`.
 */
import { Agent as HttpsAgent, type RequestOptions } from 'node:https';
import { PassThrough, type Duplex } from 'node:stream';
import {
  connect,
  createSecureContext,
  type PeerCertificate,
  type SecureContext,
  type TLSSocket,
} from 'node:tls';
import { LIMITS } from '@shared/common';
import { REMOTE_HEADERS } from '@shared/http';
import { PROTOCOL_VERSION } from '@shared/protocol';
import { PROOF_TIMEOUT_MS, proveAsClient, type ProofFailure } from './connectionProof';
import { certificatePem, pinOfCertificate, pinsEqual, tryPinOfCertificate } from './pins';
import type { Identity } from './ports';
import {
  HANDSHAKE_TIMEOUT_MS,
  TLS_PROFILE,
  privateKeyPem,
  profileViolation,
  type ProfileViolation,
} from './tlsProfile';

/** Why `createConnection` refused a connection (no secrets; for HOST_UNREACHABLE/HOST_REVOKED mapping in WP-79). */
export type PinnedConnectionFailure =
  | 'destroyed'
  | 'network'
  | 'timeout'
  | 'tls'
  | 'unauthorized'
  | 'pin'
  | ProfileViolation
  | `proof_${ProofFailure}`;

export class PinnedConnectionError extends Error {
  readonly reason: PinnedConnectionFailure;
  /** errno/TLS code of an underlying socket error (e.g. ECONNREFUSED), if any. */
  readonly code: string | null;

  constructor(reason: PinnedConnectionFailure, code: string | null = null) {
    super(`remote connection refused: ${reason}${code === null ? '' : ` (${code})`}`);
    this.name = 'PinnedConnectionError';
    this.reason = reason;
    this.code = code;
  }
}

export interface PinnedAgentOptions {
  /** The coupling's own key and certificate (client certificate). */
  identity: Identity;
  /** The sharing computer's whole certificate (DER) – pinned as the only `ca`. */
  peerCertificateDer: Buffer;
  /** Its pin (`HostRecord.peerPin`); must match the certificate. */
  peerPin: string;
  /** kAuth (copied; the copy is zeroed by `destroy()`). */
  authKey: Uint8Array;
  /** Handshake plus connection proof (default 10 s). */
  connectTimeoutMs?: number;
  proofTimeoutMs?: number;
  /** Idle sockets kept for reuse (default true). */
  keepAlive?: boolean;
  maxSockets?: number;
  /** Longest wait for a free handshake slot (default QUEUE_TIMEOUT_MS). */
  queueTimeoutMs?: number;
}

/** Version headers every request to a sharing computer carries (REMOTE_HEADERS, ADR-209). */
export function remoteVersionHeaders(appVersion: string): Record<string, string> {
  return { [REMOTE_HEADERS.version]: appVersion, [REMOTE_HEADERS.protocol]: String(PROTOCOL_VERSION) };
}

/** Options for `new WebSocket(url, {agent, ...})` on the controlling side (§B.6). */
export const REMOTE_WS_CLIENT_OPTIONS = {
  perMessageDeflate: false,
  maxPayload: LIMITS.wsMaxPayloadBytes,
  handshakeTimeout: HANDSHAKE_TIMEOUT_MS,
} as const;

function errorCode(error: unknown): string | null {
  if (typeof error === 'object' && error !== null && 'code' in error && typeof error.code === 'string')
    return error.code;
  return null;
}

const TLS_ERROR = /^(?:ERR_SSL_|ERR_TLS_|ERR_OSSL_|DEPTH_ZERO|SELF_SIGNED|UNABLE_TO|CERT_)/u;

/** Connections being set up at once (below `perAddressConcurrent` of the sharing side, remote/limits.ts). */
export const HANDSHAKES_IN_FLIGHT = 2;

/** Longest wait in the handshake queue: two full set-ups ahead (handshake + proof each). */
export const QUEUE_TIMEOUT_MS = 2 * (HANDSHAKE_TIMEOUT_MS + PROOF_TIMEOUT_MS);

interface Waiter {
  grant: () => void;
  fail: (error: PinnedConnectionError) => void;
  timer: NodeJS.Timeout;
}

export class PinnedAgent extends HttpsAgent {
  private readonly context: SecureContext;
  private readonly peerPin: string;
  private readonly authKey: Buffer;
  private readonly connectTimeoutMs: number;
  private readonly proofTimeoutMs: number;
  private readonly queueTimeoutMs: number;
  private closed = false;
  private handshakes = 0;
  private readonly waiting: Waiter[] = [];

  constructor(options: PinnedAgentOptions) {
    super({
      keepAlive: options.keepAlive ?? true,
      maxCachedSessions: 0,
      ...(options.maxSockets === undefined ? {} : { maxSockets: options.maxSockets }),
    });
    if (!pinsEqual(pinOfCertificate(options.peerCertificateDer), options.peerPin)) {
      throw new TypeError('peer certificate does not match the pin');
    }
    const key = privateKeyPem(options.identity);
    try {
      this.context = createSecureContext({
        ...TLS_PROFILE,
        key,
        cert: options.identity.certificatePem,
        ca: [certificatePem(options.peerCertificateDer)],
      });
    } finally {
      key.fill(0);
    }
    this.peerPin = options.peerPin;
    this.authKey = Buffer.from(options.authKey);
    this.connectTimeoutMs = options.connectTimeoutMs ?? HANDSHAKE_TIMEOUT_MS;
    this.proofTimeoutMs = options.proofTimeoutMs ?? PROOF_TIMEOUT_MS;
    this.queueTimeoutMs = options.queueTimeoutMs ?? QUEUE_TIMEOUT_MS;
  }

  /** Pin check of the TLS handshake: from `cert.raw`, constant time, never throws (returns the error). */
  readonly checkServerIdentity = (_host: string, cert: PeerCertificate): Error | undefined => {
    try {
      const pin = tryPinOfCertificate(cert.raw);
      if (pin === null) return new Error('no usable certificate');
      return pinsEqual(pin, this.peerPin) ? undefined : new Error('pin mismatch');
    } catch {
      return new Error('pin check failed');
    }
  };

  get isDestroyed(): boolean {
    return this.closed;
  }

  override createConnection(
    options: RequestOptions,
    callback?: (error: Error | null, stream: Duplex) => void,
  ): Duplex | null | undefined {
    const host =
      typeof options.host === 'string' && options.host !== '' ? options.host : (options.hostname ?? null);
    const port = typeof options.port === 'number' ? options.port : Number(options.port);
    const done = once(callback);
    if (this.closed) {
      process.nextTick(() => {
        done(new PinnedConnectionError('destroyed'));
      });
      return undefined;
    }
    if (typeof host !== 'string' || host === '' || !Number.isInteger(port) || port < 1 || port > 65535) {
      process.nextTick(() => {
        done(new PinnedConnectionError('network', 'EINVAL'));
      });
      return undefined;
    }
    this.acquireHandshake().then(
      () => {
        if (this.closed) {
          this.releaseHandshake();
          done(new PinnedConnectionError('destroyed'));
          return;
        }
        let socket: TLSSocket;
        try {
          socket = connect({
            host,
            port,
            secureContext: this.context,
            servername: '',
            rejectUnauthorized: true,
            checkServerIdentity: this.checkServerIdentity,
          });
        } catch (error) {
          this.releaseHandshake();
          done(new PinnedConnectionError('network', errorCode(error)));
          return;
        }
        void this.establish(socket).then(
          () => {
            this.releaseHandshake();
            done(null, socket);
          },
          (error: unknown) => {
            this.releaseHandshake();
            socket.destroy();
            done(
              error instanceof PinnedConnectionError
                ? error
                : new PinnedConnectionError('network', errorCode(error)),
            );
          },
        );
      },
      (error: unknown) => {
        done(error instanceof PinnedConnectionError ? error : new PinnedConnectionError('network'));
      },
    );
    return undefined;
  }

  /**
   * Waits for one of the HANDSHAKES_IN_FLIGHT slots (first come, first served); rejects with
   * 'timeout' after `queueTimeoutMs` and with 'destroyed' when the agent goes away meanwhile.
   */
  private acquireHandshake(): Promise<void> {
    if (this.handshakes < HANDSHAKES_IN_FLIGHT) {
      this.handshakes += 1;
      return Promise.resolve();
    }
    return new Promise((resolve, reject) => {
      const waiter: Waiter = {
        grant: () => {
          clearTimeout(waiter.timer);
          resolve();
        },
        fail: (error) => {
          clearTimeout(waiter.timer);
          reject(error);
        },
        timer: setTimeout(() => {
          const index = this.waiting.indexOf(waiter);
          if (index >= 0) this.waiting.splice(index, 1);
          reject(new PinnedConnectionError('timeout'));
        }, this.queueTimeoutMs),
      };
      waiter.timer.unref();
      this.waiting.push(waiter);
    });
  }

  /** Hands the slot to the next waiting connection, or frees it. */
  private releaseHandshake(): void {
    const next = this.waiting.shift();
    if (next === undefined) this.handshakes -= 1;
    else next.grant();
  }

  /** Handshake, re-checks and connection proof; rejects with PinnedConnectionError. */
  private establish(socket: TLSSocket): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      let settled = false;
      /** After the handshake a close means the peer refused us (unknown or revoked key, wrong proof). */
      let secured = false;
      const cleanup = (): void => {
        clearTimeout(handshakeTimer);
        socket.removeListener('error', onError);
        socket.removeListener('close', onClose);
        socket.removeListener('secureConnect', onSecure);
      };
      const fail = (error: PinnedConnectionError): void => {
        if (settled) return;
        settled = true;
        cleanup();
        reject(error);
      };
      const onError = (error: Error): void => {
        const code = errorCode(error);
        if (secured) fail(new PinnedConnectionError('proof_closed', code));
        else fail(new PinnedConnectionError(code !== null && TLS_ERROR.test(code) ? 'tls' : 'network', code));
      };
      const onClose = (): void => {
        fail(new PinnedConnectionError(secured ? 'proof_closed' : 'network', 'ECONNRESET'));
      };
      const onSecure = (): void => {
        clearTimeout(handshakeTimer);
        secured = true;
        const failure = this.recheck(socket);
        if (failure !== null) {
          fail(new PinnedConnectionError(failure));
          return;
        }
        void proveAsClient(socket, this.authKey, this.proofTimeoutMs).then((proof) => {
          if (settled) return;
          if (proof !== null) {
            fail(new PinnedConnectionError(`proof_${proof}`));
            return;
          }
          if (this.closed || socket.destroyed) {
            fail(new PinnedConnectionError(this.closed ? 'destroyed' : 'proof_closed'));
            return;
          }
          settled = true;
          cleanup();
          // From here on the HTTP client owns the socket; a late 'error' must never become uncaught.
          socket.on('error', () => undefined);
          resolve();
        });
      };
      const handshakeTimer = setTimeout(() => {
        fail(new PinnedConnectionError('timeout'));
      }, this.connectTimeoutMs);
      socket.on('error', onError);
      socket.once('close', onClose);
      socket.once('secureConnect', onSecure);
    });
  }

  /** §B.6 step 2 after `secureConnect`; null = fine. Never throws. */
  private recheck(socket: TLSSocket): PinnedConnectionFailure | null {
    try {
      if (!socket.authorized) return 'unauthorized';
      const violation = profileViolation(socket, 'client');
      if (violation !== null) return violation;
      const pin = tryPinOfCertificate(socket.getPeerX509Certificate()?.raw);
      if (pin === null || !pinsEqual(pin, this.peerPin)) return 'pin';
      return null;
    } catch {
      return 'check_failed';
    }
  }

  /** Closes every socket and zeroes kAuth; the agent refuses new connections afterwards. */
  override destroy(): void {
    this.closed = true;
    this.authKey.fill(0);
    for (const waiter of this.waiting.splice(0)) waiter.fail(new PinnedConnectionError('destroyed'));
    super.destroy();
  }
}

/** The agent's callback, called at most once (Node ignores the stream of an error call). */
function once(
  callback: ((error: Error | null, stream: Duplex) => void) | undefined,
): (error: Error | null, stream?: Duplex) => void {
  let called = false;
  return (error, stream) => {
    if (called || callback === undefined) return;
    called = true;
    if (error === null && stream !== undefined) {
      callback(null, stream);
      return;
    }
    const placeholder = stream ?? new PassThrough();
    placeholder.destroy();
    callback(error ?? new PinnedConnectionError('network'), placeholder);
  };
}
