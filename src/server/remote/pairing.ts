/**
 * The sharing side of a pairing (docs/wp/WP-76.md §B.7 steps 6–7). Checks in this order:
 *
 * 6.1 the socket is a `pairing` socket of the OPEN window; 6.2 the window has not expired;
 * 6.3 rate limit (5 per address and minute, 20 in total); 6.4 `macA` in constant time.
 * A failure counts (after 3 the window closes), is logged, stores nothing and closes the socket.
 *
 * Then (only with the right code): the version headers must match (409 HOST_INCOMPATIBLE, the code
 * is used up – an addition to §B.7 so that no coupling is stored that the other side refuses);
 * 7.1 window closed, code used up; 7.2 `kAuth` from the auth exporter; 7.3 the peer is written
 * (`commit`, a failure → REMOTE_ACCESS_FAILED and nothing stored); 7.4 answer with `macB`;
 * 7.5 the transport closes the socket after the answer.
 *
 * Code, `k`, the exporters and `kAuth` are zeroed after use; nothing secret is logged.
 */
import type { IncomingHttpHeaders } from 'node:http';
import type { TLSSocket } from 'node:tls';
import type { Logger } from 'pino';
import { makeError, type ErrorPayload } from '@shared/errors';
import { remotePairRequestSchema, type RemotePairResponse } from '@shared/http';
import { PROTOCOL_VERSION } from '@shared/protocol';
import type { ServerInstance } from '../config';
import { logger as rootLogger } from '../lib/logger';
import {
  decodeMac,
  deriveAuthKey,
  encodeMac,
  macEquals,
  pairingKey,
  pairingMac,
  pairingMaterial,
  wipePairingMaterial,
  type PairingMaterial,
} from '../secure/pairingCrypto';
import { pinOfCertificate } from '../secure/pins';
import { CommandError } from '../sync/ports';
import { normalizeRemoteAddress, normalizeRemotePort, sanitizeClaimedName } from './addresses';
import { MinuteWindow, REMOTE_LIMITS, type RemoteLimits } from './limits';
import type { RemoteSocketInfo } from './listener';
import { errorAnswer, type PairingAnswer } from './pairingHttp';
import type { PairingWindow } from './pairingWindow';
import { remoteVersionOf } from './headers';
import type { RemoteEventInput } from './ports';

/** What the service stores after a successful check (7.3). */
export interface PairingCommit {
  name: string;
  certificateDer: Buffer;
  pin: string;
  /** Plaintext kAuth – the commit protects/copies it; the responder zeroes it afterwards. */
  kAuth: Buffer;
  address: string;
}

export interface PairingResponderDeps {
  window: PairingWindow;
  instance: ServerInstance;
  hostName: () => string;
  socketInfo: (socket: TLSSocket) => RemoteSocketInfo | undefined;
  /** Writes the peer (7.3); throws (CommandError) when nothing was stored. */
  commit: (peer: PairingCommit) => Promise<void>;
  record: (event: RemoteEventInput) => void;
  /** The window closed after failures or use: end its other sockets (not the answering one). */
  destroyPairingSockets: (except: TLSSocket) => void;
  limits?: RemoteLimits;
  now?: () => number;
  logger?: Logger;
}

