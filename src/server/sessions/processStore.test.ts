import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { SAMPLE_TIME, sampleId } from '@shared/samples';
import { makeTempHome } from '../http/testServer';
import { StoreVersionTooNewError } from '../store/jsonStore';
import {
  PROCESSES_FILE,
  createMemoryProcessStore,
  openProcessStore,
  processesFileSchema,
  type ProcessRecord,
} from './processStore';

const record = (n: number, entry = n): ProcessRecord => ({
  entryId: sampleId('en', entry),
  pid: 1000 + n,
  image: 'claude.exe',
  startedAt: SAMPLE_TIME,
  aliveAt: null,
  children: [],
});

describe('openProcessStore (processes.json, JsonStore)', () => {
  it('add is durable (on disk at once), remove is debounced, reopen loads the records', async () => {
    const home = await makeTempHome('wp13b-proc-');
    const store = await openProcessStore({ home, debounceMs: 10_000 });
    expect(await store.load()).toEqual([]);
    await store.add(record(1));
    await store.add(record(2));
    const file = path.join(home, PROCESSES_FILE);
    const onDisk = processesFileSchema.parse(JSON.parse(await readFile(file, 'utf8')));
    expect(onDisk.records.map((r) => r.pid)).toEqual([1001, 1002]);
    store.remove(sampleId('en', 1), 1001);
    store.remove(sampleId('en', 9), 4242);
    expect((await store.load()).map((r) => r.pid)).toEqual([1002]);
    await store.flush();
    await store.close();
    const reopened = await openProcessStore({ home });
    expect(await reopened.load()).toEqual([record(2)]);
    await reopened.close();
  });

  it('the same entry + pid replaces the record; invalid records are refused', async () => {
    const home = await makeTempHome('wp13b-proc-');
    const store = await openProcessStore({ home });
    await store.add(record(1));
    await store.add({ ...record(1), image: 'CLAUDE.EXE' });
    expect((await store.load()).map((r) => r.image)).toEqual(['CLAUDE.EXE']);
    await expect(store.add({ ...record(3), pid: -1 })).rejects.toThrow();
    await store.close();
  });

  it('WP22-06: heartbeat writes aliveAt + the children snapshot; old files without them load with defaults', async () => {
    const home = await makeTempHome('wp22-proc-');
    const file = path.join(home, PROCESSES_FILE);
    // A file of the build before WP22-06.
    await writeFile(
      file,
      JSON.stringify({
        schemaVersion: 1,
        records: [{ entryId: sampleId('en', 1), pid: 1001, image: 'claude.exe', startedAt: SAMPLE_TIME }],
      }),
    );
    const store = await openProcessStore({ home, debounceMs: 0 });
    expect(await store.load()).toEqual([record(1)]);
    const children = [
      { pid: 2001, image: 'powershell.exe', startedAt: '2026-10-15T12:00:01.123Z' },
      { pid: 2002, image: 'PING.EXE', startedAt: '2026-10-15T12:00:01.456Z' },
    ];
    store.heartbeat(sampleId('en', 1), 1001, { aliveAt: '2026-10-15T12:00:30.000Z', children });
    store.heartbeat(sampleId('en', 9), 4242, { aliveAt: '2026-10-15T12:00:30.000Z', children });
    await store.flush();
    const onDisk = processesFileSchema.parse(JSON.parse(await readFile(file, 'utf8')));
    expect(onDisk.records).toEqual([{ ...record(1), aliveAt: '2026-10-15T12:00:30.000Z', children }]);
    await store.close();
  });

  it('a newer schemaVersion aborts (file left unchanged, R1-06)', async () => {
    const home = await makeTempHome('wp13b-proc-');
    const file = path.join(home, PROCESSES_FILE);
    const text = JSON.stringify({ schemaVersion: 2, records: [] });
    await writeFile(file, text);
    await expect(openProcessStore({ home })).rejects.toBeInstanceOf(StoreVersionTooNewError);
    expect(await readFile(file, 'utf8')).toBe(text);
  });
});

describe('createMemoryProcessStore', () => {
  it('counts adds/removes/flushes and keeps copies', async () => {
    const store = createMemoryProcessStore([record(1)]);
    await store.add(record(2));
    store.remove(sampleId('en', 1), 1001);
    store.remove(sampleId('en', 1), 1001);
    await store.flush();
    const list = store.records();
    list.pop();
    expect(store.records().map((r) => r.pid)).toEqual([1002]);
    expect({ adds: store.adds, removes: store.removes, flushes: store.flushes }).toEqual({
      adds: 1,
      removes: 1,
      flushes: 1,
    });
    expect(await store.load()).toEqual([record(2)]);
  });

  it('heartbeat: only existing records, counted; at most MAX_RECORDED_CHILDREN children', () => {
    const store = createMemoryProcessStore([record(1)]);
    const many = Array.from({ length: 250 }, (_, i) => ({
      pid: 3000 + i,
      image: 'node.exe',
      startedAt: SAMPLE_TIME,
    }));
    store.heartbeat(sampleId('en', 1), 1001, { aliveAt: SAMPLE_TIME, children: many });
    store.heartbeat(sampleId('en', 2), 1002, { aliveAt: SAMPLE_TIME, children: [] });
    expect(store.heartbeats).toBe(1);
    const [only] = store.records();
    expect(only?.aliveAt).toBe(SAMPLE_TIME);
    expect(only?.children).toHaveLength(200);
  });
});
