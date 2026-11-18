/**
 * Pairing, controlling side (docs/wp/WP-76.md §B.7 steps 1–2, 5 and 8; ADR-207) – used by WP-79
 * (`hosts.add`). One own socket (no agent pool), exactly one HTTP request:
 *
 *  1. TLS with the §B.3 profile and the coupling's NEW key (`generateIdentity('coupling:<hostId>')`,
 *     in memory), `rejectUnauthorized: false` (no pin yet), no SNI. After `secureConnect`: no
 *     resumption, TLS 1.3 / suite / group, server certificate present and ML-DSA-87.
 *  2. `spkiB`, `spkiA` and both exporters from THIS socket.
 *  5. `POST /remote/v1/pair` with `{deviceName, macA}` (body written only after `secureConnect`).
 *  8. Check `macB` in constant time; only then derive kAuth. On any failure nothing is returned.
 *
 * The caller stores (only after success): the coupling key (`FileIdentityStore.save`), the peer
 * certificate and pin, and DPAPI(kAuth) (`auth:<hostId>`) in hosts.json – then builds a
 * `PinnedAgent`. It zeroes `authKey` when the coupling ends.
 */
import { request } from 'node:http';
import { connect, type TLSSocket } from 'node:tls';
import { errorPayloadSchema, makeError, type ErrorCode, type ErrorPayload } from '@shared/errors';
import { REMOTE_PATHS, remotePairResponseSchema, type RemotePairRequest } from '@shared/http';
import { parsePairingCode } from '@shared/pairing';
import { PROTOCOL_VERSION } from '@shared/protocol';
import {
  decodeMac,
  deriveAuthKey,
  encodeMac,
  macEquals,
  pairingKey,
  pairingMac,
  pairingMaterial,
  wipePairingMaterial,
} from './pairingCrypto';
import { pinOfCertificate } from './pins';
import { remoteVersionHeaders } from './pinnedAgent';
import type { Identity } from './ports';
import { HANDSHAKE_TIMEOUT_MS, TLS_PROFILE, privateKeyPem, profileViolation } from './tlsProfile';

export const PAIR_TIMEOUT_MS = 30_000;
/** Largest answer read from the sharing computer. */
export const PAIR_RESPONSE_MAX_BYTES = 8 * 1024;

/** Error codes the sharing computer may answer with (anything else → HOST_UNREACHABLE {reason:'closed'}). */
const PASSED_THROUGH: ReadonlySet<ErrorCode> = new Set<ErrorCode>([
  'PAIRING_INVALID',
  'PAIRING_EXPIRED',
  'PAIRING_RATE_LIMITED',
  'HOST_INCOMPATIBLE',
  'REMOTE_ACCESS_FAILED',
]);

/** `error`: VALIDATION_FAILED {reason:'code'}, PAIRING_*, HOST_UNREACHABLE {reason}, HOST_INCOMPATIBLE, REMOTE_ACCESS_FAILED. */
export class PairingClientError extends Error {
  readonly error: ErrorPayload;

  constructor(error: ErrorPayload) {
    super(error.code);
    this.name = 'PairingClientError';
    this.error = error;
  }
}

export interface PairWithHostOptions {
  address: string;
  port: number;
  /** The code as typed (tolerant format of @shared/pairing) or its 16 bytes. */
  code: string | Uint8Array;
  /** Name this computer gives itself (`remotePairRequestSchema.deviceName`). */
  deviceName: string;
  /** The coupling's new key and certificate (in memory; stored by the caller only after success). */
  identity: Identity;
  /** This computer's Parallax version (REMOTE_HEADERS; must equal the other side's). */
  appVersion: string;
  timeoutMs?: number;
  signal?: AbortSignal;
}

export interface PairWithHostResult {
  /** The sharing computer's whole certificate (DER) – `HostRecord.peerCertificate`. */
  peerCertificateDer: Buffer;
  /** Its pin – `HostRecord.peerPin`. */
  peerPin: string;
  /** kAuth (48 bytes) – protect with the key store (`auth:<hostId>`), zero after use. */
  authKey: Buffer;
  hostName: string;
  appVersion: string;
  protocolVersion: number;
}

