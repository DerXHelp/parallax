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
});
