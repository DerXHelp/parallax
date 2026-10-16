import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { SlashCommandInfo } from '@shared/model';
import { SAMPLE_TIME, sampleId } from '@shared/samples';
import { FAKE_COMMANDS } from '../backend/fake/defaults';
import { nodeFsOps, type FsOps } from '../lib/fs';
import {
  COMMANDS_FILE,
  commandsCacheFileSchema,
  createCommandCatalogStore,
  createMemoryCommandCatalogStore,
  toSlashCommands,
} from './commandCatalog';

const ENTRY = sampleId('en', 5);

const deploy: SlashCommandInfo = {
  name: 'deploy',
  description: 'Deploy it',
  argumentHint: '<env>',
  aliases: [],
  builtin: false,
};

describe('toSlashCommands (tolerant, ADR-108)', () => {
  it('maps the SDK list, fills defaults, skips unusable entries and duplicates', () => {
    expect(
      toSlashCommands([
        { name: 'clear', description: 'Clear', argumentHint: '[name]', aliases: ['reset'], builtin: true },
        { name: 'deploy', description: 'Deploy it', argumentHint: '<env>' },
        { name: '' },
        { description: 'no name' },
        'text',
        null,
        { name: 'clear', description: 'duplicate' },
        { name: 'odd', description: 7, aliases: [1], builtin: 'yes', extra: true },
      ]),
    ).toEqual([
      { name: 'clear', description: 'Clear', argumentHint: '[name]', aliases: ['reset'], builtin: true },
      deploy,
      { name: 'odd', description: '', argumentHint: '', aliases: [], builtin: false },
    ]);
    expect(toSlashCommands(undefined)).toEqual([]);
    expect(toSlashCommands({ commands: [] })).toEqual([]);
    expect(toSlashCommands(FAKE_COMMANDS).map((c) => c.name)).toEqual([
      'clear',
      'compact',
      'context',
      'model',
      'rename',
    ]);
  });
});

let home = '';

beforeEach(async () => {
  home = await mkdtemp(path.join(os.tmpdir(), 'parallax-test-commands-'));
});

afterEach(async () => {
  await rm(home, { recursive: true, force: true });
});

const fileOf = (entryId: string): string => path.join(home, 'entries', entryId, COMMANDS_FILE);

describe('createCommandCatalogStore (entries/<id>/commands.json)', () => {
  it('no file → null; save writes {schemaVersion 1, commands, at}; a new store reads it', async () => {
    const store = createCommandCatalogStore({ home, now: () => new Date(SAMPLE_TIME) });
    expect(await store.load(ENTRY)).toBeNull();
    store.save(ENTRY, [deploy]);
    // Read-after-write before the file landed.
    expect(await store.load(ENTRY)).toEqual([deploy]);
    await store.flush();
    const raw: unknown = JSON.parse(await readFile(fileOf(ENTRY), 'utf8'));
    expect(raw).toEqual({ schemaVersion: 1, commands: [deploy], at: SAMPLE_TIME });
    const fresh = createCommandCatalogStore({ home });
    expect(await fresh.load(ENTRY)).toEqual([deploy]);
  });

  it('coalesces writes per entry: the last list wins', async () => {
    const writes: string[] = [];
    const fs: FsOps = {
      ...nodeFsOps,
      writeFile: async (file, data) => {
        writes.push(typeof data === 'string' ? data : '');
        await nodeFsOps.writeFile(file, data);
      },
    };
    const store = createCommandCatalogStore({ home, fs });
    for (const name of ['a', 'b', 'c', 'd']) store.save(ENTRY, [{ ...deploy, name }]);
    await store.flush();
    expect(writes.length).toBeLessThanOrEqual(2);
    const raw = commandsCacheFileSchema.parse(JSON.parse(await readFile(fileOf(ENTRY), 'utf8')));
    expect(raw.commands.map((c) => c.name)).toEqual(['d']);
  });

  it('broken, invalid or newer files read as no cache', async () => {
    await mkdir(path.dirname(fileOf(ENTRY)), { recursive: true });
    const store = () => createCommandCatalogStore({ home });
    await writeFile(fileOf(ENTRY), '{nope');
    expect(await store().load(ENTRY)).toBeNull();
    await writeFile(
      fileOf(ENTRY),
      JSON.stringify({ schemaVersion: 1, commands: [{ name: 1 }], at: SAMPLE_TIME }),
    );
    expect(await store().load(ENTRY)).toBeNull();
    await writeFile(fileOf(ENTRY), JSON.stringify({ schemaVersion: 2, commands: [], at: SAMPLE_TIME }));
    expect(await store().load(ENTRY)).toBeNull();
  });

  it('a failing write is logged, never thrown', async () => {
    const fs: FsOps = { ...nodeFsOps, writeFile: () => Promise.reject(new Error('disk full')) };
    const store = createCommandCatalogStore({ home, fs });
    store.save(ENTRY, [deploy]);
    await expect(store.flush()).resolves.toBeUndefined();
    expect(await store.load(ENTRY)).toEqual([deploy]);
  });
});

describe('createMemoryCommandCatalogStore', () => {
  it('seeds, records saves and returns copies', async () => {
    const store = createMemoryCommandCatalogStore({ [ENTRY]: [deploy] });
    const loaded = await store.load(ENTRY);
    loaded?.pop();
    expect(await store.load(ENTRY)).toEqual([deploy]);
    store.save(ENTRY, []);
    expect(store.saves).toEqual([{ entryId: ENTRY, commands: [] }]);
    expect(await store.load(sampleId('en', 6))).toBeNull();
  });
});
