import { mkdir, readdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { REVIEW_SCHEMA_VERSION } from '@shared/model';
import { SAMPLE_IDS, sampleId, sampleReviewComment } from '@shared/samples';
import { makeTempHome } from '../http/testServer';
import { entryDir } from './decisions';
import { createStoreWarnings } from './jsonStore';
import { REVIEW_FILE, createReviewStore, reviewPath } from './review';

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
  const file = reviewPath(home, ENTRY);
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, text, 'utf8');
  return file;
}

describe('ReviewStore (entries/<id>/review.json, WP-111)', () => {
  it('round trip: save → close → a new store loads the same list (schemaVersion 1, no .bak)', async () => {
    const home = await makeTempHome('review-');
    const store = createReviewStore({ home, debounceMs: 5 });
    expect(await store.load(ENTRY)).toEqual([]);
    const comments = [
      sampleReviewComment(),
      sampleReviewComment({ id: sampleId('rc', 2), line: 20, endLine: 20 }),
    ];
    store.save(ENTRY, comments);
    expect(await store.load(ENTRY)).toEqual(comments);
    await store.close();

    const file = JSON.parse(await readFile(reviewPath(home, ENTRY), 'utf8')) as unknown;
    expect(file).toEqual({ schemaVersion: REVIEW_SCHEMA_VERSION, comments });
    expect(await readdir(entryDir(home, ENTRY))).toEqual([REVIEW_FILE]);
    const again = createReviewStore({ home });
    expect(await again.load(ENTRY)).toEqual(comments);
    expect(await again.load(sampleId('en', 2))).toEqual([]);
    await again.close();
  });

  it('a loaded list is a copy (changing it changes nothing stored)', async () => {
    const home = await makeTempHome('review-');
    const store = createReviewStore({ home, debounceMs: 60_000 });
    store.save(ENTRY, [sampleReviewComment()]);
    const list = await store.load(ENTRY);
    list.pop();
    expect(await store.load(ENTRY)).toHaveLength(1);
    await store.close();
  });

  it('save([]) and remove delete the file', async () => {
    const home = await makeTempHome('review-');
    const store = createReviewStore({ home, debounceMs: 60_000 });
    store.save(ENTRY, [sampleReviewComment()]);
    await store.flush();
    expect(await exists(reviewPath(home, ENTRY))).toBe(true);
    store.save(ENTRY, []);
    await store.flush();
    expect(await exists(reviewPath(home, ENTRY))).toBe(false);
    store.save(ENTRY, [sampleReviewComment()]);
    await store.flush();
    await store.remove(ENTRY);
    expect(await exists(reviewPath(home, ENTRY))).toBe(false);
    expect(await store.load(ENTRY)).toEqual([]);
    await store.close();
  });

  it('a corrupt file goes to quarantine (warning) and counts as no comments', async () => {
    const home = await makeTempHome('review-');
    await writeRaw(home, '{ not json');
    const warnings = createStoreWarnings();
    const store = createReviewStore({ home, warnings });
    expect(await store.load(ENTRY)).toEqual([]);
    expect(warnings.list().map((w) => w.error.code)).toEqual(['STORE_CORRUPT_QUARANTINED']);
    const files = await readdir(entryDir(home, ENTRY));
    expect(files.some((f) => f.startsWith(`${REVIEW_FILE}.corrupt-`))).toBe(true);
    await store.close();
  });

  it('a newer schema version stays untouched (no write, no delete, STORE_VERSION_TOO_NEW)', async () => {
    const home = await makeTempHome('review-');
    const text = JSON.stringify({ schemaVersion: REVIEW_SCHEMA_VERSION + 1, comments: [] });
    const file = await writeRaw(home, text);
    const warnings = createStoreWarnings();
    const store = createReviewStore({ home, warnings, debounceMs: 1 });
    expect(await store.load(ENTRY)).toEqual([]);
    store.save(ENTRY, [sampleReviewComment()]);
    await store.flush();
    await store.remove(ENTRY);
    expect(await readFile(file, 'utf8')).toBe(text);
    expect(warnings.list().map((w) => w.error.code)).toContain('STORE_VERSION_TOO_NEW');
    await store.close();
  });

  it('refuses an invalid list (zod) and ignores saves after close', async () => {
    const home = await makeTempHome('review-');
    const store = createReviewStore({ home, debounceMs: 1 });
    expect(() => {
      store.save(ENTRY, [sampleReviewComment({ line: 5, endLine: 2 })]);
    }).toThrow();
    await store.close();
    store.save(ENTRY, [sampleReviewComment()]);
    await store.flush();
    expect(await exists(reviewPath(home, ENTRY))).toBe(false);
  });
});
