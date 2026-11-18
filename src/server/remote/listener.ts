/**
 * The remote-access listener of the sharing computer (docs/wp/WP-76.md §B.6, §B.10):
 *
 * 1. A `net.Server` takes the TCP connections and applies the limits BEFORE TLS (at most 64 in
 *    total, 4 at a time per address, token bucket 10/min with burst 5 per address).
 * 2. A non-listening `tls.Server` (§B.3 profile, own ML-DSA-87 certificate, `requestCert`,
 *    `rejectUnauthorized: false`, 10 s handshake) gets the raw sockets.
 * 3. `secureConnection` classifies SYNCHRONOUSLY from memory and notes the class on the socket:
 *    resumed session → `tls_failed`; no / non-ML-DSA-87 client certificate → `bad_certificate`
 *    (also while a pairing window is open); pin of the coupling → `peer` with the current
 *    generation → connection proof (§B.9) → only then `onPeer`; open pairing window → `pairing` →
 *    `onPairing`; otherwise `revoked_key` / `unknown_key`. Everything else is destroyed.
 *
 * Every socket of the coupled computer stays in a list; `destroyPeerSockets()` (unpair, renewed
 * key, sharing off, role switch) ends them at once. Handlers check `isCurrentPeer()` before every
 * effect (the second layer, default deny).
 */
import {
  createServer as createNetServer,
  type AddressInfo,
  type Server as NetServer,
  type Socket,
} from 'node:net';
import { createServer as createTlsServer, type Server as TlsServer, type TLSSocket } from 'node:tls';
import type { Logger } from 'pino';
import { logger as rootLogger } from '../lib/logger';
import { fsErrorCode } from '../lib/paths';
import { proveAsServer } from '../secure/connectionProof';
import type { Identity } from '../secure/ports';
import { pinsEqual, tryPinOfCertificate } from '../secure/pins';
import { TLS_PROFILE, privateKeyPem, profileViolation } from '../secure/tlsProfile';
import { normalizeRemoteAddress, normalizeRemotePort } from './addresses';
import { Concurrency, REMOTE_LIMITS, TokenBuckets, type RemoteLimits } from './limits';
import type { RemoteEventInput } from './ports';

export type RemoteSocketClass = 'peer' | 'pairing';

export interface RemoteSocketInfo {
  readonly cls: RemoteSocketClass;
  /** Coupling generation at classification (`peer`); -1 for `pairing`. */
  readonly generation: number;
  /** Pairing window at classification (`pairing`); null for `peer`. */
  readonly windowId: string | null;
  readonly address: string;
  readonly port: number | null;
  /** `peer`: the connection proof succeeded. */
  proven: boolean;
}

/** The coupling as the listener needs it (memory only). */
export interface ListenerCoupling {
  pin: string;
  generation: number;
  /** kAuth (plaintext, only in memory while the coupling is active). */
  authKey: Buffer;
}

export interface RemoteListenerHooks {
  coupling(): ListenerCoupling | null;
  /** Current coupling generation (changes with every change of the coupling). */
  generation(): number;
  isRevoked(pin: string): boolean;
  /** Id of the open, not expired pairing window, or null. */
  pairingWindowId(): string | null;
  record(event: RemoteEventInput): void;
  /** A proven socket of the coupled computer → peer HTTP. */
  onPeer(socket: TLSSocket, info: RemoteSocketInfo): void;
  /** A socket for the open pairing window → pairing HTTP. */
  onPairing(socket: TLSSocket, info: RemoteSocketInfo): void;
  /** Number of proven peer sockets changed (`connected` / `disconnected`, HostState). */
  onPeerCount(count: number, info: RemoteSocketInfo): void;
}

export type ListenFailure = 'port_in_use' | 'bind' | 'listen';

export class RemoteListenError extends Error {
  constructor(readonly reason: ListenFailure) {
    super(`remote access listener: ${reason}`);
    this.name = 'RemoteListenError';
  }
}

export interface RemoteListenerOptions {
  hooks: RemoteListenerHooks;
  limits?: RemoteLimits;
  logger?: Logger;
}

const noop = (): void => undefined;

export class RemoteListener {
  private readonly hooks: RemoteListenerHooks;
  private readonly limits: RemoteLimits;
  private readonly log: Logger;
  private net: NetServer | null = null;
  private tls: TlsServer | null = null;
  private bound: { address: string; port: number } | null = null;
  private readonly raw = new Set<Socket>();
  private readonly peers = new Set<TLSSocket>();
  private readonly proven = new Set<TLSSocket>();
  private readonly pairing = new Set<TLSSocket>();
  private readonly infos = new WeakMap<object, RemoteSocketInfo>();
  private readonly concurrency = new Concurrency();
  private readonly buckets: TokenBuckets;

