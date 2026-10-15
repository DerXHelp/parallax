import { createHash } from 'node:crypto';
import { appendFile, mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { REGISTRY_SCHEMA_VERSION, type TranscriptItem } from '@shared/model';
import { SAMPLE_IDS, sampleDecisionRecord, sampleEntry, sampleId, sampleItems } from '@shared/samples';
import { makeTempHome } from '../http/testServer';
import type { TranscriptLogLine } from '../sync/ports';
import { blobFilePath, blobMetaPath, createBlobStore } from './blobs';
import { createDecisionStore, planPath } from './decisions';
import { createStoreWarnings } from './jsonStore';
import { REGISTRY_FILE, openRegistryStore } from './registry';
import { SETTINGS_FILE, openSettingsStore } from './settings';
import { createTranscriptStore, transcriptPath } from './transcripts';

const ENTRY = SAMPLE_IDS.entry;
const CV = SAMPLE_IDS.conversation;
const AT = '2026-10-15T08:00:00.000Z';

describe('RegistryStore (sessions.json)', () => {
  it('upserts, removes, persists and reloads entries (defaults applied)', async () => {
    const home = await makeTempHome('registry-');
    const registry = await openRegistryStore({ home, debounceMs: 5 });
    expect(registry.list()).toEqual([]);
    const { unread: _unread, context: _context, ...withoutNewFields } = sampleEntry();
    registry.upsert(withoutNewFields as ReturnType<typeof sampleEntry>);
    registry.upsert(sampleEntry({ id: sampleId('en', 2), title: 'Second' }));
    expect(registry.get(ENTRY)).toMatchObject({ unread: false, context: null });
    registry.remove(sampleId('en', 2));
    await registry.close();

    const file = JSON.parse(await readFile(path.join(home, REGISTRY_FILE), 'utf8')) as {
      schemaVersion: number;
    };
    expect(file.schemaVersion).toBe(REGISTRY_SCHEMA_VERSION);
    const reopened = await openRegistryStore({ home });
    expect(reopened.list().map((e) => e.id)).toEqual([ENTRY]);
    await reopened.close();
  });

  it('rejects invalid entries at the boundary', async () => {
    const registry = await openRegistryStore({ home: await makeTempHome('registry-') });
    expect(() => {
      registry.upsert(sampleEntry({ cwd: '' }));
    }).toThrow();
    await registry.close();
  });

  it('quarantines a corrupt sessions.json and raises a host warning', async () => {
    const home = await makeTempHome('registry-');
    await writeFile(path.join(home, REGISTRY_FILE), 'garbage', 'utf8');
    const warnings = createStoreWarnings();
    const registry = await openRegistryStore({ home, warnings });
    expect(registry.list()).toEqual([]);
    expect(warnings.list()[0]?.error.code).toBe('STORE_CORRUPT_QUARANTINED');
    await registry.close();
  });
});

describe('SettingsStore (settings.json)', () => {
  it('patches only the given fields and persists', async () => {
    const home = await makeTempHome('settings-');
    const settings = await openSettingsStore({ home, debounceMs: 5 });
    expect(settings.get()).toEqual({ language: 'en', theme: 'dark' });
    expect(settings.update({ language: 'de' })).toEqual({ language: 'de', theme: 'dark' });
    expect(settings.update({ theme: undefined })).toEqual({ language: 'de', theme: 'dark' });
    await settings.close();
    expect(JSON.parse(await readFile(path.join(home, SETTINGS_FILE), 'utf8'))).toEqual({
      schemaVersion: 1,
      settings: { language: 'de', theme: 'dark' },
    });
    expect(() => settings.update({ language: 'fr' } as unknown as { language: 'en' })).toThrow();
  });
});

describe('DecisionStore (decisions.json + plans)', () => {
  it('saves and loads records per entry, keeps open decision snapshots', async () => {
    const home = await makeTempHome('decisions-');
    const store = createDecisionStore({ home, debounceMs: 5 });
    expect(await store.load(ENTRY)).toEqual([]);
    const record = sampleDecisionRecord();
    store.save(ENTRY, [record]);
    expect(await store.load(ENTRY)).toEqual([record]);
    await store.close();

    const reopened = createDecisionStore({ home });
    expect(await reopened.load(ENTRY)).toEqual([record]);
    expect(await reopened.load(sampleId('en', 5))).toEqual([]);
  });

  it('stores plan versions with the exact text', async () => {
    const home = await makeTempHome('decisions-');
    const store = createDecisionStore({ home });
    const text = '# Plan\r\n\n1. Ünïcödé – keep CRLF\n';
    await store.savePlan(ENTRY, 2, text);
    expect(await store.readPlan(ENTRY, 2)).toBe(text);
    expect(await readFile(planPath(home, ENTRY, 2), 'utf8')).toBe(text);
    expect(await store.readPlan(ENTRY, 3)).toBeNull();
    await expect(store.savePlan('../evil', 1, 'x')).rejects.toThrow();
  });
});

describe('TranscriptStore (entries/<id>/<cv>.transcript.jsonl)', () => {
  const up = (item: TranscriptItem): TranscriptLogLine => ({ v: 1, at: AT, op: 'upsert', item });
  const text = (order: number, value = `t${String(order)}`) =>
    sampleItems.assistantText({ id: `m${String(order)}:0`, order, text: value });

  it('appends lines (buffered), folds by id (last wins), sorts by order', async () => {
    const home = await makeTempHome('transcripts-');
    const store = createTranscriptStore({ home, flushMs: 5 });
    store.append(ENTRY, CV, up(text(2)));
    store.append(ENTRY, CV, up(text(1)));
    store.append(ENTRY, CV, up(text(3)));
    store.append(ENTRY, CV, up(text(2, 'updated')));
    store.append(ENTRY, CV, { v: 1, at: AT, op: 'remove', itemId: 'm3:0' });
    const tail = await store.readTail(ENTRY, CV, 10);
    expect(tail.items.map((i) => [i.order, i.kind === 'assistant_text' ? i.text : ''])).toEqual([
      [1, 't1'],
      [2, 'updated'],
    ]);
    expect(tail.hasEarlier).toBe(false);
    await store.flush();
    const lines = (await readFile(transcriptPath(home, ENTRY, CV), 'utf8')).trim().split('\n');
    expect(lines).toHaveLength(5);
    expect(transcriptPath(home, ENTRY, CV)).toBe(path.join(home, 'entries', ENTRY, `${CV}.transcript.jsonl`));
  });

  it('reads tail and before with hasEarlier, from a fresh store (file only)', async () => {
    const home = await makeTempHome('transcripts-');
    const writer = createTranscriptStore({ home });
    for (let order = 1; order <= 10; order++) writer.append(ENTRY, CV, up(text(order)));
    await writer.close();

    const reader = createTranscriptStore({ home });
    expect(await reader.readTail(ENTRY, CV, 3)).toMatchObject({ hasEarlier: true });
    expect((await reader.readTail(ENTRY, CV, 3)).items.map((i) => i.order)).toEqual([8, 9, 10]);
    const before = await reader.readBefore(ENTRY, CV, 8, 4);
    expect(before.items.map((i) => i.order)).toEqual([4, 5, 6, 7]);
    expect(before.hasEarlier).toBe(true);
    const first = await reader.readBefore(ENTRY, CV, 3, 5);
    expect(first.items.map((i) => i.order)).toEqual([1, 2]);
    expect(first.hasEarlier).toBe(false);
    // Appends after the cache was built are visible.
    reader.append(ENTRY, CV, up(text(11)));
    expect((await reader.readTail(ENTRY, CV, 1)).items.map((i) => i.order)).toEqual([11]);
    expect(await reader.readTail(ENTRY, sampleId('cv', 9), 5)).toEqual({ items: [], hasEarlier: false });
  });

  it('skips and counts broken lines and repairs a partial last line before appending', async () => {
    const home = await makeTempHome('transcripts-');
    const file = transcriptPath(home, ENTRY, CV);
    await mkdir(path.dirname(file), { recursive: true });
    await writeFile(
      file,
      `${JSON.stringify(up(text(1)))}\nnot json\n{"v":1,"op":"upsert"}\n{"v":1,"at":`,
      'utf8',
    );
    const store = createTranscriptStore({ home, flushMs: 1 });
    store.append(ENTRY, CV, up(text(2)));
    await store.flush();
    const fresh = createTranscriptStore({ home });
    expect((await fresh.readTail(ENTRY, CV, 10)).items.map((i) => i.order)).toEqual([1, 2]);
    expect(fresh.stats().brokenLines).toBe(3);
  });

  it('never persists streaming items', async () => {
    const home = await makeTempHome('transcripts-');
    const store = createTranscriptStore({ home });
    store.append(ENTRY, CV, up(sampleItems.assistantText({ streaming: true })));
    store.append(ENTRY, CV, up(sampleItems.toolCall({ status: 'streaming_input' })));
    store.append(ENTRY, CV, up(sampleItems.toolCall()));
    await store.flush();
    expect(store.stats()).toMatchObject({ droppedStreaming: 2, appendedLines: 1 });
  });

  it('rejects ids that are not entry/conversation ids (no path traversal)', async () => {
    const store = createTranscriptStore({ home: await makeTempHome('transcripts-') });
    expect(() => {
      store.append('..\\..\\evil', CV, up(text(1)));
    }).toThrow();
    await expect(store.readTail(ENTRY, '../x', 1)).rejects.toThrow();
  });

  it('keeps lines appended while a read is running', async () => {
    const home = await makeTempHome('transcripts-');
    const file = transcriptPath(home, ENTRY, CV);
    await mkdir(path.dirname(file), { recursive: true });
    const lines: string[] = [];
    for (let order = 1; order <= 2000; order++) lines.push(JSON.stringify(up(text(order))));
    await appendFile(file, `${lines.join('\n')}\n`, 'utf8');
    const store = createTranscriptStore({ home, flushMs: 1 });
    const reading = store.readTail(ENTRY, CV, 1);
    store.append(ENTRY, CV, up(text(2001)));
    await reading;
    expect((await store.readTail(ENTRY, CV, 1)).items.map((i) => i.order)).toEqual([2001]);
  });
});

describe('BlobStore (content-addressed)', () => {
  it('hashes synchronously, serves from memory before the write, then from disk with meta', async () => {
    const home = await makeTempHome('blobs-');
    const blobs = createBlobStore({ home });
    const ref = blobs.put('hello', 'text/plain', 'hello.txt');
    expect(ref).toEqual({
      blobId: createHash('sha256').update('hello').digest('hex'),
      mediaType: 'text/plain',
      bytes: 5,
      width: null,
      height: null,
      name: 'hello.txt',
    });
    expect(Buffer.from((await blobs.get(ref.blobId))?.data ?? []).toString('utf8')).toBe('hello');
    await blobs.flush();
    expect(await readFile(blobFilePath(home, ref.blobId), 'utf8')).toBe('hello');
    expect(JSON.parse(await readFile(blobMetaPath(home, ref.blobId), 'utf8'))).toEqual(ref);

    const fresh = createBlobStore({ home });
    const loaded = await fresh.get(ref.blobId);
    expect(loaded?.ref).toEqual(ref);
    expect(Buffer.from(loaded?.data ?? []).toString('utf8')).toBe('hello');
  });

  it('dedupes by content (first meta wins) and handles binary data', async () => {
    const home = await makeTempHome('blobs-');
    const blobs = createBlobStore({ home });
    const bytes = new Uint8Array([0, 255, 1]);
    const first = blobs.put(bytes, 'image/png', 'a.png');
    bytes[0] = 9; // the store copied the input
    const second = blobs.put(new Uint8Array([0, 255, 1]), 'application/octet-stream');
    expect(second).toEqual(first);
    await blobs.flush();
    expect([...(await readFile(blobFilePath(home, first.blobId)))]).toEqual([0, 255, 1]);
  });

  it('returns null for unknown, malformed and invalid-meta blobs', async () => {
    const home = await makeTempHome('blobs-');
    const blobs = createBlobStore({ home });
    expect(await blobs.get('0'.repeat(64))).toBeNull();
    expect(await blobs.get('../../etc/passwd')).toBeNull();
    const id = 'a'.repeat(64);
    await mkdir(path.join(home, 'blobs'), { recursive: true });
    await writeFile(blobFilePath(home, id), 'x', 'utf8');
    await writeFile(blobMetaPath(home, id), '{"blobId":"other"}', 'utf8');
    expect(await blobs.get(id)).toBeNull();
  });
});
