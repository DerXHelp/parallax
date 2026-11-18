import { readdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import type { ErrorPayload } from '@shared/errors';
import type { HostRecord } from '@shared/model';
import { makeTempHome } from '../http/testServer';
import { HOSTS_FILE, createHostsStore } from './store';

const RECORD: HostRecord = {
  hostId: 'pc-b',
  name: 'PC B',
  color: 'blue',
  address: '192.0.2.10',
  port: 4713,
  peerPin: 'a'.repeat(96),
  peerCertificate: Buffer.from('certificate').toString('base64'),
  authKey: Buffer.from('sealed').toString('base64'),
  addedAt: '2026-11-18T10:00:00.000Z',
  lastConnectedAt: null,
};

function sink(): { warnings: ErrorPayload[]; add(error: ErrorPayload): void } {
  const warnings: ErrorPayload[] = [];
  return {
    warnings,
    add(error) {
      warnings.push(error);
    },
  };
}

describe('hosts.json', () => {
  it('is empty when missing and round-trips the records atomically', async () => {
    const home = await makeTempHome('wp79-store-');
    const store = createHostsStore({ home });
    expect(await store.load()).toEqual([]);
    await store.save([RECORD, { ...RECORD, hostId: 'pc-c', name: 'PC C', color: 'green' }]);
    const reread = await createHostsStore({ home }).load();
    expect(reread.map((host) => host.hostId)).toEqual(['pc-b', 'pc-c']);
    const raw = JSON.parse(await readFile(path.join(home, HOSTS_FILE), 'utf8')) as Record<string, unknown>;
    expect(raw.schemaVersion).toBe(1);
    expect((await readdir(home)).filter((name) => name.endsWith('.bak'))).toEqual([]);
  });

  it('quarantines an unusable file (warning) and counts it as empty', async () => {
    const home = await makeTempHome('wp79-store-');
    await writeFile(path.join(home, HOSTS_FILE), '{"schemaVersion":1,"hosts":[{"hostId":"local"}]}');
    const warnings = sink();
    const store = createHostsStore({ home, warnings });
    expect(await store.load()).toEqual([]);
    expect(warnings.warnings.map((warning) => warning.code)).toEqual(['STORE_CORRUPT_QUARANTINED']);
    expect((await readdir(home)).some((name) => name.startsWith(`${HOSTS_FILE}.corrupt-`))).toBe(true);
    expect(store.blockedError()).toBeNull();
  });

  it('leaves a newer schema version alone and refuses to save', async () => {
    const home = await makeTempHome('wp79-store-');
    const newer = '{"schemaVersion":2,"hosts":[]}';
    await writeFile(path.join(home, HOSTS_FILE), newer);
    const warnings = sink();
    const store = createHostsStore({ home, warnings });
    expect(await store.load()).toEqual([]);
    expect(store.blockedError()?.code).toBe('STORE_VERSION_TOO_NEW');
    await expect(store.save([RECORD])).rejects.toThrow(/blocked/u);
    expect(await readFile(path.join(home, HOSTS_FILE), 'utf8')).toBe(newer);
  });
});
