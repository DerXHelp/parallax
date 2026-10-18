import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { RateLimitInfo } from '@shared/model';
import { SAMPLE_TIME, sampleId } from '@shared/samples';
import { StoreVersionTooNewError } from '../store/jsonStore';
import {
  ACCOUNT_LIMITS_FILE,
  MODEL_CATALOGS_FILE,
  createMemoryCatalogStore,
  openCatalogStore,
  type StoredModelCatalog,
} from './catalogStore';

const catalog: StoredModelCatalog = {
  options: [
    {
      value: 'haiku',
      displayName: 'Haiku',
      description: 'Fast',
      supportsEffort: true,
      supportedEffortLevels: ['low', 'high'],
      supportsFastMode: false,
      supportsAutoMode: true,
    },
  ],
  resolved: { haiku: 'claude-haiku-5-5' },
  at: SAMPLE_TIME,
};

const limit: RateLimitInfo = {
  status: 'allowed_warning',
  rateLimitType: 'five_hour',
  resetsAt: SAMPLE_TIME,
  utilization: 0.9,
  windows: { five_hour: { utilization: 0.9, resetsAt: SAMPLE_TIME } },
  at: SAMPLE_TIME,
};

let home = '';

beforeEach(async () => {
  home = await mkdtemp(path.join(os.tmpdir(), 'parallax-test-catalogs-'));
});

afterEach(async () => {
  await rm(home, { recursive: true, force: true });
});

describe('openCatalogStore (ADR-114)', () => {
  it('starts empty, writes both files (schemaVersion 1) and reads them back after a reopen', async () => {
    const store = await openCatalogStore({ home, debounceMs: 1 });
    expect(store.models()).toEqual({});
    expect(store.limits()).toEqual({});
    store.setModels('standard', catalog);
    store.setLimit(sampleId('pf', 2), limit);
    await store.close();
    const models: unknown = JSON.parse(await readFile(path.join(home, MODEL_CATALOGS_FILE), 'utf8'));
    expect(models).toEqual({ schemaVersion: 1, profiles: { standard: catalog } });
    const limits: unknown = JSON.parse(await readFile(path.join(home, ACCOUNT_LIMITS_FILE), 'utf8'));
    expect(limits).toEqual({ schemaVersion: 1, profiles: { [sampleId('pf', 2)]: limit } });
    const again = await openCatalogStore({ home });
    expect(again.models()).toEqual({ standard: catalog });
    expect(again.limits()).toEqual({ [sampleId('pf', 2)]: limit });
    // Copies: callers cannot change the stored value.
    const copy = again.models();
    copy.standard?.options.pop();
    expect(again.models().standard?.options).toHaveLength(1);
    await again.close();
  });

  it('a file of a newer Parallax aborts like every store (ADR-020) and stays unchanged', async () => {
    const newer = JSON.stringify({ schemaVersion: 2, profiles: {} });
    await writeFile(path.join(home, ACCOUNT_LIMITS_FILE), newer);
    await expect(openCatalogStore({ home })).rejects.toBeInstanceOf(StoreVersionTooNewError);
    expect(await readFile(path.join(home, ACCOUNT_LIMITS_FILE), 'utf8')).toBe(newer);
  });

  it('ADR-102 (WP-34): removeModels/removeLimit drop one profile, persisted; unknown ids are no-ops', async () => {
    const store = await openCatalogStore({ home, debounceMs: 1 });
    store.setModels('standard', catalog);
    store.setModels(sampleId('pf', 2), catalog);
    store.setLimit(sampleId('pf', 2), limit);
    store.removeModels(sampleId('pf', 2));
    store.removeLimit(sampleId('pf', 2));
    store.removeModels(sampleId('pf', 9));
    store.removeLimit(sampleId('pf', 9));
    await store.close();
    const again = await openCatalogStore({ home });
    expect(again.models()).toEqual({ standard: catalog });
    expect(again.limits()).toEqual({});
    await again.close();
  });

  it('a missing resolved map defaults to {} (older file of the same version)', async () => {
    const { resolved: _resolved, ...withoutResolved } = catalog;
    await writeFile(
      path.join(home, MODEL_CATALOGS_FILE),
      JSON.stringify({ schemaVersion: 1, profiles: { standard: withoutResolved } }),
    );
    const store = await openCatalogStore({ home });
    expect(store.models().standard?.resolved).toEqual({});
    await store.close();
  });
});

describe('createMemoryCatalogStore', () => {
  it('validates like the file and returns copies', async () => {
    const store = createMemoryCatalogStore({ models: { standard: catalog } });
    expect(store.models()).toEqual({ standard: catalog });
    store.setLimit('standard', limit);
    expect(store.limits()).toEqual({ standard: limit });
    expect(() => {
      store.setLimit('standard', { ...limit, status: 'nope' as RateLimitInfo['status'] });
    }).toThrow();
    await store.flush();
    expect(store.flushes).toBe(1);
    store.removeModels('standard');
    store.removeLimit('standard');
    expect(store.models()).toEqual({});
    expect(store.limits()).toEqual({});
  });
});