function unreachable(reason: string): PairingClientError {
  return new PairingClientError(makeError('HOST_UNREACHABLE', { reason }));
}

function socketErrorReason(error: unknown): string {
  const code = typeof error === 'object' && error !== null && 'code' in error ? String(error.code) : '';
  if (code === 'ECONNREFUSED') return 'refused';
  if (code === 'ETIMEDOUT') return 'timeout';
  if (code.startsWith('ERR_SSL_') || code.startsWith('ERR_TLS_') || code.startsWith('ERR_OSSL_'))
    return 'tls';
  return 'network';
}

/** Copy of the 16 code bytes, or VALIDATION_FAILED {reason:'code'} (checked locally, no attempt used). */
function codeBytes(code: string | Uint8Array): Buffer {
  const bytes = typeof code === 'string' ? parsePairingCode(code) : code;
  if (bytes?.length !== 16) {
    throw new PairingClientError(makeError('VALIDATION_FAILED', { reason: 'code' }));
  }
  return Buffer.from(bytes);
}

/** Opens the pairing socket and waits for `secureConnect` plus the profile checks of step 1. */
function openPairingSocket(options: PairWithHostOptions, deadline: AbortSignal): Promise<TLSSocket> {
  return new Promise<TLSSocket>((resolve, reject) => {
    const key = privateKeyPem(options.identity);
    let socket: TLSSocket;
    try {
      socket = connect({
        ...TLS_PROFILE,
        host: options.address,
        port: options.port,
        key,
        cert: options.identity.certificatePem,
        rejectUnauthorized: false,
        servername: '',
      });
    } catch (error) {
      reject(unreachable(socketErrorReason(error)));
      return;
    } finally {
      key.fill(0);
    }
    const fail = (error: PairingClientError): void => {
      cleanup();
      socket.destroy();
      reject(error);
    };
    const onError = (error: Error): void => {
      fail(unreachable(socketErrorReason(error)));
    };
    const onClose = (): void => {
      fail(unreachable('closed'));
    };
    const onAbort = (): void => {
      fail(unreachable('timeout'));
    };
    const handshakeTimer = setTimeout(onAbort, HANDSHAKE_TIMEOUT_MS);
    const cleanup = (): void => {
      clearTimeout(handshakeTimer);
      socket.removeListener('error', onError);
      socket.removeListener('close', onClose);
      deadline.removeEventListener('abort', onAbort);
    };
    socket.on('error', onError);
    socket.once('close', onClose);
    deadline.addEventListener('abort', onAbort, { once: true });
    socket.once('secureConnect', () => {
      const violation = profileViolation(socket, 'client');
      if (violation !== null) {
        fail(unreachable('tls'));
        return;
      }
      cleanup();
      socket.on('error', () => undefined);
      resolve(socket);
    });
  });
}

/** Sends the one request over `socket` and returns status and body (≤ PAIR_RESPONSE_MAX_BYTES). */
function postPair(
  socket: TLSSocket,
  body: Buffer,
  options: PairWithHostOptions,
  deadline: AbortSignal,
): Promise<{ status: number; body: Buffer }> {
  return new Promise((resolve, reject) => {
    const req = request(
      {
        createConnection: () => socket,
        // Only for the Host header (HTTP/1.1 requires one); the socket is already connected.
        host: options.address,
        port: options.port,
        method: 'POST',
        path: REMOTE_PATHS.pair,
        signal: deadline,
        headers: {
          'content-type': 'application/json',
          'content-length': String(body.length),
          connection: 'close',
          ...remoteVersionHeaders(options.appVersion),
        },
      },
      (res) => {
        const chunks: Buffer[] = [];
        let size = 0;
        res.on('data', (chunk: Buffer) => {
          size += chunk.length;
          if (size > PAIR_RESPONSE_MAX_BYTES) {
            res.destroy();
            reject(unreachable('closed'));
            return;
          }
          chunks.push(chunk);
        });
        res.on('end', () => {
          resolve({ status: res.statusCode ?? 0, body: Buffer.concat(chunks) });
        });
        res.on('error', () => {
          reject(unreachable('closed'));
        });
      },
    );
    req.on('error', (error) => {
      reject(deadline.aborted ? unreachable('timeout') : unreachable(socketErrorReason(error)));
    });
    req.end(body);
  });
}

