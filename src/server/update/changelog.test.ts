import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { changelogResponseSchema } from '@shared/http';
import { CommandError } from '../sync/ports';
import { CHANGELOG_FILE, availableNotes, installedNotes, readChangelogFile } from './changelog';

const temps: string[] = [];
afterEach(async () => {
  for (const dir of temps.splice(0)) await rm(dir, { recursive: true, force: true });
});

async function temp(): Promise<string> {
  const dir = await mkdtemp(path.join(process.env.PARALLAX_HOME ?? os.tmpdir(), 'wp87a-notes-'));
  temps.push(dir);
  return dir;
}

const CHANGELOG = [
  '# Changelog',
  '',
  '## [Unveröffentlicht]',
  '',
  '### Neu',
  '',
  '- Next.',
  '',
  '## [1.1.0] – 2026-12-10',
  '',
  '### Neu',
  '',
  '- Eleven.',
  '',
  '## [1.0.1] – 2026-12-01',
  '',
  '### Behoben',
  '',
  '- One-one.',
  '',
  '## [1.0.0] – 2026-11-28',
  '',
  '### Neu',
  '',
  '- First.',
  '',
].join('\n');

function versions(sections: { version: string | null }[]): (string | null)[] {
  return sections.map((section) => section.version);
}

async function code(promise: Promise<unknown>): Promise<string> {
  const error: unknown = await promise.then(
    () => null,
    (e: unknown) => e,
  );
  if (!(error instanceof CommandError)) throw new Error('expected a CommandError');
  return error.error.code;
}

describe('installedNotes', () => {
  it('gives the own section, or the sections after `since`', () => {
    expect(installedNotes(CHANGELOG, '1.0.1', undefined)).toEqual([
      { version: '1.0.1', date: '2026-12-01', body: '### Behoben\n\n- One-one.' },
    ]);
    expect(versions(installedNotes(CHANGELOG, '1.1.0', '1.0.0'))).toEqual(['1.1.0', '1.0.1']);
    expect(versions(installedNotes(CHANGELOG, '1.2.0-rc.1', undefined))).toEqual([null]);
    expect(installedNotes(CHANGELOG, '0.9.0', undefined)).toEqual([]);
  });
});

describe('availableNotes', () => {
  it('lists the sections between running and target; for a downgrade only the target', () => {
    const between = availableNotes({
      running: '1.0.0',
      target: '1.1.0',
      downgrade: false,
      text: CHANGELOG,
      fallback: null,
    });
    expect(versions(between)).toEqual(['1.1.0', '1.0.1']);
    expect(changelogResponseSchema.parse({ version: '1.1.0', sections: between }).sections).toHaveLength(2);
    const down = availableNotes({
      running: '1.1.0',
      target: '1.0.0',
      downgrade: true,
      text: CHANGELOG,
      fallback: null,
    });
    expect(versions(down)).toEqual(['1.0.0']);
  });

  it('falls back to the notes of latest.json', () => {
    expect(
      availableNotes({ running: '1.0.0', target: '1.0.1', downgrade: false, text: null, fallback: '- Fix.' }),
    ).toEqual([{ version: '1.0.1', date: null, body: '- Fix.' }]);
    const empty = availableNotes({
      running: '1.1.0',
      target: '1.2.0',
      downgrade: false,
      text: CHANGELOG,
      fallback: '- New.',
    });
    expect(empty).toEqual([{ version: '1.2.0', date: null, body: '- New.' }]);
    expect(
      availableNotes({ running: '1.0.0', target: '1.0.1', downgrade: false, text: null, fallback: null }),
    ).toEqual([]);
  });
});

describe('readChangelogFile', () => {
  it('reads CHANGELOG.md of a folder without BOM', async () => {
    const dir = await temp();
    await writeFile(path.join(dir, CHANGELOG_FILE), `${String.fromCharCode(0xfeff)}${CHANGELOG}`);
    expect(await readChangelogFile(dir)).toBe(CHANGELOG);
    expect(await code(readChangelogFile(path.join(dir, 'missing')))).toBe('FILE_NOT_FOUND');
  });
});
