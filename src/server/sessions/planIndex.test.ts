import { describe, expect, it, vi } from 'vitest';
import { SAMPLE_IDS, sampleDecisionRecord, sampleId } from '@shared/samples';
import { withPlanIndex } from './planIndex';
import { createMemoryStores, type MemoryStoresSeed } from './testing/memoryStores';

const ENTRY = SAMPLE_IDS.entry;
const OTHER = sampleId('en', 2);

function setup(plans: MemoryStoresSeed['plans'] = []) {
  const inner = createMemoryStores({ plans }).decisions;
  const reads: number[] = [];
  const readPlan = inner.readPlan.bind(inner);
  inner.readPlan = (entryId, version) => {
    reads.push(version);
    return readPlan(entryId, version);
  };
  return { inner, reads, store: withPlanIndex(inner) };
}

describe('withPlanIndex (CR3-09)', () => {
  it('a saved version is known: planStored reads nothing', async () => {
    const { store, reads } = setup();
    await store.savePlan(ENTRY, 1, '# Plan v1');
    expect(await store.planStored(ENTRY, 1)).toBe(true);
    expect(await store.planStored(ENTRY, 1)).toBe(true);
    expect(reads).toEqual([]);
    // Per entry: the same version of another entry is not known.
    expect(await store.planStored(OTHER, 1)).toBe(false);
    expect(reads).toEqual([1]);
  });

  it('an unknown version is read once; a found text (also via readPlan) makes it known', async () => {
    const { store, reads } = setup([
      { entryId: ENTRY, version: 1, text: '# v1' },
      { entryId: ENTRY, version: 2, text: '# v2' },
    ]);
    expect(await store.planStored(ENTRY, 1)).toBe(true);
    expect(await store.planStored(ENTRY, 1)).toBe(true);
    expect(await store.readPlan(ENTRY, 2)).toBe('# v2');
    expect(await store.planStored(ENTRY, 2)).toBe(true);
    expect(reads).toEqual([1, 2]);
  });

  it('missing and unreadable versions are not cached; a failed save marks nothing', async () => {
    const { store, inner, reads } = setup();
    expect(await store.planStored(ENTRY, 3)).toBe(false);
    expect(await store.planStored(ENTRY, 3)).toBe(false);
    expect(reads).toEqual([3, 3]);
    inner.readPlan = () => Promise.reject(new Error('EACCES'));
    await expect(store.planStored(ENTRY, 4)).rejects.toThrow('EACCES');
    inner.savePlan = () => Promise.reject(new Error('ENOSPC'));
    await expect(store.savePlan(ENTRY, 5, '# v5')).rejects.toThrow('ENOSPC');
    await expect(store.planStored(ENTRY, 5)).rejects.toThrow('EACCES');
  });

  it('load, save and flush go to the inner store unchanged', async () => {
    const { store, inner } = setup();
    const save = vi.spyOn(inner, 'save');
    const records = [sampleDecisionRecord()];
    store.save(ENTRY, records);
    expect(save).toHaveBeenCalledExactlyOnceWith(ENTRY, records);
    expect(await store.load(ENTRY)).toEqual(await inner.load(ENTRY));
    await expect(store.flush()).resolves.toBeUndefined();
  });
});
