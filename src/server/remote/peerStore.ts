/**
 * `<home>/remote/peer.json` – the one coupled computer and the pins of the last revoked couplings
 * (docs/wp/WP-76.md §B.7 step 7.3, §B.8). A strict file (no `.bak`, every important write awaited).
 *
 * - `set()` writes first and changes the memory only after the write succeeded (a failed pairing
 *   stores nothing).
 * - `clear()` changes the memory first (the coupling is gone at once), then writes; a failed write
 *   leaves `writeFailed` set until a later write succeeds (`flush()`).
 * - `touch()` updates last contact in memory at most once a minute and writes debounced.
 * - All writes are serialized and write the state of their own moment, so a late `touch` write can
 *   never bring back a cleared coupling.
 * - On load a record whose pin does not match its certificate (or whose key is not ML-DSA-87) is
 *   quarantined – a tampered file never yields a coupling.
 */
import { X509Certificate } from 'node:crypto';
import path from 'node:path';
import {
  REMOTE_PEER_SCHEMA_VERSION,
  remotePeerFileSchema,
  remotePeerRecordSchema,
  type RemotePeerFile,
  type RemotePeerRecord,
} from '@shared/model';
import { toError } from '../lib/async';
import { logger as rootLogger } from '../lib/logger';
import { pinOfCertificate, pinsEqual } from '../secure/pins';
import {
  quarantineStrictFile,
  readStrictJson,
  writeStrictJson,
  type StrictFileOptions,
} from '../secure/strictJsonFile';
import { KEY_ALGORITHM } from '../secure/tlsProfile';
import { REMOTE_DIR } from './eventLog';
import type { PeerStore } from './ports';

export const PEER_FILE = 'peer.json';
/** Last contact changes in memory (and HostState) at most this often per address. */
export const PEER_TOUCH_INTERVAL_MS = 60_000;

export interface PeerStoreOptions extends StrictFileOptions {
  home: string;
  /** Pins of revoked couplings kept (schema maximum 8). */
  revokedMax?: number;
  debounceMs?: number;
}

export interface FilePeerStore extends PeerStore {
  /** Reads the file once. Throws StoreVersionTooNewError (file untouched) or a read error. */
  load(): Promise<void>;
  readonly loaded: boolean;
  /** Was this pin coupled before (connection log `revoked_key`)? Constant-time comparisons. */
  isRevoked(pin: string): boolean;
  /** A write after `clear()` failed: the file may still hold the revoked coupling. */
  readonly writeFailed: boolean;
}

interface State {
  peer: RemotePeerRecord | null;
  revoked: string[];
}

/** The certificate parses, is ML-DSA-87 and matches the pin. */
function recordConsistent(record: RemotePeerRecord): boolean {
  try {
    const der = Buffer.from(record.certificate, 'base64');
    const certificate = new X509Certificate(der);
    if (certificate.publicKey.asymmetricKeyType !== KEY_ALGORITHM) return false;
    return pinsEqual(pinOfCertificate(der), record.pin);
  } catch {
    return false;
  }
}

function withRevoked(revoked: readonly string[], pin: string, max: number): string[] {
  const next = revoked.filter((entry) => entry !== pin);
  next.push(pin);
  return next.slice(Math.max(0, next.length - max));
}

export function createPeerStore(options: PeerStoreOptions): FilePeerStore {
  const file = path.join(options.home, REMOTE_DIR, PEER_FILE);
  const revokedMax = Math.min(options.revokedMax ?? 8, 8);
  const debounceMs = options.debounceMs ?? 2_000;
  const log = (options.logger ?? rootLogger).child({ module: 'peerStore' });
  let state: State = { peer: null, revoked: [] };
  let loaded = false;
  let loading: Promise<void> | null = null;
  let queue: Promise<void> = Promise.resolve();
  let dirty = false;
  let writeFailed = false;
  let timer: NodeJS.Timeout | null = null;

  const snapshot = (value: State): RemotePeerFile => ({
    schemaVersion: REMOTE_PEER_SCHEMA_VERSION,
    peer: value.peer,
    revoked: value.revoked,
  });

  /** Queues a write of `value()` (evaluated when the write starts). */
  const enqueue = (value: () => State): Promise<void> => {
    const job = queue.then(() => writeStrictJson(file, snapshot(value()), options));
    queue = job.catch(() => undefined);
    return job;
  };

  const clearTimer = (): void => {
    if (timer !== null) clearTimeout(timer);
    timer = null;
  };

  const writeCurrent = async (): Promise<void> => {
    clearTimer();
    dirty = false;
    try {
      await enqueue(() => state);
      writeFailed = false;
    } catch (error) {
      dirty = true;
      throw toError(error);
    }
  };

  const schedule = (): void => {
    if (timer !== null) return;
    timer = setTimeout(() => {
      timer = null;
      writeCurrent().catch((error: unknown) => {
        log.warn({ err: error }, 'peer contact not stored');
      });
    }, debounceMs);
    timer.unref();
  };

  return {
    get loaded() {
      return loaded;
    },
    get writeFailed() {
      return writeFailed;
    },
    load() {
      loading ??= (async () => {
        const read = await readStrictJson(file, remotePeerFileSchema, REMOTE_PEER_SCHEMA_VERSION, options);
        if (read.kind === 'ok') {
          const value = read.value;
          if (value.peer !== null && !recordConsistent(value.peer)) {
            await quarantineStrictFile(file, 'peer_certificate', options);
            state = { peer: null, revoked: value.revoked };
          } else {
            state = { peer: value.peer, revoked: value.revoked };
          }
        }
        loaded = true;
      })().catch((error: unknown) => {
        loading = null;
        throw toError(error);
      });
      return loading;
    },
    get() {
      return state.peer;
    },
    async set(peer) {
      const record = remotePeerRecordSchema.parse(peer);
      if (!recordConsistent(record)) throw new Error('peer certificate does not match its pin');
      const base = state;
      const next: State = {
        peer: record,
        revoked:
          base.peer === null || base.peer.pin === record.pin
            ? base.revoked.filter((pin) => pin !== record.pin)
            : withRevoked(base.revoked, base.peer.pin, revokedMax).filter((pin) => pin !== record.pin),
      };
      clearTimer();
      await enqueue(() => next);
      state = next;
      dirty = false;
      writeFailed = false;
    },
    async clear() {
      const peer = state.peer;
      if (peer !== null) state = { peer: null, revoked: withRevoked(state.revoked, peer.pin, revokedMax) };
      else if (!dirty && !writeFailed) return;
      try {
        await writeCurrent();
      } catch (error) {
        writeFailed = true;
        throw error;
      }
    },
    touch(address, at) {
      const peer = state.peer;
      if (peer === null) return;
      const last = peer.lastSeenAt === null ? Number.NEGATIVE_INFINITY : Date.parse(peer.lastSeenAt);
      if (peer.lastAddress === address && at.getTime() - last < PEER_TOUCH_INTERVAL_MS) return;
      state = {
        ...state,
        peer: { ...peer, lastSeenAt: at.toISOString(), lastAddress: address.slice(0, 64) },
      };
      dirty = true;
      schedule();
    },
    async flush() {
      if (!dirty && !writeFailed) {
        await queue;
        return;
      }
      await writeCurrent();
    },
    isRevoked(pin) {
      let found = false;
      for (const entry of state.revoked) found = pinsEqual(entry, pin) || found;
      return found;
    },
  };
}
