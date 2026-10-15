import { describe, expect, it } from 'vitest';
import { makeError } from '@shared/errors';
import {
  SAMPLE_IDS,
  SAMPLE_TIME,
  sampleDecisionRecord,
  sampleEntry,
  sampleId,
  sampleItems,
  sampleSettings,
} from '@shared/samples';
import { createMemoryStores } from './memoryStores';

const E = SAMPLE_IDS.entry;
const CV = SAMPLE_IDS.conversation;

describe('createMemoryStores', () => {
  it('registry: validates with entrySchema (defaults applied), returns copies', () => {
    const stores = createMemoryStores({ entries: [sampleEntry()] });
    expect(stores.registry.list()).toHaveLength(1);
    const entry = stores.registry.get(E);
    if (entry === undefined) throw new Error('entry');
    entry.title = 'changed';
    expect(stores.registry.get(E)?.title).toBe('Sample session');
    expect(() => {
      stores.registry.upsert({ ...sampleEntry(), cwd: '' });
    }).toThrow();
    stores.registry.upsert({ ...sampleEntry(), title: 'New' });
    expect(stores.registry.get(E)?.title).toBe('New');
    expect(stores.registry.upserts).toBe(1);
    stores.registry.remove(E);
    expect(stores.registry.list()).toEqual([]);
  });

  it('transcripts: fold by id, drop streaming items, validate lines, readTail/readBefore', async () => {
    const stores = createMemoryStores({
      transcripts: [
        { entryId: E, conversationId: CV, items: [sampleItems.userMessage(), sampleItems.thinking()] },
      ],
    });
    const t = stores.transcripts;
    t.append(E, CV, {
      v: 1,
      at: SAMPLE_TIME,
      op: 'upsert',
      item: sampleItems.assistantText({ streaming: true }),
    });
    expect(t.droppedStreaming).toBe(1);
    t.append(E, CV, { v: 1, at: SAMPLE_TIME, op: 'upsert', item: sampleItems.assistantText() });
    t.append(E, CV, {
      v: 1,
      at: SAMPLE_TIME,
      op: 'upsert',
      item: sampleItems.thinking({ text: { text: 'v2', truncated: null } }),
    });
    t.append(E, CV, { v: 1, at: SAMPLE_TIME, op: 'remove', itemId: sampleItems.userMessage().id });
    expect(t.items(E, CV).map((i) => i.order)).toEqual([2, 3]);
    expect(t.items(E, CV)[0]).toMatchObject({ kind: 'thinking', text: { text: 'v2' } });
    await expect(t.readTail(E, CV, 1)).resolves.toMatchObject({ hasEarlier: true, items: [{ order: 3 }] });
    await expect(t.readBefore(E, CV, 3, 10)).resolves.toMatchObject({
      hasEarlier: false,
      items: [{ order: 2 }],
    });
    await expect(t.readTail(E, sampleId('cv', 2), 5)).resolves.toEqual({ items: [], hasEarlier: false });
    expect(() => {
      t.append(E, CV, { v: 1, at: 'not a date', op: 'remove', itemId: 'x' });
    }).toThrow(/invalid log line/);
    // 2 seeded + 3 accepted (the streaming item and the invalid line are not stored).
    expect(t.lines(E, CV)).toHaveLength(5);
  });

  it('decisions: validated records survive parse unchanged, plans, load returns copies', async () => {
    const stores = createMemoryStores({ decisions: [{ entryId: E, records: [sampleDecisionRecord()] }] });
    const d = stores.decisions;
    await expect(d.load(E)).resolves.toEqual([sampleDecisionRecord()]);
    const withExtraKey = { ...sampleDecisionRecord(), extra: 1 };
    expect(() => {
      d.save(E, [withExtraKey]);
    }).toThrow(/change under parse/);
    d.save(E, []);
    expect(d.records(E)).toEqual([]);
    expect(d.saves).toBe(1);
    await d.savePlan(E, 2, '# v2');
    await expect(d.readPlan(E, 2)).resolves.toBe('# v2');
    await expect(d.readPlan(E, 3)).resolves.toBeNull();
    await d.flush();
    expect(d.flushes).toBe(1);
  });

  it('blobs: content-addressed (sha256), synchronous put, get', async () => {
    const { blobs } = createMemoryStores();
    const a = blobs.put('hello', 'text/plain');
    const b = blobs.put(new TextEncoder().encode('hello'), 'image/png', 'x.png');
    expect(a).toBe(b);
    expect(a.blobId).toBe('2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824');
    expect(blobs.put('x', '').mediaType).toBe('application/octet-stream');
    const got = await blobs.get(a.blobId);
    expect(new TextDecoder().decode(got?.data)).toBe('hello');
    await expect(blobs.get('0'.repeat(64))).resolves.toBeNull();
  });

  it('settings and warnings', () => {
    const stores = createMemoryStores({ settings: sampleSettings({ language: 'de' }) });
    expect(stores.settings.get()).toEqual({ language: 'de', theme: 'dark' });
    expect(stores.settings.update({ theme: 'light' })).toEqual({ language: 'de', theme: 'light' });
    const seen: number[] = [];
    const off = stores.warnings.onChange((list) => seen.push(list.length));
    stores.warnings.add(makeError('STORE_CORRUPT_QUARANTINED', { file: 'sessions.json' }));
    off();
    stores.warnings.add(makeError('STORE_WRITE_FAILED'));
    expect(seen).toEqual([1]);
    expect(stores.warnings.list().map((w) => w.error.code)).toEqual([
      'STORE_CORRUPT_QUARANTINED',
      'STORE_WRITE_FAILED',
    ]);
  });

  it('readDelayMs delays reads (loadView race tests)', async () => {
    const stores = createMemoryStores({}, { readDelayMs: 20 });
    const started = Date.now();
    await stores.transcripts.readTail(E, CV, 10);
    expect(Date.now() - started).toBeGreaterThanOrEqual(15);
    stores.transcripts.readDelayMs = 0;
    await stores.transcripts.readTail(E, CV, 10);
  });
});