  constructor(options: RemoteListenerOptions) {
    this.hooks = options.hooks;
    this.limits = options.limits ?? REMOTE_LIMITS;
    this.log = (options.logger ?? rootLogger).child({ module: 'remoteListener' });
    this.buckets = new TokenBuckets(this.limits.perAddressBurst, this.limits.perAddressPerMinute);
  }

  get listening(): boolean {
    return this.bound !== null;
  }

  /** Address and port actually bound (port 0 → the OS-assigned one), or null. */
  address(): { address: string; port: number } | null {
    return this.bound;
  }

  async start(
    identity: Identity,
    bindAddress: string,
    port: number,
  ): Promise<{ address: string; port: number }> {
    if (this.net !== null) throw new Error('listener already started');
    const tls = this.createTls(identity);
    const net = createNetServer({ noDelay: true }, (socket) => {
      this.onRaw(socket);
    });
    net.maxConnections = this.limits.maxConnections;
    net.on('drop', (data) => {
      this.hooks.record({
        kind: 'rate_limited',
        address: normalizeRemoteAddress(data?.remoteAddress),
        port: normalizeRemotePort(data?.remotePort),
      });
    });
    this.net = net;
    this.tls = tls;
    try {
      await new Promise<void>((resolve, reject) => {
        const onError = (error: Error): void => {
          reject(error);
        };
        net.once('error', onError);
        net.listen({ host: bindAddress, port, exclusive: true }, () => {
          net.off('error', onError);
          resolve();
        });
      });
    } catch (error) {
      this.net = null;
      this.tls = null;
      const code = fsErrorCode(error);
      throw new RemoteListenError(
        code === 'EADDRINUSE'
          ? 'port_in_use'
          : code === 'EADDRNOTAVAIL' || code === 'EACCES'
            ? 'bind'
            : 'listen',
      );
    }
    net.on('error', (error) => {
      this.log.error({ err: error }, 'listener error');
    });
    const address = net.address() as AddressInfo;
    this.bound = { address: address.address, port: address.port };
    this.log.info({ address: address.address, port: address.port }, 'remote access listening');
    return this.bound;
  }

  /** Closes the port and destroys every connection (idempotent). */
  async stop(): Promise<void> {
    const net = this.net;
    this.net = null;
    this.tls = null;
    this.bound = null;
    if (net === null) return;
    const closed = new Promise<void>((resolve) => {
      net.close(() => {
        resolve();
      });
    });
    for (const socket of [...this.peers, ...this.pairing]) socket.destroy();
    for (const socket of this.raw) socket.destroy();
    await closed;
    this.log.info('remote access stopped');
  }

  /** New identity (renewed key) for new handshakes; open connections are not touched. */
  setIdentity(identity: Identity): void {
    const tls = this.tls;
    if (tls === null) return;
    const key = privateKeyPem(identity);
    try {
      tls.setSecureContext({ ...TLS_PROFILE, key, cert: identity.certificatePem });
    } finally {
      key.fill(0);
    }
  }

  info(socket: object): RemoteSocketInfo | undefined {
    return this.infos.get(socket);
  }

  /** A proven socket of the CURRENT coupling generation (check before every effect, §B.8). */
  isCurrentPeer(socket: object): boolean {
    const info = this.infos.get(socket);
    if (info?.cls !== 'peer' || !info.proven || info.generation !== this.hooks.generation()) return false;
    return 'destroyed' in socket && socket.destroyed === false;
  }

  peerCount(): number {
    return this.proven.size;
  }

  pairingCount(): number {
    return this.pairing.size;
  }

  destroyPeerSockets(except?: object): void {
    for (const socket of [...this.peers]) if (socket !== except) socket.destroy();
  }

  destroyPairingSockets(except?: object): void {
    for (const socket of [...this.pairing]) if (socket !== except) socket.destroy();
  }

  // ---- internals ----

