import { mkdir, mkdtemp, readdir, rm, utimes, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { cleanupOwnData, findTranscriptDirs, isOwnRoot, projectDirName } from './cleanup';

const ID_PROBE = '11111111-2222-3333-4444-555555555555';
const ID_SMOKE = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';
const ID_FOREIGN = '99999999-8888-7777-6666-555555555555';

let temp = '';

beforeEach(async () => {
  temp = await mkdtemp(path.join(os.tmpdir(), 'cli-check-cleanup-'));
});

afterEach(async () => {
  await rm(temp, { recursive: true, force: true });
});

async function exists(target: string): Promise<boolean> {
  try {
    await readdir(target);
    return true;
  } catch {
    return false;
  }
}

async function transcript(projects: string, cwd: string, id: string, recordedCwds: string[]): Promise<string> {
  const dir = path.join(projects, projectDirName(cwd));
  await mkdir(dir, { recursive: true });
  const lines = [JSON.stringify({ type: 'summary' }), ...recordedCwds.map((recorded) => JSON.stringify({ type: 'user', cwd: recorded }))];
  await writeFile(path.join(dir, `${id}.jsonl`), `${lines.join('\n')}\n`);
  return dir;
}

describe('cleanup helpers (WP-62)', () => {
  it('projectDirName mirrors the CLI folder names', () => {
    expect(projectDirName('C:\\Users\\me\\AppData\\Local\\Temp\\parallax-cli-check-x\\work')).toBe(
      'C--Users-me-AppData-Local-Temp-parallax-cli-check-x-work',
    );
  });

  it('isOwnRoot: own prefix and directly inside the temp folder', () => {
    expect(isOwnRoot('C:\\T\\parallax-cli-check-20261112-ab', 'C:\\T')).toBe(true);
    expect(isOwnRoot('c:\\t\\parallax-live-e2e-xy', 'C:\\T')).toBe(true);
    expect(isOwnRoot('C:\\T\\sub\\parallax-cli-check-x', 'C:\\T')).toBe(false);
    expect(isOwnRoot('C:\\T\\my-project', 'C:\\T')).toBe(false);
    expect(isOwnRoot('C:\\T', 'C:\\T')).toBe(false);
  });
});

describe('cleanupOwnData (WP-62)', () => {
  it('deletes verified own data, keeps and reports everything else', async () => {
    const root = path.join(temp, 'parallax-cli-check-20261112-ab');
    const work = path.join(root, 'work');
    const smokeRoot = path.join(temp, 'parallax-live-e2e-cd');
    const foreignRoot = path.join(temp, 'some-project');
    await mkdir(path.join(work, 'sub'), { recursive: true });
    await writeFile(path.join(work, 'file.txt'), 'x');
    const configDir = path.join(temp, '.claude');
    const projects = path.join(configDir, 'projects');

    const ownProbe = await transcript(projects, work, ID_PROBE, [work, path.join(work, 'sub')]);
    const ownSmoke = await transcript(projects, path.join(smokeRoot, 'session-1'), ID_SMOKE, [path.join(smokeRoot, 'session-1')]);
    const mixed = await transcript(projects, path.join(root, 'home'), ID_FOREIGN, [path.join(root, 'home'), 'C:\\elsewhere']);
    const noCwd = await transcript(projects, path.join(root, 'empty'), '00000000-0000-0000-0000-000000000000', []);
    const foreign = await transcript(projects, foreignRoot, ID_FOREIGN, [foreignRoot]);

    const tasks = path.join(temp, 'claude');
    await mkdir(path.join(tasks, 'hash1', ID_SMOKE), { recursive: true });
    await writeFile(path.join(tasks, 'hash1', ID_SMOKE, 'out.txt'), 'x');
    await mkdir(path.join(tasks, 'hash2', ID_PROBE), { recursive: true });
    await mkdir(path.join(tasks, 'hash2', ID_FOREIGN), { recursive: true });

    const since = new Date(Date.now() - 60_000);
    const plans = path.join(configDir, 'plans');
    await mkdir(plans, { recursive: true });
    await writeFile(path.join(plans, 'new-plan.md'), '# plan');
    await writeFile(path.join(plans, 'old-plan.md'), '# old');
    const old = new Date('2026-01-01T00:00:00.000Z');
    await utimes(path.join(plans, 'old-plan.md'), old, old);
    const claudeJson = path.join(temp, '.claude.json');
    await writeFile(claudeJson, JSON.stringify({ projects: { [work]: {}, [foreignRoot]: {} }, oauthAccount: { emailAddress: 'x' } }));

    const report = await cleanupOwnData({
      roots: [root, smokeRoot, foreignRoot],
      deleteRoots: [root, foreignRoot],
      sessionIds: [ID_PROBE, 'not-a-session-id'],
      configDir,
      claudeJson,
      tempDir: temp,
      since,
    });

    expect(report.errors).toEqual([]);
    expect(report.deleted).toEqual(
      [ownProbe, ownSmoke, path.join(tasks, 'hash1', ID_SMOKE), path.join(tasks, 'hash1'), path.join(tasks, 'hash2', ID_PROBE), root].sort(),
    );
    expect(await exists(root)).toBe(false);
    expect(await exists(path.join(tasks, 'hash1'))).toBe(false);
    expect(await exists(path.join(tasks, 'hash2', ID_FOREIGN))).toBe(true);
    for (const kept of [mixed, noCwd, foreign]) expect(await exists(kept)).toBe(true);

    const kept = report.kept.map((entry) => [entry.path, entry.reason]);
    expect(kept).toContainEqual([foreignRoot, expect.stringContaining('not an own temp root')]);
    expect(kept).toContainEqual([mixed, expect.stringContaining('foreign cwd C:\\elsewhere')]);
    expect(kept).toContainEqual([noCwd, expect.stringContaining('no cwd recorded')]);
    expect(kept).toContainEqual([path.join(plans, 'new-plan.md'), expect.stringContaining('only reported')]);
    expect(kept).toContainEqual([claudeJson, '1 project entry of own temp folders (only reported)']);
    expect(kept.map(([target]) => target)).not.toContain(path.join(plans, 'old-plan.md'));
    expect(kept.map(([target]) => target)).not.toContain(foreign);
    expect(JSON.stringify(report)).not.toContain('emailAddress');
  });

  it('missing folders and files are no error', async () => {
    const report = await cleanupOwnData({
      roots: [path.join(temp, 'parallax-cli-check-gone')],
      deleteRoots: [],
      sessionIds: [],
      configDir: path.join(temp, 'none'),
      claudeJson: path.join(temp, 'none.json'),
      tempDir: temp,
      since: new Date(),
    });
    expect(report).toEqual({ deleted: [], kept: [], errors: [] });
  });

  it('findTranscriptDirs does not match folders that only share a prefix', async () => {
    const root = path.join(temp, 'parallax-cli-check-a');
    const projects = path.join(temp, 'projects');
    await transcript(projects, `${root}b`, ID_PROBE, [`${root}b`]);
    expect(await findTranscriptDirs(projects, root)).toEqual([]);
  });
});
