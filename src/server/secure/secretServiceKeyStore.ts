/**
 * Key store "Secret Service" (docs/wp/WP-76.md §B.14, Linux with a desktop: GNOME Keyring through
 * libsecret, called with `node:ffi` – spike WP-101 §1.7). Per `purpose` a random 32-byte key lives in
 * the keyring (schema `parallax-keystore-v1`, attribute `purpose`, value Base64); "protected" =
 * AES-256-GCM with that key and `parallax-keystore-v1:<purpose>` as additional data.
 *
 * The libsecret calls are synchronous and block while a locked keyring asks for its password, so
 * they run in a worker thread with a deadline (`SECRET_SERVICE_TIMEOUT_MS`): no answer → the worker is
 * terminated and the call fails with `timeout` (→ REMOTE_KEYSTORE_UNAVAILABLE); the next call starts a
 * new worker. The worker is an inline script (`eval`), so the server bundle needs no extra file.
 * Nothing secret is logged; errors carry only their kind.
 *
 * Tests never reach the keyring of the test machine: they inject `native` (or a worker `source`).
 */
import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import { Worker } from 'node:worker_threads';
import type { Logger } from 'pino';
import { z } from 'zod';
import { logger as rootLogger } from '../lib/logger';
import { KEY_PURPOSE_PATTERN, KEY_STORE_ENTROPY_PREFIX, KEY_STORE_MAX_PLAINTEXT } from './keyStore';
import { KeyStoreError, type KeyPurpose, type KeyStore, type KeyStoreFailure } from './ports';

/** Deadline of one keyring call (a password prompt of a locked keyring counts against it). */
export const SECRET_SERVICE_TIMEOUT_MS = 20_000;
/** Schema name in the keyring (stable: changing it loses every stored key). */
export const SECRET_SCHEMA_NAME = 'parallax-keystore-v1';
const KEY_BYTES = 32;
const IV_BYTES = 12;
const TAG_BYTES = 16;
const MAGIC = Buffer.from('pss1', 'ascii');
const MAX_CIPHERTEXT = 256 * 1024;
const PROBE_RETRY_MS = 60_000;

/** The keyring as the store needs it (seam for tests). Every method rejects with KeyStoreError. */
export interface SecretServiceNative {
  /** The stored Base64 key of `purpose`, or null (also when its keyring stays locked). */
  lookup(purpose: KeyPurpose): Promise<string | null>;
  /** Review WP-109: is an item of `purpose` stored at all – locked or not (nothing is unlocked)? */
  exists(purpose: KeyPurpose): Promise<boolean>;
  store(purpose: KeyPurpose, secret: string): Promise<void>;
  /** Resolves when the keyring answers (a lookup of `identity`); rejects otherwise. */
  probe(): Promise<void>;
  /** Ends the worker (server shutdown, tests). */
  close(): void;
}

/**
 * The worker (plain JavaScript, run with `eval`). Messages `{id, op, purpose, secret?}`; answers
 * `{id, ok, value?, reason?}`. Libraries: libsecret-1.so.0 (≥ 0.19 for the search), libglib-2.0.so.0
 * and libgobject-2.0.so.0 (`ffi.toString` reads the returned C string). `exists` searches without
 * SECRET_SEARCH_UNLOCK (flags 0: locked items are listed, not unlocked) and answers `'1'`/`null`; the
 * list is freed with `g_list_free_full(list, g_object_unref)`. Layout of `SecretSchema` on
 * x86_64: name @0, flags @8, attributes[32] from @16 (16 bytes each: name pointer, type int), 592 bytes.
 */
