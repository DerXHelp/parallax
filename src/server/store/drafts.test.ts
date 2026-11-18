import { mkdir, readdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { DRAFT_SCHEMA_VERSION } from '@shared/model';
import { SAMPLE_IDS, sampleDraft, sampleId } from '@shared/samples';
import { nodeFsOps, type FsOps } from '../lib/fs';
import { makeTempHome } from '../http/testServer';
import { entryDir } from './decisions';
import { DRAFT_FILE, createDraftStore, draftPath } from './drafts';
import { createStoreWarnings } from './jsonStore';

const ENTRY = SAMPLE_IDS.entry;

async function exists(file: string): Promise<boolean> {
  try {
    await readFile(file, 'utf8');
    return true;
  } catch {
    return false;
  }
}

async function writeRaw(home: string, text: string): Promise<string> {
  const file = draftPath(home, ENTRY);
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, text, 'utf8');
  return file;
}

/** File seam that counts writes of draft files. */
function countingFs(): FsOps & { writes: number } {
  const fs = {
    ...nodeFsOps,
    writes: 0,
    writeFile: (file: string, data: string | Uint8Array) => {
      fs.writes += 1;
      return nodeFsOps.writeFile(file, data);
    },
  };
  return fs;
}

describe('DraftStore (entries/<id>/draft.json, WP-77)', () => {
  it('round trip: save → flush → a new store loads the same draft (schemaVersion 1, no .bak)', async () => {
    const home = await makeTempHome('drafts-');
    const store = createDraftStore({ home, debounceMs: 5 });
    expect(await store.load(ENTRY)).toBeNull();
    const draft = sampleDraft({ text: 'half [x]', pastes: ['x'.repeat(10)], rev: 3 });
    store.save(ENTRY, draft);
    expect(await store.load(ENTRY)).toEqual(draft);
    await store.close();

    const file = JSON.parse(await readFile(draftPath(home, ENTRY), 'utf8')) as unknown;
    expect(file).toEqual({ schemaVersion: DRAFT_SCHEMA_VERSION, draft });
    expect(await readdir(entryDir(home, ENTRY))).toEqual([DRAFT_FILE]);
    const again = createDraftStore({ home });
    expect(await again.load(ENTRY)).toEqual(draft);
    expect(await again.load(sampleId('en', 2))).toBeNull();
    await again.close();
  });

  it('debounces: many saves within the delay write once, the newest wins', async () => {
    const home = await makeTempHome('drafts-');
    const fs = countingFs();
    const store = createDraftStore({ home, debounceMs: 40, fs });
    for (let rev = 1; rev <= 5; rev += 1) store.save(ENTRY, sampleDraft({ text: `t${String(rev)}`, rev }));
    expect(fs.writes).toBe(0);
    await new Promise((resolve) => setTimeout(resolve, 120));
    expect(fs.writes).toBe(1);
    const file = JSON.parse(await readFile(draftPath(home, ENTRY), 'utf8')) as { draft: { rev: number } };
    expect(file.draft.rev).toBe(5);
    await store.close();
  });

  it('flush writes at once; save(null) deletes the file', async () => {
    const home = await makeTempHome('drafts-');
    const store = createDraftStore({ home, debounceMs: 60_000 });
    store.save(ENTRY, sampleDraft());
    await store.flush();
    expect(await exists(draftPath(home, ENTRY))).toBe(true);
    store.save(ENTRY, null);
    expect(await store.load(ENTRY)).toBeNull();
    await store.flush();
    expect(await exists(draftPath(home, ENTRY))).toBe(false);
    await store.close();
  });

  it('remove deletes the file now, also with a write pending', async () => {
    const home = await makeTempHome('drafts-');
    const first = createDraftStore({ home, debounceMs: 5 });
    first.save(ENTRY, sampleDraft());
    await first.close();
    const store = createDraftStore({ home, debounceMs: 60_000 });
    store.save(ENTRY, sampleDraft({ rev: 2 }));
    await store.remove(ENTRY);
    expect(await exists(draftPath(home, ENTRY))).toBe(false);
    expect(await store.load(ENTRY)).toBeNull();
    await store.close();
    expect(await exists(draftPath(home, ENTRY))).toBe(false);
    // Nothing there: still fine.
    await createDraftStore({ home }).remove(sampleId('en', 3));
  });

  it('a corrupt file goes to quarantine with a host warning and counts as no draft', async () => {
    const home = await makeTempHome('drafts-');
    await writeRaw(home, '{"schemaVersion":1,"draft":');
    const warnings = createStoreWarnings();
    const store = createDraftStore({ home, warnings });
    expect(await store.load(ENTRY)).toBeNull();
    expect(warnings.list().map((w) => [w.error.code, w.error.params.reason])).toEqual([
      ['STORE_CORRUPT_QUARANTINED', 'json'],
    ]);
    const names = await readdir(entryDir(home, ENTRY));
    expect(names).toHaveLength(1);
    expect(names[0]).toMatch(/^draft\.json\.corrupt-\d{8}T\d{9}Z-[0-9a-f]{6}$/);
    await store.close();
  });

  it('a file of the wrong shape is quarantined too (schema path in the warning)', async () => {
    const home = await makeTempHome('drafts-');
    await writeRaw(home, JSON.stringify({ schemaVersion: 1, draft: { text: 1 } }));
    const warnings = createStoreWarnings();
    const store = createDraftStore({ home, warnings });
    expect(await store.load(ENTRY)).toBeNull();
    expect(warnings.list()[0]?.error).toMatchObject({
      code: 'STORE_CORRUPT_QUARANTINED',
      params: { file: DRAFT_FILE, reason: 'schema', path: 'draft.text' },
    });
    expect(await exists(draftPath(home, ENTRY))).toBe(false);
    await store.close();
  });

  it('a newer schema version is left untouched: no draft, never overwritten or deleted', async () => {
    const home = await makeTempHome('drafts-');
    const text = JSON.stringify({ schemaVersion: DRAFT_SCHEMA_VERSION + 1, draft: { future: true } });
    const file = await writeRaw(home, text);
    const warnings = createStoreWarnings();
    const store = createDraftStore({ home, warnings, debounceMs: 5 });
    expect(await store.load(ENTRY)).toBeNull();
    expect(warnings.list().map((w) => w.error.code)).toEqual(['STORE_VERSION_TOO_NEW']);
    store.save(ENTRY, sampleDraft());
    await store.flush();
    await store.remove(ENTRY);
    await store.close();
    expect(await readFile(file, 'utf8')).toBe(text);
  });

  it('a save before the first read never overwrites a newer file', async () => {
    const home = await makeTempHome('drafts-');
    const text = JSON.stringify({ schemaVersion: DRAFT_SCHEMA_VERSION + 1, draft: null });
    const file = await writeRaw(home, text);
    const store = createDraftStore({ home, debounceMs: 5 });
    store.save(ENTRY, sampleDraft());
    await store.close();
    expect(await readFile(file, 'utf8')).toBe(text);
  });

  it('a failing write raises one warning, keeps the draft and writes it with the next flush', async () => {
    const home = await makeTempHome('drafts-');
    let failing = true;
    const fs: FsOps = {
      ...nodeFsOps,
      writeFile: (file, data) =>
        failing
          ? Promise.reject(Object.assign(new Error('disk full'), { code: 'ENOSPC' }))
          : nodeFsOps.writeFile(file, data),
    };
    const warnings = createStoreWarnings();
    const store = createDraftStore({ home, warnings, fs, debounceMs: 60_000, retryDelaysMs: [] });
    store.save(ENTRY, sampleDraft({ rev: 1 }));
    await store.flush();
    store.save(ENTRY, sampleDraft({ rev: 2 }));
    await store.flush();
    expect(warnings.list().map((w) => [w.error.code, w.error.params.reason])).toEqual([
      ['STORE_WRITE_FAILED', 'ENOSPC'],
    ]);
    failing = false;
    await store.flush();
    const saved = JSON.parse(await readFile(draftPath(home, ENTRY), 'utf8')) as { draft: { rev: number } };
    expect(saved.draft.rev).toBe(2);
    await store.close();
  });

  it('rejects an invalid draft at the boundary', async () => {
    const store = createDraftStore({ home: await makeTempHome('drafts-') });
    expect(() => {
      store.save(ENTRY, sampleDraft({ rev: 0 }));
    }).toThrow();
    await store.close();
  });
});