function parseJson(body: Buffer): unknown {
  try {
    return JSON.parse(body.toString('utf8'));
  } catch {
    return null;
  }
}

/** Params kept from an (unauthenticated) error answer: short scalars of known keys only. */
const PASSED_PARAMS = ['reason', 'version', 'protocol'] as const;

/** The error a non-200 answer carries (only the codes of a pairing). */
function answerError(status: number, body: Buffer): PairingClientError {
  const parsed = errorPayloadSchema.safeParse(parseJson(body));
  if (parsed.success && PASSED_THROUGH.has(parsed.data.code)) {
    const params: Record<string, string | number> = {};
    for (const key of PASSED_PARAMS) {
      const value = parsed.data.params[key];
      if (
        (typeof value === 'string' && value.length <= 64) ||
        (typeof value === 'number' && Number.isFinite(value))
      ) {
        params[key] = value;
      }
    }
    return new PairingClientError(makeError(parsed.data.code, params));
  }
  return unreachable(status === 0 ? 'closed' : `status_${String(status)}`);
}

/**
 * Pairs with a sharing computer (§B.7). Resolves only after `macB` was verified; throws
 * PairingClientError otherwise. Secrets (code, k, exporters, kAuth on failure) are zeroed.
 */
export async function pairWithHost(options: PairWithHostOptions): Promise<PairWithHostResult> {
  const code = codeBytes(options.code);
  const timeout = AbortSignal.timeout(options.timeoutMs ?? PAIR_TIMEOUT_MS);
  const deadline = options.signal === undefined ? timeout : AbortSignal.any([timeout, options.signal]);
  let socket: TLSSocket | null = null;
  let k: Buffer | null = null;
  let material: ReturnType<typeof pairingMaterial> | null = null;
  try {
    socket = await openPairingSocket(options, deadline);
    const peer = socket.getPeerX509Certificate();
    if (peer === undefined) throw unreachable('tls');
    const peerCertificateDer = Buffer.from(peer.raw);
    const peerPin = pinOfCertificate(peerCertificateDer);
    material = pairingMaterial(socket, 'client');
    k = pairingKey(code);
    const payload: RemotePairRequest = {
      deviceName: options.deviceName,
      macA: encodeMac(pairingMac(k, 'initiator', material.transcript)),
    };
    const answer = await postPair(socket, Buffer.from(JSON.stringify(payload), 'utf8'), options, deadline);
    if (answer.status !== 200) throw answerError(answer.status, answer.body);
    const parsed = remotePairResponseSchema.safeParse(parseJson(answer.body));
    if (!parsed.success) throw new PairingClientError(makeError('PAIRING_INVALID'));
    const macB = decodeMac(parsed.data.macB);
    const expected = pairingMac(k, 'responder', material.transcript);
    const valid = macB !== null && macEquals(expected, macB);
    expected.fill(0);
    if (!valid) throw new PairingClientError(makeError('PAIRING_INVALID'));
    if (parsed.data.protocolVersion !== PROTOCOL_VERSION || parsed.data.appVersion !== options.appVersion) {
      throw new PairingClientError(
        makeError('HOST_INCOMPATIBLE', {
          version: parsed.data.appVersion,
          protocol: parsed.data.protocolVersion,
        }),
      );
    }
    const authKey = deriveAuthKey(material.ekmAuth, material.transcript);
    return {
      peerCertificateDer,
      peerPin,
      authKey,
      hostName: parsed.data.hostName,
      appVersion: parsed.data.appVersion,
      protocolVersion: parsed.data.protocolVersion,
    };
  } catch (error) {
    if (error instanceof PairingClientError) throw error;
    throw unreachable(deadline.aborted ? 'timeout' : socketErrorReason(error));
  } finally {
    code.fill(0);
    k?.fill(0);
    if (material !== null) wipePairingMaterial(material);
    socket?.destroy();
  }
}