export const SECRET_SERVICE_WORKER_SOURCE = String.raw`
'use strict';
const { parentPort, workerData } = process.getBuiltinModule('node:worker_threads');
const original = process.emitWarning;
process.emitWarning = (warning, ...rest) => {
  const text = typeof warning === 'string' ? warning : String(warning && warning.message);
  if (/\bFFI\b/.test(text)) return;
  return Reflect.apply(original, process, [warning, ...rest]);
};
let ffi = null;
try { ffi = process.getBuiltinModule('node:ffi'); } catch { ffi = null; }
process.emitWarning = original;
// C strings handed to libsecret must stay alive until the call returned: one list per call.
let scratch = [];
const cstr = (text) => { const b = Buffer.from(text + '\0', 'utf8'); scratch.push(b); return b; };
function open(paths, defs) {
  for (const file of paths) {
    try { return ffi.dlopen(file, defs); } catch { /* next */ }
  }
  return null;
}
let api = null;
function load() {
  if (api !== null) return api;
  if (ffi === null || process.platform !== 'linux' || process.arch !== 'x64') throw new Error('unavailable');
  const glib = open(['libglib-2.0.so.0'], {
    g_hash_table_new: { return: 'pointer', arguments: ['pointer', 'pointer'] },
    g_hash_table_insert: { return: 'int32', arguments: ['pointer', 'buffer', 'buffer'] },
    g_hash_table_unref: { return: 'void', arguments: ['pointer'] },
    g_error_free: { return: 'void', arguments: ['pointer'] },
    g_list_free_full: { return: 'void', arguments: ['pointer', 'pointer'] },
  });
  const gobject = open(['libgobject-2.0.so.0'], {
    g_object_unref: { return: 'void', arguments: ['pointer'] },
  });
  const secret = open(['libsecret-1.so.0'], {
    secret_password_storev_sync: {
      return: 'int32',
      arguments: ['buffer', 'pointer', 'buffer', 'buffer', 'buffer', 'pointer', 'buffer'],
    },
    secret_password_lookupv_sync: { return: 'pointer', arguments: ['buffer', 'pointer', 'pointer', 'buffer'] },
    secret_password_searchv_sync: {
      return: 'pointer',
      arguments: ['buffer', 'pointer', 'int32', 'pointer', 'buffer'],
    },
    secret_password_free: { return: 'void', arguments: ['pointer'] },
  });
  if (glib === null || gobject === null || secret === null) throw new Error('unavailable');
  const strHash = ffi.dlsym(glib.lib, 'g_str_hash');
  const strEqual = ffi.dlsym(glib.lib, 'g_str_equal');
  const objectUnref = ffi.dlsym(gobject.lib, 'g_object_unref');
  if (!strHash || !strEqual || !objectUnref) throw new Error('unavailable');
  const schema = Buffer.alloc(592);
  const schemaName = Buffer.from(workerData.schemaName + '\0', 'utf8');
  const attributeName = Buffer.from('purpose\0', 'utf8');
  schema.writeBigUInt64LE(ffi.getRawPointer(schemaName), 0);
  schema.writeInt32LE(0, 8);
  schema.writeBigUInt64LE(ffi.getRawPointer(attributeName), 16);
  schema.writeInt32LE(0, 24);
  // Kept for the life of the worker (the schema points into them).
  api = {
    glib: glib.functions, secret: secret.functions, strHash, strEqual, objectUnref, schema,
    names: [schemaName, attributeName],
  };
  return api;
}
function attributes(a, purpose) {
  const table = a.glib.g_hash_table_new(a.strHash, a.strEqual);
  if (!table) throw new Error('failed');
  a.glib.g_hash_table_insert(table, cstr('purpose'), cstr(purpose));
  return table;
}
function takeError(a, slot) {
  const pointer = slot.readBigUInt64LE(0);
  if (pointer === 0n) return false;
  a.glib.g_error_free(pointer);
  return true;
}
function handle(message) {
  const a = load();
  scratch = [];
  const slot = Buffer.alloc(8);
  const purpose = message.op === 'probe' ? 'identity' : message.purpose;
  const table = attributes(a, purpose);
  try {
    if (message.op === 'store') {
      const value = Buffer.from(message.secret + '\0', 'utf8');
      try {
        const ok = a.secret.secret_password_storev_sync(
          a.schema, table, Buffer.from('default\0'), cstr('Parallax key (' + purpose + ')'), value, 0n, slot,
        );
        if (takeError(a, slot) || !ok) throw new Error('failed');
        return null;
      } finally {
        value.fill(0);
      }
    }
    if (message.op === 'exists') {
      const list = a.secret.secret_password_searchv_sync(a.schema, table, 0, 0n, slot);
      if (takeError(a, slot)) throw new Error('unavailable');
      if (!list) return null;
      a.glib.g_list_free_full(list, a.objectUnref);
      return '1';
    }
    const pointer = a.secret.secret_password_lookupv_sync(a.schema, table, 0n, slot);
    if (takeError(a, slot)) throw new Error('unavailable');
    if (!pointer) return null;
    try {
      return message.op === 'probe' ? null : ffi.toString(pointer);
    } finally {
      a.secret.secret_password_free(pointer);
    }
  } finally {
    a.glib.g_hash_table_unref(table);
    scratch = [];
  }
}
parentPort.on('message', (message) => {
  try {
    const value = handle(message);
    parentPort.postMessage({ id: message.id, ok: true, value });
  } catch (error) {
    const reason = error && error.message === 'failed' ? 'failed' : 'unavailable';
    parentPort.postMessage({ id: message.id, ok: false, reason });
  }
});
`;

const workerAnswerSchema = z.object({
  id: z.number().int(),
  ok: z.boolean(),
  value: z.string().max(1024).nullable().optional(),
  reason: z.enum(['unavailable', 'failed']).optional(),
});

export interface SecretServiceWorkerOptions {
  timeoutMs?: number;
  /** Worker script (tests: a script that never answers, to prove the deadline). */
  source?: string;
  logger?: Logger;
}

