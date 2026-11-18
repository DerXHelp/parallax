import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { schemaHash, STORE_SCHEMAS, storeSchemaHashes } from './schemas';

const serverDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

function sourceFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((item) => {
    const full = path.join(dir, item.name);
    if (item.isDirectory()) return item.name === '__snapshots__' ? [] : sourceFiles(full);
    return item.name.endsWith('.ts') && !item.name.endsWith('.test.ts') ? [full] : [];
  });
}

describe('store schema list', () => {
  it('has unique ids and a hash per store', () => {
    const hashes = storeSchemaHashes();
    expect(Object.keys(hashes)).toEqual(STORE_SCHEMAS.map((store) => store.id));
    expect(new Set(Object.keys(hashes)).size).toBe(STORE_SCHEMAS.length);
    for (const hash of Object.values(hashes)) expect(hash).toMatch(/^[0-9a-f]{64}$/);
    expect(Object.keys(hashes)).toContain('sessions.json');
    expect(Object.keys(hashes)).toContain('entries/*/*.transcript.jsonl');
  });

  it('lists the schema of every JsonStore of the server', () => {
    const listSource = readFileSync(path.join(serverDir, 'store', 'schemas.ts'), 'utf8');
    const used = new Set<string>();
    for (const file of sourceFiles(serverDir)) {
      const text = readFileSync(file, 'utf8');
      for (const match of text.matchAll(/new JsonStore<[^>]+>\(\{[\s\S]*?schema: (\w+)/g)) {
        used.add(match[1] ?? '');
      }
    }
    expect(used.size).toBeGreaterThanOrEqual(9);
    for (const name of used) expect(listSource, name).toContain(name);
  });

  it('leaves processes.json, auth-secret.json and the files of several computers out of the backup', () => {
    const excluded = STORE_SCHEMAS.filter((store) => !store.backup).map((store) => store.id);
    expect(excluded).toEqual([
      'processes.json',
      'auth-secret.json',
      'multi-host.json',
      'hosts.json',
      'remote/peer.json',
      'remote/events.json',
      'keys/*.json',
    ]);
    expect(STORE_SCHEMAS.find((store) => store.kind === 'jsonl')?.backup).toBe(true);
  });
});

describe('schemaHash', () => {
  const base = z.object({ schemaVersion: z.literal(1), items: z.array(z.string()) });

  it('is stable and ignores descriptions and titles', () => {
    expect(schemaHash(base)).toBe(
      schemaHash(z.object({ schemaVersion: z.literal(1), items: z.array(z.string()) })),
    );
    expect(schemaHash(base.describe('the file'))).toBe(schemaHash(base));
    expect(schemaHash(base.meta({ title: 'File' }))).toBe(schemaHash(base));
  });

  it('changes with a new field, a new value or a property named "description"', () => {
    expect(schemaHash(base.extend({ added: z.boolean().default(false) }))).not.toBe(schemaHash(base));
    expect(schemaHash(z.object({ schemaVersion: z.literal(2), items: z.array(z.string()) }))).not.toBe(
      schemaHash(base),
    );
    expect(schemaHash(base.extend({ description: z.string() }))).not.toBe(schemaHash(base));
  });

  it('handles transforms (input side)', () => {
    const transformed = z.object({ at: z.string().transform((value) => value.length) });
    expect(schemaHash(transformed)).toMatch(/^[0-9a-f]{64}$/);
  });
});
