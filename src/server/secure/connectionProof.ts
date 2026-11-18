/**
 * Connection proof (docs/wp/WP-76.md §B.9, ADR-206): after the ML-DSA mTLS handshake and BEFORE any
 * HTTP byte, both ends prove the coupling secret kAuth. A forger must break ML-DSA-87 AND know the
 * 384-bit secret.
 *
 *   Tc     = lp('parallax-conn-v1') ‖ lp(exporter(48, 'EXPERIMENTAL-parallax-conn-v1')) ‖ lp(spkiB) ‖ lp(spkiA)
 *   client → server: exactly 52 bytes 'PXC1' ‖ HMAC-SHA-384(kAuth, lp('initiator') ‖ Tc)
 *   server → client: exactly 52 bytes 'PXS1' ‖ HMAC-SHA-384(kAuth, lp('responder') ‖ Tc)
 *
 * The reader takes exactly 52 bytes within 10 s; more bytes before the answer, a timeout, a close or
 * a wrong value → false (the caller destroys the socket). Never throws. Reading uses the paused
 * (`readable`) mode and leaves the stream so that a later `data` listener (HTTP parser, `ws`) gets
 * every following byte (verified with `http.Server`, Fastify, `https.Agent` and `ws`).
 */
import { createHmac } from 'node:crypto';
import type { TLSSocket } from 'node:tls';
import { lp, type PairingRole } from './pairingCrypto';
import { bytesEqual, connectionSpkis } from './pins';
import { HASH, SECRET_BYTES, exportKeyingMaterial } from './tlsProfile';

export const CONN_LABEL = 'parallax-conn-v1';
export const PROOF_TAGS = { initiator: 'PXC1', responder: 'PXS1' } as const;
export const PROOF_BYTES = 4 + SECRET_BYTES;
export const PROOF_TIMEOUT_MS = 10_000;

/** Tc of this connection (from the socket: exporter and both certificates). Throws without certificates. */
export function connectionTranscript(socket: TLSSocket, side: 'client' | 'server'): Buffer {
  const { spkiA, spkiB } = connectionSpkis(socket, side);
  const ekm = exportKeyingMaterial(socket, 'conn');
  const transcript = Buffer.concat([lp(CONN_LABEL), lp(ekm), lp(spkiB), lp(spkiA)]);
  ekm.fill(0);
  return transcript;
}

/** The 52-byte message of `role`. */
export function proofMessage(kAuth: Uint8Array, role: PairingRole, transcript: Uint8Array): Buffer {
  const mac = createHmac(HASH, kAuth).update(lp(role)).update(transcript).digest();
  return Buffer.concat([Buffer.from(PROOF_TAGS[role], 'ascii'), mac]);
}

/** Constant-time check of a received proof (tag and MAC; never throws). */
export function proofMatches(
  received: Uint8Array,
  kAuth: Uint8Array,
  role: PairingRole,
  transcript: Uint8Array,
): boolean {
  try {
    if (received.length !== PROOF_BYTES) return false;
    const expected = proofMessage(kAuth, role, transcript);
    // Tag and MAC together in one constant-time comparison.
    const ok = bytesEqual(expected, received);
    expected.fill(0);
    return ok;
  } catch {
    return false;
  }
}

export type ReadFailure = 'excess' | 'timeout' | 'closed';

/**
 * Reads exactly `bytes` bytes in paused mode. More bytes in the buffer than asked → `excess`.
 * On success the stream holds nothing of ours and no listener of ours is left.
 */
export function readExactly(
  socket: TLSSocket,
  bytes: number,
  timeoutMs: number,
): Promise<{ ok: true; data: Buffer } | { ok: false; reason: ReadFailure }> {
  return new Promise((resolve) => {
    const chunks: Buffer[] = [];
    let size = 0;
    let done = false;
    const finish = (result: { ok: true; data: Buffer } | { ok: false; reason: ReadFailure }): void => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      socket.removeListener('readable', onReadable);
      socket.removeListener('end', onClosed);
      socket.removeListener('close', onClosed);
      socket.removeListener('error', onClosed);
      if (!result.ok) {
        for (const chunk of chunks) chunk.fill(0);
      }
      resolve(result);
    };
    const onReadable = (): void => {
      for (
        let chunk = socket.read() as Buffer | null;
        chunk !== null;
        chunk = socket.read() as Buffer | null
      ) {
        chunks.push(chunk);
        size += chunk.length;
        if (size > bytes) {
          finish({ ok: false, reason: 'excess' });
          return;
        }
      }
      if (size === bytes) {
        const data = Buffer.concat(chunks);
        for (const chunk of chunks) chunk.fill(0);
        finish({ ok: true, data });
      }
    };
    const onClosed = (): void => {
      finish({ ok: false, reason: 'closed' });
    };
    const timer = setTimeout(() => {
      finish({ ok: false, reason: 'timeout' });
    }, timeoutMs);
    if (socket.destroyed || !socket.readable) {
      finish({ ok: false, reason: 'closed' });
      return;
    }
    socket.on('readable', onReadable);
    socket.once('end', onClosed);
    socket.once('close', onClosed);
    socket.once('error', onClosed);
  });
}

export type ProofFailure = ReadFailure | 'mismatch' | 'transcript';

/**
 * Sharing computer (TLS server): read 'PXC1' ‖ mac, check it, answer 'PXS1' ‖ mac. Null = proven;
 * otherwise the reason (the caller destroys the socket and logs `proof_failed`).
 */
export async function proveAsServer(
  socket: TLSSocket,
  kAuth: Uint8Array,
  timeoutMs = PROOF_TIMEOUT_MS,
): Promise<ProofFailure | null> {
  let transcript: Buffer;
  try {
    transcript = connectionTranscript(socket, 'server');
  } catch {
    return 'transcript';
  }
  try {
    const read = await readExactly(socket, PROOF_BYTES, timeoutMs);
    if (!read.ok) return read.reason;
    const ok = proofMatches(read.data, kAuth, 'initiator', transcript);
    read.data.fill(0);
    if (!ok) return 'mismatch';
    if (socket.destroyed) return 'closed';
    socket.write(proofMessage(kAuth, 'responder', transcript));
    return null;
  } catch {
    return 'closed';
  } finally {
    transcript.fill(0);
  }
}

/** Controlling computer (TLS client): send 'PXC1' ‖ mac, read and check 'PXS1' ‖ mac. Null = proven. */
export async function proveAsClient(
  socket: TLSSocket,
  kAuth: Uint8Array,
  timeoutMs = PROOF_TIMEOUT_MS,
): Promise<ProofFailure | null> {
  let transcript: Buffer;
  try {
    transcript = connectionTranscript(socket, 'client');
  } catch {
    return 'transcript';
  }
  try {
    if (socket.destroyed) return 'closed';
    socket.write(proofMessage(kAuth, 'initiator', transcript));
    const read = await readExactly(socket, PROOF_BYTES, timeoutMs);
    if (!read.ok) return read.reason;
    const ok = proofMatches(read.data, kAuth, 'responder', transcript);
    read.data.fill(0);
    return ok ? null : 'mismatch';
  } catch {
    return 'closed';
  } finally {
    transcript.fill(0);
  }
}