interface Pending {
  resolve(value: string | null): void;
  reject(error: KeyStoreError): void;
  timer: NodeJS.Timeout;
}

/** The keyring through a worker thread with a deadline per call. */
export function createSecretServiceWorker(options: SecretServiceWorkerOptions = {}): SecretServiceNative {
  const timeoutMs = options.timeoutMs ?? SECRET_SERVICE_TIMEOUT_MS;
  const source = options.source ?? SECRET_SERVICE_WORKER_SOURCE;
  const log = (options.logger ?? rootLogger).child({ module: 'keyStore.secretService' });
  let worker: Worker | null = null;
  /**
   * Follow-up of the security review WP-109: workers terminated after a timeout whose thread has not
   * ended yet. `terminate()` cannot interrupt a libsecret call that waits for a password prompt; a new
   * worker would wait for the same prompt – so none starts until the old thread is gone, and calls fail
   * with `timeout` at once (no pile of blocked threads).
   */
  let stuck = 0;
  let nextId = 1;
  const pending = new Map<number, Pending>();

  const failAll = (reason: KeyStoreFailure): void => {
    for (const [id, entry] of pending) {
      clearTimeout(entry.timer);
      pending.delete(id);
      entry.reject(new KeyStoreError(reason));
    }
  };

  const drop = (reason: KeyStoreFailure): void => {
    const current = worker;
    worker = null;
    failAll(reason);
    if (current === null) return;
    if (reason !== 'timeout') {
      void current.terminate().catch(() => undefined);
      return;
    }
    stuck += 1;
    // Resolves once the thread really ended (after the blocking call returned).
    void current
      .terminate()
      .catch(() => undefined)
      .finally(() => {
        stuck -= 1;
        log.info('a keyring worker that did not answer has ended');
      });
  };

  const ensure = (): Worker => {
    if (worker !== null) return worker;
    if (stuck > 0) throw new KeyStoreError('timeout', 'the keyring has not answered an earlier call yet');
    const created = new Worker(source, {
      eval: true,
      workerData: { schemaName: SECRET_SCHEMA_NAME },
      // The worker never needs more than a little heap; stdout/stderr stay with the server.
      resourceLimits: { maxOldGenerationSizeMb: 32 },
    });
    created.unref();
    created.on('message', (raw: unknown) => {
      const parsed = workerAnswerSchema.safeParse(raw);
      if (!parsed.success) return;
      const entry = pending.get(parsed.data.id);
      if (entry === undefined) return;
      pending.delete(parsed.data.id);
      clearTimeout(entry.timer);
      if (parsed.data.ok) entry.resolve(parsed.data.value ?? null);
      else entry.reject(new KeyStoreError(parsed.data.reason ?? 'failed'));
    });
    created.on('error', () => {
      if (worker === created) drop('unavailable');
    });
    created.on('exit', () => {
      if (worker === created) drop('unavailable');
    });
    worker = created;
    return created;
  };

  const request = (message: {
    op: 'lookup' | 'exists' | 'store' | 'probe';
    purpose?: string;
    secret?: string;
  }) =>
    new Promise<string | null>((resolve, reject) => {
      let target: Worker;
      try {
        target = ensure();
      } catch (error) {
        reject(error instanceof KeyStoreError ? error : new KeyStoreError('unavailable'));
        return;
      }
      const id = nextId++;
      const timer = setTimeout(() => {
        if (!pending.has(id)) return;
        log.warn({ op: message.op }, 'keyring did not answer in time (locked?) – worker restarted');
        drop('timeout');
      }, timeoutMs);
      timer.unref();
      pending.set(id, { resolve, reject, timer });
      target.postMessage({ id, ...message });
    });

  return {
    lookup: (purpose) => request({ op: 'lookup', purpose }),
    exists: async (purpose) => (await request({ op: 'exists', purpose })) !== null,
    store: async (purpose, secret) => {
      await request({ op: 'store', purpose, secret });
    },
    probe: async () => {
      await request({ op: 'probe' });
    },
    close: () => {
      drop('unavailable');
    },
  };
}

export interface SecretServiceKeyStoreOptions {
  platform?: NodeJS.Platform;
  /** Default: the worker (created on first use). */
  native?: SecretServiceNative;
  logger?: Logger;
}

function checkPurpose(purpose: string): void {
  if (!KEY_PURPOSE_PATTERN.test(purpose)) throw new KeyStoreError('failed', 'invalid key purpose');
}

function additionalData(purpose: KeyPurpose): Buffer {
  return Buffer.from(KEY_STORE_ENTROPY_PREFIX + purpose, 'utf8');
}

function decodeKey(text: string | null): Buffer | null {
  if (text === null) return null;
  const key = Buffer.from(text, 'base64');
  if (key.length !== KEY_BYTES) {
    key.fill(0);
    return null;
  }
  return key;
}

