import { existsSync } from 'node:fs';
import { readdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { makeTempHome } from '../http/testServer';
import {
  JsonStore,
  STORE_VERSION_TOO_NEW_EXIT_CODE,
  StoreVersionTooNewError,
  createStoreWarnings,
  nodeStoreFs,
  withFsRetry,
  writeFileAtomic,
  type StoreFs,
} from './jsonStore';

const v1Schema = z.object({ schemaVersion: z.literal(1), items: z.array(z.string()) });
type V1 = z.infer<typeof v1Schema>;

const v2Schema = z.object({
  schemaVersion: z.literal(2),
  items: z.array(z.object({ name: z.string() })),
  label: z.string().default('none'),
});
type V2 = z.infer<typeof v2Schema>;

function errnoError(code: string): Error {
  return Object.assign(new Error(code), { code });
}

/** Counts calls and fails `rename` with `code` for the first `failures` attempts. */
function flakyFs(failures: number, code = 'EPERM'): StoreFs & { renames: number; writes: number } {
  let remaining = failures;
  const fs = {
    ...nodeStoreFs,
    renames: 0,
    writes: 0,
    writeFile: async (file: string, data: string | Uint8Array) => {
      fs.writes += 1;
      await nodeStoreFs.writeFile(file, data);
    },
    rename: async (from: string, to: string) => {
      fs.renames += 1;
      if (remaining > 0) {
        remaining -= 1;
        throw errnoError(code);
      }
      await nodeStoreFs.rename(from, to);
    },
  };
  return fs;
}

const fastRetry = [1, 1, 1, 1, 1];

async function storeIn(options: Partial<ConstructorParameters<typeof JsonStore<V1>>[0]> = {}) {
  const dir = await makeTempHome('jsonstore-');
  const warnings = createStoreWarnings();
  const file = path.join(dir, 'data.json');
  const store = new JsonStore<V1>({
    file,
    schema: v1Schema,
    version: 1,
    defaults: () => ({ schemaVersion: 1, items: [] }),
    debounceMs: 10,
    warnings,
    retryDelaysMs: fastRetry,
    ...options,
  });
  return { dir, file, store, warnings };
}

describe('JsonStore', () => {
  it('starts with defaults and writes atomically (no temp file left), with .bak of the previous version', async () => {
    const { dir, file, store } = await storeIn();
    expect(await store.load()).toEqual({ schemaVersion: 1, items: [] });
    expect(existsSync(file)).toBe(false);

    store.set({ schemaVersion: 1, items: ['a'] });
    await store.flush();
    expect(JSON.parse(await readFile(file, 'utf8'))).toEqual({ schemaVersion: 1, items: ['a'] });

    store.set({ schemaVersion: 1, items: ['a', 'b'] });
    await store.flush();
    expect(JSON.parse(await readFile(`${file}.bak`, 'utf8'))).toEqual({ schemaVersion: 1, items: ['a'] });
    expect((await readdir(dir)).filter((name) => name.endsWith('.tmp'))).toEqual([]);

    const reopened = new JsonStore<V1>({
      file,
      schema: v1Schema,
      version: 1,
      defaults: () => ({ schemaVersion: 1, items: [] }),
    });
    expect(await reopened.load()).toEqual({ schemaVersion: 1, items: ['a', 'b'] });
  });

  it('validates on set', async () => {
    const { store } = await storeIn();
    await store.load();
    expect(() => store.set({ schemaVersion: 1, items: [1] } as unknown as V1)).toThrow();
  });

  it('debounces writes: many sets, one write', async () => {
    const fs = flakyFs(0);
    const { file, store } = await storeIn({ fs, debounceMs: 30 });
    await store.load();
    for (let i = 0; i < 20; i++) store.set({ schemaVersion: 1, items: [String(i)] });
    await new Promise((resolve) => setTimeout(resolve, 80));
    // Waits for the write the debounce timer started (nothing is dirty any more → no second write).
    await store.flush();
    expect(fs.writes).toBe(1);
    expect(JSON.parse(await readFile(file, 'utf8'))).toEqual({ schemaVersion: 1, items: ['19'] });
  });

  it('retries a rename that fails with EPERM/EBUSY (virus scanner)', async () => {
    const fs = flakyFs(3, 'EBUSY');
    const { file, store, warnings } = await storeIn({ fs });
    await store.load();
    store.set({ schemaVersion: 1, items: ['x'] });
    await store.flush();
    expect(fs.renames).toBe(4);
    expect(warnings.list()).toEqual([]);
    expect(JSON.parse(await readFile(file, 'utf8'))).toEqual({ schemaVersion: 1, items: ['x'] });
  });

  it('keeps the data and warns STORE_WRITE_FAILED when the rename keeps failing', async () => {
    const fs = flakyFs(100, 'EPERM');
    const { dir, file, store, warnings } = await storeIn({ fs });
    await store.load();
    store.set({ schemaVersion: 1, items: ['kept'] });
    await store.flush();
    expect(warnings.list()).toEqual([
      expect.objectContaining({
        error: { code: 'STORE_WRITE_FAILED', params: { file: 'data.json', reason: 'EPERM' } },
      }),
    ]);
    expect(store.get().items).toEqual(['kept']);
    expect(existsSync(file)).toBe(false);
    expect((await readdir(dir)).filter((name) => name.endsWith('.tmp'))).toEqual([]);
  });

  it('does not retry other errors', async () => {
    let calls = 0;
    await expect(
      withFsRetry(() => {
        calls += 1;
        return Promise.reject(errnoError('ENOSPC'));
      }, fastRetry),
    ).rejects.toThrow('ENOSPC');
    expect(calls).toBe(1);
  });

  it('quarantines a corrupt file, warns and falls back to the backup', async () => {
    const { dir, file, store, warnings } = await storeIn();
    await writeFile(file, '{"schemaVersion":1,"items":[', 'utf8');
    await writeFile(`${file}.bak`, JSON.stringify({ schemaVersion: 1, items: ['from-bak'] }), 'utf8');
    const changes: number[] = [];
    warnings.onChange((list) => changes.push(list.length));

    expect(await store.load()).toEqual({ schemaVersion: 1, items: ['from-bak'] });
    const quarantined = (await readdir(dir)).filter((name) => name.startsWith('data.json.corrupt-'));
    expect(quarantined).toHaveLength(1);
    expect(await readFile(path.join(dir, quarantined[0] ?? ''), 'utf8')).toBe('{"schemaVersion":1,"items":[');
    expect(warnings.list()[0]?.error).toMatchObject({
      code: 'STORE_CORRUPT_QUARANTINED',
      params: { file: 'data.json', reason: 'json', quarantine: quarantined[0] },
    });
    expect(changes).toEqual([1]);
    // The restored value is written back to the main file.
    await store.flush();
    expect(JSON.parse(await readFile(file, 'utf8'))).toEqual({ schemaVersion: 1, items: ['from-bak'] });
  });

  it('quarantines schema violations and uses defaults without a backup', async () => {
    const { file, store, warnings } = await storeIn();
    await writeFile(file, JSON.stringify({ schemaVersion: 1, items: 'nope' }), 'utf8');
    expect(await store.load()).toEqual({ schemaVersion: 1, items: [] });
    expect(warnings.list()[0]?.error).toMatchObject({
      code: 'STORE_CORRUPT_QUARANTINED',
      params: { reason: 'schema', path: 'items' },
    });
  });

  it('migrates old versions and persists the result', async () => {
    const dir = await makeTempHome('jsonstore-');
    const file = path.join(dir, 'data.json');
    await writeFile(file, JSON.stringify({ schemaVersion: 1, items: ['a', 'b'] }), 'utf8');
    const store = new JsonStore<V2>({
      file,
      schema: v2Schema,
      version: 2,
      defaults: () => ({ schemaVersion: 2, items: [], label: 'none' }),
      debounceMs: 5,
      migrations: {
        1: (raw) => ({ schemaVersion: 2, items: (raw.items as string[]).map((name) => ({ name })) }),
      },
    });
    expect(await store.load()).toEqual({
      schemaVersion: 2,
      items: [{ name: 'a' }, { name: 'b' }],
      label: 'none',
    });
    await store.flush();
    expect(JSON.parse(await readFile(file, 'utf8'))).toMatchObject({ schemaVersion: 2 });
    expect(JSON.parse(await readFile(`${file}.bak`, 'utf8'))).toMatchObject({ schemaVersion: 1 });
  });

  it('reports STORE_MIGRATION_FAILED for a missing migration', async () => {
    const dir = await makeTempHome('jsonstore-');
    const v2File = path.join(dir, 'data.json');
    await writeFile(v2File, JSON.stringify({ schemaVersion: 1, items: [] }), 'utf8');
    const v2Warnings = createStoreWarnings();
    const v2 = new JsonStore<V2>({
      file: v2File,
      schema: v2Schema,
      version: 2,
      defaults: () => ({ schemaVersion: 2, items: [], label: 'none' }),
      warnings: v2Warnings,
    });
    await v2.load();
    expect(v2Warnings.list()[0]?.error).toMatchObject({
      code: 'STORE_MIGRATION_FAILED',
      params: { reason: 'missing_migration' },
    });
  });

  describe('newer schemaVersion (R1-06: abort the start, never touch the file)', () => {
    const NEWER = `${JSON.stringify({ schemaVersion: 3, items: ['from the future'], extra: true }, null, 2)}\n`;

    async function expectTooNew(promise: Promise<unknown>, file: string): Promise<StoreVersionTooNewError> {
      const error: unknown = await promise.then(
        () => null,
        (e: unknown) => e,
      );
      expect(error).toBeInstanceOf(StoreVersionTooNewError);
      if (!(error instanceof StoreVersionTooNewError)) throw new Error('unreachable');
      expect(error.file).toBe(file);
      expect(error.message).toMatch(/newer Parallax.*update Parallax/);
      return error;
    }

    it('rejects load, leaves file and .bak byte-identical, no quarantine, no write', async () => {
      const { dir, file, store, warnings } = await storeIn();
      const older = JSON.stringify({ schemaVersion: 1, items: ['old bak'] });
      await writeFile(file, NEWER, 'utf8');
      await writeFile(`${file}.bak`, older, 'utf8');
      const error = await expectTooNew(store.load(), file);
      expect(error.error).toEqual({
        code: 'STORE_VERSION_TOO_NEW',
        params: { file: 'data.json', version: 3, supported: 1 },
      });
      expect(warnings.list().map((w) => w.error.code)).toEqual(['STORE_VERSION_TOO_NEW']);
      // Blocked: every later call refuses, nothing is written.
      await expectTooNew(store.load(), file);
      expect(() => store.get()).toThrow(StoreVersionTooNewError);
      expect(() => store.set({ schemaVersion: 1, items: [] })).toThrow(StoreVersionTooNewError);
      await store.flush();
      await store.close();
      expect(await readFile(file, 'utf8')).toBe(NEWER);
      expect(await readFile(`${file}.bak`, 'utf8')).toBe(older);
      expect((await readdir(dir)).sort()).toEqual(['data.json', 'data.json.bak']);
    });

    it('a set() before load never overwrites the newer file', async () => {
      const { dir, file, store } = await storeIn({ debounceMs: 0 });
      await writeFile(file, NEWER, 'utf8');
      store.set({ schemaVersion: 1, items: ['would clobber'] });
      await new Promise((resolve) => setTimeout(resolve, 30));
      await store.flush();
      expect(await readFile(file, 'utf8')).toBe(NEWER);
      expect(await readdir(dir)).toEqual(['data.json']);
      await expectTooNew(store.load(), file);
    });

    it('also refuses a newer .bak when the main file is missing (the backup stays)', async () => {
      const { dir, file, store } = await storeIn();
      await writeFile(`${file}.bak`, NEWER, 'utf8');
      await expectTooNew(store.load(), `${file}.bak`);
      expect(await readFile(`${file}.bak`, 'utf8')).toBe(NEWER);
      expect(await readdir(dir)).toEqual(['data.json.bak']);
    });

    it('quarantines a corrupt main file but keeps a newer .bak untouched', async () => {
      const { dir, file, store, warnings } = await storeIn();
      await writeFile(file, '{broken', 'utf8');
      await writeFile(`${file}.bak`, NEWER, 'utf8');
      await expectTooNew(store.load(), `${file}.bak`);
      expect(await readFile(`${file}.bak`, 'utf8')).toBe(NEWER);
      const names = await readdir(dir);
      expect(names.filter((name) => name.startsWith('data.json.corrupt-'))).toHaveLength(1);
      expect(names).not.toContain('data.json');
      expect(warnings.list().map((w) => w.error.code)).toEqual([
        'STORE_CORRUPT_QUARANTINED',
        'STORE_VERSION_TOO_NEW',
      ]);
    });

    it('has a dedicated exit code for the aborted start', () => {
      expect(STORE_VERSION_TOO_NEW_EXIT_CODE).toBe(3);
    });
  });

  it('writes only after the file was read: a set() before load keeps the file data out, then wins', async () => {
    const { file, store } = await storeIn({ debounceMs: 0 });
    await writeFile(file, JSON.stringify({ schemaVersion: 1, items: ['file'] }), 'utf8');
    store.set({ schemaVersion: 1, items: ['set'] });
    await store.flush();
    expect(JSON.parse(await readFile(file, 'utf8'))).toEqual({ schemaVersion: 1, items: ['set'] });
    expect(JSON.parse(await readFile(`${file}.bak`, 'utf8'))).toEqual({ schemaVersion: 1, items: ['file'] });
    expect(await store.load()).toEqual({ schemaVersion: 1, items: ['set'] });
  });

  it('lets a set() during load win over the file', async () => {
    const { file, store } = await storeIn();
    await writeFile(file, JSON.stringify({ schemaVersion: 1, items: ['file'] }), 'utf8');
    const loading = store.load();
    store.set({ schemaVersion: 1, items: ['set'] });
    expect(await loading).toEqual({ schemaVersion: 1, items: ['set'] });
  });

  it('writeFileAtomic writes binary data', async () => {
    const dir = await makeTempHome('jsonstore-');
    const file = path.join(dir, 'nested', 'blob.bin');
    await writeFileAtomic(file, new Uint8Array([1, 2, 3]));
    expect([...(await readFile(file))]).toEqual([1, 2, 3]);
  });
});
