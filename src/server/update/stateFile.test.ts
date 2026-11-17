import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { UPDATE_STATE_FILE, readDismissedVersion, writeDismissedVersion } from './stateFile';

const temps: string[] = [];
afterEach(async () => {
  for (const dir of temps.splice(0)) await rm(dir, { recursive: true, force: true });
});

async function temp(): Promise<string> {
  const dir = await mkdtemp(path.join(process.env.PARALLAX_HOME ?? os.tmpdir(), 'wp87a-state-'));
  temps.push(dir);
  return dir;
}

describe('update-state.json', () => {
  it('keeps the dismissed version', async () => {
    const home = await temp();
    expect(await readDismissedVersion(home)).toBeNull();
    await writeDismissedVersion(home, '1.0.1');
    expect(await readDismissedVersion(home)).toBe('1.0.1');
    expect(JSON.parse(await readFile(path.join(home, UPDATE_STATE_FILE), 'utf8'))).toEqual({
      schemaVersion: 1,
      dismissedVersion: '1.0.1',
    });
  });

  it('treats a broken or unknown file as nothing dismissed', async () => {
    const home = await temp();
    for (const content of [
      '{"schemaVersion":2}',
      '{broken',
      '{"schemaVersion":1,"dismissedVersion":"latest"}',
    ]) {
      await writeFile(path.join(home, UPDATE_STATE_FILE), content);
      expect(await readDismissedVersion(home)).toBeNull();
    }
  });
});
