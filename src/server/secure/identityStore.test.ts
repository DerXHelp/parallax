import { readFile, readdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import type { ErrorPayload } from '@shared/errors';
import { makeTempHome } from '../http/testServer';
import { StoreVersionTooNewError } from '../store/jsonStore';
import { generateIdentity } from './identity';
import { KEYS_DIR, createIdentityStore, keyFilePath } from './identityStore';
import { createMemoryKeyStore } from './memoryKeyStore';
import { KeyStoreError } from './ports';

async function setup() {
  const home = await makeTempHome('wp78a-keys-');
  const keyStore = createMemoryKeyStore();
  const warnings: ErrorPayload[] = [];
  const make = () =>
    createIdentityStore({ home, keyStore, warnings: { add: (error) => warnings.push(error) } });
  return { home, keyStore, warnings, make, store: make() };
}

async function keyFiles(home: string): Promise<string[]> {
  try {
    return (await readdir(path.join(home, KEYS_DIR))).sort();
  } catch {
    return [];
  }
}

describe('key files (§B.4/B.5)', () => {
  it('maps purposes to file names and refuses invalid ones', () => {
    expect(path.basename(keyFilePath('C:\\h', 'identity'))).toBe('identity.json');
    expect(path.basename(keyFilePath('C:\\h', 'coupling:pc-b'))).toBe('coupling-pc-b.json');
    expect(() => keyFilePath('C:\\h', 'coupling:../x')).toThrow(RangeError);
  });

  it('creates once, loads in a new process with the same key, and never stores the key in clear', async () => {
    const { home, make, store } = await setup();
    const created = await store.create('identity');
    const text = await readFile(keyFilePath(home, 'identity'), 'utf8');
    const record = JSON.parse(text) as Record<string, unknown>;
    expect(record).toMatchObject({ schemaVersion: 1, purpose: 'identity', algorithm: 'ml-dsa-87' });
    expect(record.certificate).toBe(created.certificateDer.toString('base64'));
    const pkcs8 = created.privateKey.export({ type: 'pkcs8', format: 'der' });
    expect(text).not.toContain(pkcs8.toString('base64'));
    expect(text).not.toContain(pkcs8.toString('hex'));
    expect(text).not.toContain('PRIVATE KEY');
    const loaded = await make().load('identity');
    expect(loaded?.pin).toBe(created.pin);
    expect(loaded?.certificateDer.equals(created.certificateDer)).toBe(true);
    expect(await keyFiles(home)).toEqual(['identity.json']);
  });

  it('caches per process and returns null for a missing key', async () => {
    const { store, keyStore } = await setup();
    expect(await store.load('coupling:pc-b')).toBeNull();
    const created = await store.create('coupling:pc-b');
    const calls = keyStore.calls.length;
    expect((await store.load('coupling:pc-b'))?.pin).toBe(created.pin);
    expect(keyStore.calls.length).toBe(calls);
  });

  it('save() stores a key generated in memory (controlling side after a successful pairing)', async () => {
    const { make, store } = await setup();
    const identity = generateIdentity('coupling:pc-c');
    await store.save(identity);
    expect((await make().load('coupling:pc-c'))?.pin).toBe(identity.pin);
  });

  it('remove() deletes the file and the cached key; missing is a no-op', async () => {
    const { home, make, store } = await setup();
    await store.create('identity');
    await store.remove('identity');
    await store.remove('identity');
    expect(await store.load('identity')).toBeNull();
    expect(await make().load('identity')).toBeNull();
    expect(await keyFiles(home)).toEqual([]);
  });

  it('quarantines a file with a foreign certificate', async () => {
    const { home, make, store, warnings } = await setup();
    await store.create('identity');
    const file = keyFilePath(home, 'identity');
    const record = JSON.parse(await readFile(file, 'utf8')) as Record<string, unknown>;
    record.certificate = generateIdentity('identity').certificateDer.toString('base64');
    await writeFile(file, JSON.stringify(record));
    expect(await make().load('identity')).toBeNull();
    const files = await keyFiles(home);
    expect(files).toHaveLength(1);
    expect(files[0]).toMatch(/^identity\.json\.corrupt-/u);
    expect(warnings[0]).toMatchObject({
      code: 'STORE_CORRUPT_QUARANTINED',
      params: { reason: 'key_mismatch' },
    });
  });

  it.each([
    ['broken JSON', () => '{nope', 'json'],
    ['a wrong schema', () => JSON.stringify({ schemaVersion: 1, purpose: 'identity' }), 'schema'],
    [
      'another purpose',
      (text: string) => text.replace('"purpose": "identity"', '"purpose": "coupling:pc-x"'),
      'purpose',
    ],
  ])('quarantines %s', async (_label, mutate, reason) => {
    const { home, make, store, warnings } = await setup();
    await store.create('identity');
    const file = keyFilePath(home, 'identity');
    await writeFile(file, mutate(await readFile(file, 'utf8')));
    expect(await make().load('identity')).toBeNull();
    expect(warnings[0]).toMatchObject({ code: 'STORE_CORRUPT_QUARANTINED', params: { reason } });
  });

  it('leaves a file of a newer schema version untouched', async () => {
    const { home, make, store } = await setup();
    await store.create('identity');
    const file = keyFilePath(home, 'identity');
    const newer = (await readFile(file, 'utf8')).replace('"schemaVersion": 1', '"schemaVersion": 2');
    await writeFile(file, newer);
    await expect(make().load('identity')).rejects.toBeInstanceOf(StoreVersionTooNewError);
    expect(await readFile(file, 'utf8')).toBe(newer);
  });

  it('a key store failure on load throws (fail closed) and does not quarantine', async () => {
    const { home, keyStore, make, store } = await setup();
    await store.create('identity');
    keyStore.failNext('failed');
    await expect(make().load('identity')).rejects.toBeInstanceOf(KeyStoreError);
    expect(await keyFiles(home)).toEqual(['identity.json']);
    // A foreign DPAPI ciphertext (other store = other Windows account) fails the same way.
    const foreign = createIdentityStore({ home, keyStore: createMemoryKeyStore() });
    await expect(foreign.load('identity')).rejects.toBeInstanceOf(KeyStoreError);
  });

  it('without a usable key store nothing is written (never a clear-text key)', async () => {
    const { home, keyStore, store } = await setup();
    keyStore.setAvailable(false);
    await expect(store.create('identity')).rejects.toMatchObject({ reason: 'unavailable' });
    await expect(store.save(generateIdentity('coupling:pc-d'))).rejects.toBeInstanceOf(KeyStoreError);
    expect(await keyFiles(home)).toEqual([]);
  });

  it('a load that started before create() does not overwrite the new key in the cache', async () => {
    const { home, keyStore, store } = await setup();
    const old = await store.create('identity');
    // The load is slow (DPAPI ~260 ms) and finishes after the renewal.
    const other = createIdentityStore({
      home,
      keyStore: {
        available: () => keyStore.available(),
        protect: (purpose, data) => keyStore.protect(purpose, data),
        unprotect: async (purpose, data) => {
          await new Promise((resolve) => setTimeout(resolve, 100));
          return keyStore.unprotect(purpose, data);
        },
      },
    });
    const pending = other.load('identity');
    const renewed = await other.create('identity');
    expect(renewed.pin).not.toBe(old.pin);
    expect((await pending)?.pin).toBe(renewed.pin);
    expect((await other.load('identity'))?.pin).toBe(renewed.pin);
  });
});