  private createTls(identity: Identity): TlsServer {
    const key = privateKeyPem(identity);
    try {
      const server = createTlsServer(
        {
          ...TLS_PROFILE,
          key,
          cert: identity.certificatePem,
          requestCert: true,
          rejectUnauthorized: false,
          handshakeTimeout: this.limits.handshakeTimeoutMs,
        },
        (socket) => {
          this.classify(socket);
        },
      );
      server.on('tlsClientError', (_error, socket) => {
        socket.destroy();
        this.hooks.record({
          kind: 'tls_failed',
          address: normalizeRemoteAddress(socket.remoteAddress),
          port: normalizeRemotePort(socket.remotePort),
        });
      });
      return server;
    } finally {
      key.fill(0);
    }
  }

  private onRaw(socket: Socket): void {
    socket.on('error', noop);
    const address = normalizeRemoteAddress(socket.remoteAddress);
    const port = normalizeRemotePort(socket.remotePort);
    const tls = this.tls;
    if (tls === null) {
      socket.destroy();
      return;
    }
    if (!this.concurrency.acquire(address, this.limits.perAddressConcurrent)) {
      socket.destroy();
      this.hooks.record({ kind: 'rate_limited', address, port });
      return;
    }
    this.raw.add(socket);
    socket.once('close', () => {
      this.raw.delete(socket);
      this.concurrency.release(address);
    });
    if (!this.buckets.take(address)) {
      socket.destroy();
      this.hooks.record({ kind: 'rate_limited', address, port });
      return;
    }
    tls.emit('connection', socket);
  }

  private classify(socket: TLSSocket): void {
    socket.on('error', noop);
    const address = normalizeRemoteAddress(socket.remoteAddress);
    const port = normalizeRemotePort(socket.remotePort);
    const reject = (kind: RemoteEventInput['kind']): void => {
      socket.destroy();
      this.hooks.record({ kind, address, port });
    };
    if (this.tls === null) {
      socket.destroy();
      return;
    }
    // 1./2. Resumed session, protocol, cipher, client certificate type (§B.6, never throws).
    const violation = profileViolation(socket, 'server');
    if (violation !== null) {
      reject(violation === 'certificate' ? 'bad_certificate' : 'tls_failed');
      return;
    }
    let pin: string | null = null;
    try {
      pin = tryPinOfCertificate(socket.getPeerX509Certificate()?.raw);
    } catch {
      pin = null;
    }
    if (pin === null) {
      reject('bad_certificate');
      return;
    }
    // 3. The coupled computer → connection proof first.
    const coupling = this.hooks.coupling();
    if (coupling !== null && pinsEqual(pin, coupling.pin)) {
      if (this.peers.size >= this.limits.peerSockets) {
        reject('rate_limited');
        return;
      }
      this.acceptPeer(socket, coupling, address, port);
      return;
    }
    // 4. Open pairing window.
    const windowId = this.hooks.pairingWindowId();
    if (windowId !== null) {
      if (this.pairing.size >= this.limits.pairingSockets) {
        reject('pair_rate_limited');
        return;
      }
      const info: RemoteSocketInfo = {
        cls: 'pairing',
        generation: -1,
        windowId,
        address,
        port,
        proven: false,
      };
      this.infos.set(socket, info);
      this.pairing.add(socket);
      socket.once('close', () => {
        this.pairing.delete(socket);
      });
      this.hooks.onPairing(socket, info);
      return;
    }
    // 5. Unknown or revoked key.
    reject(this.hooks.isRevoked(pin) ? 'revoked_key' : 'unknown_key');
  }

  private acceptPeer(
    socket: TLSSocket,
    coupling: ListenerCoupling,
    address: string,
    port: number | null,
  ): void {
    const info: RemoteSocketInfo = {
      cls: 'peer',
      generation: coupling.generation,
      windowId: null,
      address,
      port,
      proven: false,
    };
    this.infos.set(socket, info);
    this.peers.add(socket);
    socket.once('close', () => {
      this.peers.delete(socket);
      if (this.proven.delete(socket)) this.hooks.onPeerCount(this.proven.size, info);
    });
    void proveAsServer(socket, coupling.authKey, this.limits.proofTimeoutMs).then((failure) => {
      if (failure !== null) {
        socket.destroy();
        // A valid key with a wrong secret is a strong warning sign (§B.9); a plain close is not.
        if (failure !== 'closed') this.hooks.record({ kind: 'proof_failed', address, port });
        return;
      }
      if (socket.destroyed || this.tls === null || info.generation !== this.hooks.generation()) {
        socket.destroy();
        return;
      }
      info.proven = true;
      this.proven.add(socket);
      this.hooks.onPeerCount(this.proven.size, info);
      this.hooks.onPeer(socket, info);
    });
  }
}
