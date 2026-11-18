import { readFile, writeFile, mkdir } from 'node:fs/promises';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { remoteEventsFileSchema } from '@shared/model';
import { makeTempHome } from '../http/testServer';
import { EVENTS_FILE, REMOTE_DIR, createRemoteEventLog } from './eventLog';

async function setup(options: { max?: number; days?: number } = {}) {
  const home = await makeTempHome('wp78a-events-');
  let now = Date.parse('2026-11-18T10:00:00.000Z');
  const make = () => createRemoteEventLog({ home, now: () => new Date(now), debounceMs: 10, ...options });
  const log = make();
  await log.load();
  return {
    home,
    log,
    make,
    at: () => new Date(now),
    advance: (ms: number) => {
      now += ms;
    },
  };
}

describe('connection log (§3.7, ADR-225)', () => {
  it('merges equal kind + address within a minute into one row with a counter', async () => {
    const { log, advance } = await setup();
    log.record({ kind: 'tls_failed', address: '10.0.0.5', port: 50_000 });
    advance(30_000);
    log.record({ kind: 'tls_failed', address: '::ffff:10.0.0.5', port: 50_001 });
    log.record({ kind: 'unknown_key', address: '10.0.0.5', port: 50_002 });
    log.record({ kind: 'tls_failed', address: '10.0.0.6', port: 1 });
    advance(30_000); // 60 s after the first occurrence → a new row
    log.record({ kind: 'tls_failed', address: '10.0.0.5', port: 50_003 });
    const rows = log.list(false);
    expect(rows.map((row) => [row.kind, row.address, row.count])).toEqual([
      ['tls_failed', '10.0.0.5', 1],
      ['tls_failed', '10.0.0.6', 1],
      ['unknown_key', '10.0.0.5', 1],
      ['tls_failed', '10.0.0.5', 2],
    ]);
    expect(rows[3]).toMatchObject({
      port: 50_001,
      at: '2026-11-18T10:00:00.000Z',
      lastAt: '2026-11-18T10:00:30.000Z',
    });
  });

  it('marks rejected kinds, filters them and counts unseen rows until marked seen', async () => {
    const { log, advance } = await setup();
    log.record({ kind: 'pair_ok', address: '10.0.0.1', port: 1, claimedName: 'PC-A' });
    log.record({ kind: 'pair_failed', address: '10.0.0.2', port: 2, claimedName: 'PC-X' });
    log.record({ kind: 'connected', address: '10.0.0.1', port: 3 });
    expect(log.list(true).map((row) => row.kind)).toEqual(['pair_failed']);
    expect(log.list(false).find((row) => row.kind === 'pair_ok')?.rejected).toBe(false);
    expect(log.unseenRejected()).toBe(1);
    advance(1_000);
    log.markSeen();
    expect(log.unseenRejected()).toBe(0);
    advance(1_000);
    log.record({ kind: 'browser_rejected', address: '10.0.0.3', port: 4 });
    expect(log.unseenRejected()).toBe(1);
  });

  it('keeps unverified names only as clean text', async () => {
    const { log } = await setup();
    log.record({
      kind: 'pair_failed',
      address: '10.0.0.2',
      port: 2,
      claimedName: '  Evil\u0000\nName\u001b[31m  ',
    });
    log.record({ kind: 'pair_failed', address: '10.0.0.3', port: 2, claimedName: '\u0007\u0008' });
    const [second, first] = log.list(false);
    expect(first?.claimedName).toBe('EvilName[31m');
    expect(second?.claimedName).toBeNull();
  });

  it('is a ring buffer (max rows) and drops rows older than the day limit', async () => {
    const { log, advance } = await setup({ max: 3, days: 1 });
    for (let i = 0; i < 5; i += 1)
      log.record({ kind: 'unknown_key', address: `10.0.0.${String(i)}`, port: null });
    expect(log.list(false).map((row) => row.address)).toEqual(['10.0.0.4', '10.0.0.3', '10.0.0.2']);
    advance(25 * 60 * 60_000);
    log.record({ kind: 'rate_limited', address: '10.0.0.9', port: null });
    expect(log.list(false).map((row) => row.address)).toEqual(['10.0.0.9']);
  });

  it('persists debounced and loads again; records before load are kept', async () => {
    const { home, log, make } = await setup();
    log.record({ kind: 'proof_failed', address: '10.0.0.7', port: 7 });
    log.markSeen();
    await log.flush();
    const file = remoteEventsFileSchema.parse(
      JSON.parse(await readFile(path.join(home, REMOTE_DIR, EVENTS_FILE), 'utf8')),
    );
    expect(file.events).toHaveLength(1);
    expect(file.seenAt).not.toBeNull();
    const again = make();
    again.record({ kind: 'version_mismatch', address: '10.0.0.8', port: 8 });
    expect(again.list(false)).toEqual([]);
    await again.load();
    expect(again.list(false).map((row) => row.kind)).toEqual(['version_mismatch', 'proof_failed']);
    await again.close();
  });

  it('an unreadable file does not stop the log (memory only)', async () => {
    const home = await makeTempHome('wp78a-events-');
    await mkdir(path.join(home, REMOTE_DIR), { recursive: true });
    await writeFile(
      path.join(home, REMOTE_DIR, EVENTS_FILE),
      JSON.stringify({ schemaVersion: 99, events: [] }),
    );
    const log = createRemoteEventLog({ home });
    await log.load();
    log.record({ kind: 'tls_failed', address: '10.0.0.1', port: null });
    expect(log.list(false)).toHaveLength(1);
  });

  it('notifies on new rows and on markSeen, not on merged repeats', async () => {
    const { log } = await setup();
    let calls = 0;
    log.onChange(() => (calls += 1));
    log.record({ kind: 'tls_failed', address: '10.0.0.1', port: null });
    log.record({ kind: 'tls_failed', address: '10.0.0.1', port: null });
    log.markSeen();
    expect(calls).toBe(2);
  });
});
