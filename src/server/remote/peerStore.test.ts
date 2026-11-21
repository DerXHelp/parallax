import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import type { RemotePeerRecord } from '@shared/model';
import { makeTempHome } from '../http/testServer';
import { nodeFsOps, type FsOps } from '../lib/fs';
import { generateIdentity } from '../secure/identity';
import { StoreVersionTooNewError } from '../store/jsonStore';
import { REMOTE_DIR } from './eventLog';
import { PEER_FILE, createPeerStore } from './peerStore';

function record(name = 'PC-A'): RemotePeerRecord {
  const identity = generateIdentity('coupling:pc-a');
  return {
    name,
    pin: identity.pin,
    certificate: identity.certificateDer.toString('base64'),
    authKey: Buffer.from('ciphertext-of-kauth').toString('base64'),
    level: 'control',
    pairedAt: '2026-11-18T10:00:00.000Z',
    lastSeenAt: null,
    lastAddress: '10.0.0.5',
  };
}

async function setup() {
  const home = await makeTempHome('wp78a-peer-');
  const control = { failWrites: false };
  const fs: FsOps = {
    ...nodeFsOps,
    writeFile: (file, data) =>
      control.failWrites ? Promise.reject(new Error('disk full')) : nodeFsOps.writeFile(file, data),
  };
  const make = () => createPeerStore({ home, fs, retryDelaysMs: [], debounceMs: 20 });
  const store = make();
  await store.load();
  const file = path.join(home, REMOTE_DIR, PEER_FILE);
  await mkdir(path.dirname(file), { recursive: true });
  const read = async () =>
    JSON.parse(await readFile(file, 'utf8')) as { peer: RemotePeerRecord | null; revoked: string[] };
  return { home, control, make, store, file, read };
}

describe('peer store (§B.7 step 7.3, §B.8)', () => {
  it('stores the one coupling and loads it again', async () => {
    const { make, store, read } = await setup();
    const peer = record();
    await store.set(peer);
    expect(store.get()).toEqual(peer);
    expect((await read()).peer).toEqual(peer);
    const again = make();
    await again.load();
    expect(again.get()).toEqual(peer);
  });

  it('a failed write on set() stores nothing (memory and file unchanged)', async () => {
    const { control, store, read } = await setup();
    const first = record('first');
    await store.set(first);
    control.failWrites = true;
    await expect(store.set(record('second'))).rejects.toThrow();
    expect(store.get()?.name).toBe('first');
    control.failWrites = false;
    expect((await read()).peer?.name).toBe('first');
  });

  it('replacing and clearing move the old pin to the revoked list (at most 8)', async () => {
    const { store, read } = await setup();
    const pins: string[] = [];
    for (let i = 0; i < 10; i += 1) {
      const peer = record(`pc-${String(i)}`);
      pins.push(peer.pin);
      await store.set(peer);
    }
    await store.clear();
    const file = await read();
    expect(file.peer).toBeNull();
    expect(file.revoked).toEqual(pins.slice(2));
    expect(store.isRevoked(pins[9] ?? '')).toBe(true);
    expect(store.isRevoked(pins[0] ?? '')).toBe(false);
  });

  it('clear() changes the memory first; a failed write removes the file instead (no return after a restart)', async () => {
    const { control, make, store, file } = await setup();
    await store.set(record());
    control.failWrites = true;
    const pending = store.clear();
    expect(store.get()).toBeNull();
    await pending;
    expect(store.writeFailed).toBe(false);
    await expect(readFile(file, 'utf8')).rejects.toMatchObject({ code: 'ENOENT' });
    const restarted = make();
    await restarted.load();
    expect(restarted.get()).toBeNull();
    // persist() fails closed while the folder takes no writes.
    await expect(restarted.persist()).rejects.toThrow();
    control.failWrites = false;
    await restarted.persist();
  });

  it('write and removal both fail → remembered and retried by flush()', async () => {
    const { control, home, read } = await setup();
    const fs: FsOps = {
      ...nodeFsOps,
      writeFile: (target, data) =>
        control.failWrites ? Promise.reject(new Error('disk full')) : nodeFsOps.writeFile(target, data),
      unlink: (target) =>
        control.failWrites ? Promise.reject(new Error('locked')) : nodeFsOps.unlink(target),
    };
    const locked = createPeerStore({ home, fs, retryDelaysMs: [], debounceMs: 20 });
    await locked.load();
    const peer = record();
    await locked.set(peer);
    control.failWrites = true;
    await expect(locked.clear()).rejects.toThrow();
    expect(locked.writeFailed).toBe(true);
    expect((await read()).peer?.pin).toBe(peer.pin);
    control.failWrites = false;
    await locked.flush();
    expect(locked.writeFailed).toBe(false);
    expect((await read()).peer).toBeNull();
  });

  it('touch() writes debounced, at most once a minute, and never brings back a cleared coupling', async () => {
    const { store, read } = await setup();
    await store.set(record());
    store.touch('10.0.0.9', new Date('2026-11-18T11:00:00.000Z'));
    store.touch('10.0.0.9', new Date('2026-11-18T11:00:30.000Z'));
    expect(store.get()?.lastSeenAt).toBe('2026-11-18T11:00:00.000Z');
    await store.flush();
    expect((await read()).peer?.lastAddress).toBe('10.0.0.9');
    store.touch('10.0.0.10', new Date('2026-11-18T11:00:40.000Z'));
    await store.clear();
    await new Promise((resolve) => setTimeout(resolve, 60));
    await store.flush();
    expect((await read()).peer).toBeNull();
  });

  it('quarantines a record whose pin does not match its certificate', async () => {
    const { home, make, file } = await setup();
    const peer = { ...record(), pin: generateIdentity('identity').pin };
    await writeFile(file, JSON.stringify({ schemaVersion: 1, peer, revoked: [] }));
    const store = make();
    await store.load();
    expect(store.get()).toBeNull();
    expect(
      (await readdir(path.join(home, REMOTE_DIR))).some((name) => name.startsWith(`${PEER_FILE}.corrupt-`)),
    ).toBe(true);
  });

  it('a file of a newer schema version is left alone (load throws)', async () => {
    const { make, file } = await setup();
    const text = JSON.stringify({ schemaVersion: 2, peer: null, revoked: [] });
    await writeFile(file, text);
    await expect(make().load()).rejects.toBeInstanceOf(StoreVersionTooNewError);
    expect(await readFile(file, 'utf8')).toBe(text);
  });

  it('refuses to store a record whose certificate does not match the pin', async () => {
    const { store } = await setup();
    await expect(store.set({ ...record(), pin: 'a'.repeat(96) })).rejects.toThrow();
    expect(store.get()).toBeNull();
  });
});