/** AES-256-GCM: `pss1 | iv | tag | ciphertext`. */
export function sealWithKey(key: Buffer, purpose: KeyPurpose, plaintext: Buffer): Buffer {
  const iv = randomBytes(IV_BYTES);
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  cipher.setAAD(additionalData(purpose));
  const body = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  return Buffer.concat([MAGIC, iv, cipher.getAuthTag(), body]);
}

/** Opens `sealWithKey`; throws KeyStoreError('failed') for anything foreign or tampered. */
export function openWithKey(key: Buffer, purpose: KeyPurpose, sealed: Buffer): Buffer {
  const head = MAGIC.length + IV_BYTES + TAG_BYTES;
  if (sealed.length <= head || !sealed.subarray(0, MAGIC.length).equals(MAGIC)) {
    throw new KeyStoreError('failed');
  }
  try {
    const decipher = createDecipheriv(
      'aes-256-gcm',
      key,
      sealed.subarray(MAGIC.length, MAGIC.length + IV_BYTES),
    );
    decipher.setAAD(additionalData(purpose));
    decipher.setAuthTag(sealed.subarray(MAGIC.length + IV_BYTES, head));
    return Buffer.concat([decipher.update(sealed.subarray(head)), decipher.final()]);
  } catch {
    throw new KeyStoreError('failed');
  }
}

/** The Secret Service store (Linux; elsewhere `available()` is false and every call fails). */
export function createSecretServiceKeyStore(options: SecretServiceKeyStoreOptions = {}): KeyStore & {
  close(): void;
} {
  const usable = (options.platform ?? process.platform) === 'linux';
  const log = (options.logger ?? rootLogger).child({ module: 'keyStore.secretService' });
  let native: SecretServiceNative | null = options.native ?? null;
  let probed: boolean | null = null;
  let probedAt = 0;

  const getNative = (): SecretServiceNative => {
    if (!usable) throw new KeyStoreError('unavailable', 'the Secret Service is used only on Linux');
    native ??= createSecretServiceWorker(options.logger === undefined ? {} : { logger: options.logger });
    return native;
  };

  /** The key of `purpose`; `create` makes and stores a new one when none exists. */
  const keyOf = async (purpose: KeyPurpose, create: boolean): Promise<Buffer> => {
    const api = getNative();
    const found = await api.lookup(purpose);
    const existing = decodeKey(found);
    if (existing !== null) return existing;
    if (!create) throw new KeyStoreError('failed');
    // Review WP-109: a keyring that stays locked (prompt dismissed, nobody logged in) answers the
    // lookup with nothing. A new key would replace the stored one (same attributes) as soon as the
    // keyring opens for the store – and every value sealed with it (all paired computers) is lost.
    if (found === null && (await api.exists(purpose))) {
      throw new KeyStoreError('unavailable', 'keyring locked');
    }
    const key = randomBytes(KEY_BYTES);
    await api.store(purpose, key.toString('base64'));
    // Read back: the keyring decides (another process may have stored one at the same time).
    const stored = decodeKey(await api.lookup(purpose));
    key.fill(0);
    if (stored === null) throw new KeyStoreError('failed');
    return stored;
  };

  const guard = async <T>(fn: () => Promise<T>): Promise<T> => {
    try {
      return await fn();
    } catch (error) {
      throw error instanceof KeyStoreError ? error : new KeyStoreError('failed');
    }
  };

  return {
    scheme: 'secret_service',
    async available() {
      if (!usable) return false;
      if (probed === true) return true;
      if (probed === false && Date.now() - probedAt < PROBE_RETRY_MS) return false;
      let ok = false;
      try {
        await getNative().probe();
        ok = true;
      } catch (error) {
        log.info(
          { reason: error instanceof KeyStoreError ? error.reason : 'failed' },
          'Secret Service not usable',
        );
      }
      probed = ok;
      probedAt = Date.now();
      return ok;
    },
    protect: (purpose, plaintext) =>
      guard(async () => {
        checkPurpose(purpose);
        if (plaintext.length === 0 || plaintext.length > KEY_STORE_MAX_PLAINTEXT) {
          throw new KeyStoreError('failed', 'invalid plaintext size');
        }
        const key = await keyOf(purpose, true);
        try {
          return sealWithKey(key, purpose, plaintext);
        } finally {
          key.fill(0);
        }
      }),
    unprotect: (purpose, ciphertext) =>
      guard(async () => {
        checkPurpose(purpose);
        if (ciphertext.length === 0 || ciphertext.length > MAX_CIPHERTEXT) {
          throw new KeyStoreError('failed', 'invalid ciphertext size');
        }
        const key = await keyOf(purpose, false);
        try {
          return openWithKey(key, purpose, ciphertext);
        } finally {
          key.fill(0);
        }
      }),
    close() {
      native?.close();
    },
  };
}