/** Fallback name when the sent name is empty after removing control characters. */
const UNNAMED = 'Parallax';

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export class PairingResponder {
  private readonly perAddress: MinuteWindow;
  private readonly total: MinuteWindow;
  private readonly log: Logger;

  constructor(private readonly deps: PairingResponderDeps) {
    const limits = deps.limits ?? REMOTE_LIMITS;
    this.perAddress = new MinuteWindow(limits.pairingPerAddressPerMinute, deps.now);
    this.total = new MinuteWindow(limits.pairingTotalPerMinute, deps.now);
    this.log = (deps.logger ?? rootLogger).child({ module: 'remotePairing' });
  }

  /** The answer for one pairing request, or null when the socket is gone (no answer). Never throws. */
  async respond(
    socket: TLSSocket,
    body: unknown,
    headers: IncomingHttpHeaders,
  ): Promise<PairingAnswer | null> {
    try {
      return await this.decide(socket, body, headers);
    } catch (error) {
      this.log.error({ err: error }, 'pairing check failed');
      return null;
    }
  }

  private async decide(
    socket: TLSSocket,
    body: unknown,
    headers: IncomingHttpHeaders,
  ): Promise<PairingAnswer | null> {
    const { window } = this.deps;
    const info = this.deps.socketInfo(socket);
    const address = info?.address ?? normalizeRemoteAddress(socket.remoteAddress);
    const port = info?.port ?? normalizeRemotePort(socket.remotePort);
    const claimedName =
      isRecord(body) && typeof body.deviceName === 'string' ? sanitizeClaimedName(body.deviceName) : null;
    const event = (kind: RemoteEventInput['kind'], name: string | null = claimedName): void => {
      this.deps.record({ kind, address, port, claimedName: name });
    };
    const refuse = (kind: RemoteEventInput['kind'], error: ErrorPayload): PairingAnswer => {
      event(kind);
      return errorAnswer(error);
    };

    // 6.1 socket of the open window
    const windowId = info?.cls === 'pairing' ? info.windowId : null;
    if (windowId === null || !window.isCurrent(windowId))
      return refuse('pair_expired', makeError('PAIRING_EXPIRED'));
    // 6.2 not expired
    if (window.isExpired(windowId)) {
      window.close('lapsed');
      this.deps.destroyPairingSockets(socket);
      return refuse('pair_expired', makeError('PAIRING_EXPIRED'));
    }
    // 6.3 rate limit
    if (!this.perAddress.hit(address) || !this.total.hit('*')) {
      return refuse('pair_rate_limited', makeError('PAIRING_RATE_LIMITED'));
    }
    // 6.4 macA (constant time)
    const parsed = remotePairRequestSchema.safeParse(body);
    const macA = parsed.success ? decodeMac(parsed.data.macA) : null;
    let material: PairingMaterial | null = null;
    let code: Buffer | null = null;
    let k: Buffer | null = null;
    try {
      try {
        material = pairingMaterial(socket, 'server');
      } catch {
        return null;
      }
      code = window.codeFor(windowId);
      if (code === null) return refuse('pair_expired', makeError('PAIRING_EXPIRED'));
      k = pairingKey(code);
      const expected = pairingMac(k, 'initiator', material.transcript);
      const valid = macA !== null && macEquals(expected, macA);
      expected.fill(0);
      if (!valid || !parsed.success) {
        if (window.fail(windowId)) this.deps.destroyPairingSockets(socket);
        return refuse('pair_failed', makeError('PAIRING_INVALID'));
      }

      // The code is proven. Versions must match before anything is stored.
      const version = remoteVersionOf(headers, this.deps.instance.serverVersion);
      if (!version.compatible) {
        if (window.consume(windowId)) this.deps.destroyPairingSockets(socket);
        return refuse(
          'version_mismatch',
          makeError('HOST_INCOMPATIBLE', {
            version: this.deps.instance.serverVersion,
            protocol: PROTOCOL_VERSION,
          }),
        );
      }
      // 7.1 close the window; the code is used up
      if (!window.consume(windowId)) return refuse('pair_expired', makeError('PAIRING_EXPIRED'));
      this.deps.destroyPairingSockets(socket);
      // 7.2 kAuth
      const kAuth = deriveAuthKey(material.ekmAuth, material.transcript);
      const name = sanitizeClaimedName(parsed.data.deviceName) ?? UNNAMED;
      // 7.3 write the peer
      try {
        const raw = socket.getPeerX509Certificate()?.raw;
        if (raw === undefined) return null;
        const certificateDer = Buffer.from(raw);
        await this.deps.commit({
          name,
          certificateDer,
          pin: pinOfCertificate(certificateDer),
          kAuth,
          address,
        });
      } catch (error) {
        this.log.error({ err: error }, 'pairing not stored');
        return errorAnswer(
          error instanceof CommandError
            ? error.error
            : makeError('REMOTE_ACCESS_FAILED', { reason: 'store' }),
        );
      } finally {
        kAuth.fill(0);
      }
      // 7.4 answer
      const macB = pairingMac(k, 'responder', material.transcript);
      const payload: RemotePairResponse = {
        macB: encodeMac(macB),
        hostName: this.deps.hostName(),
        appVersion: this.deps.instance.serverVersion,
        protocolVersion: PROTOCOL_VERSION,
      };
      macB.fill(0);
      event('pair_ok', name);
      return { status: 200, payload };
    } finally {
      if (material !== null) wipePairingMaterial(material);
      code?.fill(0);
      k?.fill(0);
    }
  }
}
