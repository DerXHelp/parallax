import { mkdtemp, readFile, readdir, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { STANDARD_PROFILE_ID } from '@shared/common';
import {
  PROFILES_SCHEMA_VERSION,
  profileSummarySchema,
  profilesFileSchema,
  type Profile,
} from '@shared/model';
import {
  sampleClaudeInstallStatus,
  sampleId,
  sampleProfile,
  sampleProfileInput,
  sampleTime,
} from '@shared/samples';
import { REDACTED, redactText } from '../lib/logger';
import { StoreVersionTooNewError, createStoreWarnings } from '../store/jsonStore';
import { CommandError } from '../sync/ports';
import type { ProfileIssueContext } from './profileIssues';
import {
  PROFILES_FILE,
  normalizeProfiles,
  openProfileStore,
  profilesOf,
  readProfilesFile,
  type PersistentProfileStore,
} from './profileStore';
import { STANDARD_PROFILE } from './profiles';

const WORK = sampleId('pf', 1);
const OTHER = sampleId('pf', 2);
const EXE = 'C:\\Tools\\claude.exe';
const NOW = new Date('2026-10-16T10:00:00.000Z');

async function tempHome(): Promise<string> {
  return mkdtemp(path.join(process.env.PARALLAX_HOME ?? os.tmpdir(), 'wp32-profiles-'));
}

const issueContext = (): ProfileIssueContext => ({
  env: { USERPROFILE: 'C:\\Users\\u' },
  persistentEnv: new Map(),
  exists: (file) => file === EXE,
});

async function open(home: string, warnings = createStoreWarnings()): Promise<PersistentProfileStore> {
  return openProfileStore({ home, warnings, issueContext, debounceMs: 5 });
}

async function writeProfiles(
  home: string,
  profiles: unknown[],
  schemaVersion = PROFILES_SCHEMA_VERSION,
): Promise<string> {
  const text = `${JSON.stringify({ schemaVersion, profiles }, null, 2)}\n`;
  await writeFile(path.join(home, PROFILES_FILE), text, 'utf8');
  return text;
}

async function readProfiles(home: string): Promise<Profile[]> {
  return profilesFileSchema.parse(
    JSON.parse(await readFile(path.join(home, PROFILES_FILE), 'utf8')) as unknown,
  ).profiles;
}

function work(p: Partial<Profile> = {}): Profile {
  return sampleProfile({ id: WORK, name: 'Work', color: 'blue', isDefault: false, builtin: false, ...p });
}

async function commandError(fn: () => unknown): Promise<CommandError> {
  try {
    await fn();
  } catch (error) {
    if (error instanceof CommandError) return error;
    throw error;
  }
  throw new Error('expected a CommandError');
}

describe('openProfileStore: loading', () => {
  it('without profiles.json: only "Standard" in memory, nothing written until the first save', async () => {
    const home = await tempHome();
    const store = await open(home);
    expect(store.list()).toEqual([STANDARD_PROFILE]);
    expect(store.getDefault().id).toBe(STANDARD_PROFILE_ID);
    await store.flush();
    expect(await readdir(home)).toEqual([]);

    const saved = store.save(sampleProfileInput({ env: {} }), NOW);
    await store.close();
    expect((await readProfiles(home)).map((p) => p.id)).toEqual([STANDARD_PROFILE_ID, saved.id]);
  });

  it('loads an existing file and registers secret env values with the logger', async () => {
    const home = await tempHome();
    const secret = 'my-very-secret-value-42';
    await writeProfiles(home, [
      STANDARD_PROFILE,
      work({
        env: { ANTHROPIC_API_KEY: secret, Db_Password_Main: 'hunter2-hunter2', PLAIN: 'visible-value-123' },
      }),
    ]);
    const store = await open(home);
    expect(store.list().map((p) => p.id)).toEqual([STANDARD_PROFILE_ID, WORK]);
    expect(store.get(WORK)?.env.ANTHROPIC_API_KEY).toBe(secret);
    expect(redactText(`x ${secret} y`)).toBe(`x ${REDACTED} y`);
    expect(redactText('hunter2-hunter2')).toBe(REDACTED);
    expect(redactText('visible-value-123')).toBe('visible-value-123');
    await store.close();
  });

  it('quarantines a corrupt file (host warning) and continues with "Standard"', async () => {
    const home = await tempHome();
    await writeFile(path.join(home, PROFILES_FILE), '{ not json', 'utf8');
    const warnings = createStoreWarnings();
    const store = await open(home, warnings);
    expect(store.list()).toEqual([STANDARD_PROFILE]);
    expect(warnings.list().map((w) => w.error.code)).toEqual(['STORE_CORRUPT_QUARANTINED']);
    expect((await readdir(home)).some((name) => name.startsWith(`${PROFILES_FILE}.corrupt-`))).toBe(true);
    await store.close();
  });

  it('refuses a file of a newer Parallax and leaves it unchanged', async () => {
    const home = await tempHome();
    const text = await writeProfiles(home, [STANDARD_PROFILE], PROFILES_SCHEMA_VERSION + 1);
    await expect(open(home)).rejects.toBeInstanceOf(StoreVersionTooNewError);
    expect(await readFile(path.join(home, PROFILES_FILE), 'utf8')).toBe(text);
    expect(await readdir(home)).toEqual([PROFILES_FILE]);
  });

  it('adds a missing "Standard" in front and writes the repair back', async () => {
    const home = await tempHome();
    await writeProfiles(home, [work({ isDefault: true })]);
    const store = await open(home);
    expect(store.list().map((p) => [p.id, p.isDefault, p.builtin])).toEqual([
      [STANDARD_PROFILE_ID, false, true],
      [WORK, true, false],
    ]);
    await store.close();
    expect((await readProfiles(home)).map((p) => p.id)).toEqual([STANDARD_PROFILE_ID, WORK]);
  });

  it.each<[string, Profile[], string]>([
    ['several defaults → the first', [STANDARD_PROFILE, work({ isDefault: true })], STANDARD_PROFILE_ID],
    [
      'several defaults → the first (not Standard)',
      [work({ isDefault: true }), { ...STANDARD_PROFILE, isDefault: true }],
      WORK,
    ],
    ['no default → "Standard"', [{ ...STANDARD_PROFILE, isDefault: false }, work()], STANDARD_PROFILE_ID],
  ])('exactly one default: %s', async (_name, profiles, expected) => {
    const home = await tempHome();
    await writeProfiles(home, profiles);
    const store = await open(home);
    expect(
      store
        .list()
        .filter((p) => p.isDefault)
        .map((p) => p.id),
    ).toEqual([expected]);
    expect(store.getDefault().id).toBe(expected);
    await store.close();
    expect((await readProfiles(home)).filter((p) => p.isDefault).map((p) => p.id)).toEqual([expected]);
  });
});

describe('normalizeProfiles', () => {
  it('keeps a consistent list as is (same objects, no repairs)', () => {
    const list = [STANDARD_PROFILE, work()];
    const result = normalizeProfiles(list);
    expect(result.repairs).toEqual([]);
    expect(result.profiles[1]).toBe(list[1]);
  });

  it('drops duplicate ids and fixes builtin', () => {
    const result = normalizeProfiles([
      { ...STANDARD_PROFILE, builtin: false },
      work({ builtin: true }),
      work({ name: 'Duplicate' }),
    ]);
    expect(result.repairs.sort()).toEqual(['builtin_fixed', 'duplicate_id']);
    expect(result.profiles.map((p) => [p.id, p.name, p.builtin])).toEqual([
      [STANDARD_PROFILE_ID, 'Standard', true],
      [WORK, 'Work', false],
    ]);
  });
});

describe('save', () => {
  it('creates a profile with a new pf_ id and server timestamps, not default, then notifies', async () => {
    const store = await open(await tempHome());
    let changes = 0;
    store.onChange(() => {
      changes += 1;
    });
    // Fields the server owns are ignored even if a caller sends them.
    const input = Object.assign(sampleProfileInput(), { isDefault: true, builtin: true });
    const saved = store.save(input, NOW);
    expect(saved.id).toMatch(/^pf_[0-9a-f]{32}$/);
    expect(saved).toMatchObject({
      name: 'Work',
      isDefault: false,
      builtin: false,
      createdAt: NOW.toISOString(),
      updatedAt: NOW.toISOString(),
      configDir: 'C:\\Users\\user\\.claude-work',
    });
    expect(store.get(saved.id)).toEqual(saved);
    expect(changes).toBe(1);
    await store.close();
  });

  it('changes an existing profile: id, createdAt and isDefault stay', async () => {
    const home = await tempHome();
    await writeProfiles(home, [{ ...STANDARD_PROFILE, isDefault: false }, work({ isDefault: true })]);
    const store = await open(home);
    const saved = store.save(sampleProfileInput({ id: WORK, name: 'Work 2', env: {} }), NOW);
    expect(saved).toMatchObject({
      id: WORK,
      name: 'Work 2',
      isDefault: true,
      builtin: false,
      createdAt: sampleTime(),
      updatedAt: NOW.toISOString(),
    });
    await store.close();
    expect((await readProfiles(home)).find((p) => p.id === WORK)?.name).toBe('Work 2');
  });

  it('lets "Standard" be edited (stays builtin)', async () => {
    const store = await open(await tempHome());
    const saved = store.save(sampleProfileInput({ id: STANDARD_PROFILE_ID, name: 'Default', env: {} }), NOW);
    expect(saved).toMatchObject({ id: STANDARD_PROFILE_ID, name: 'Default', builtin: true, isDefault: true });
    expect(saved.createdAt).toBe(STANDARD_PROFILE.createdAt);
    await store.close();
  });

  it('rejects an unknown id (PROFILE_NOT_FOUND) and error issues (PROFILE_INVALID {count})', async () => {
    const store = await open(await tempHome());
    let changes = 0;
    store.onChange(() => {
      changes += 1;
    });
    expect((await commandError(() => store.save(sampleProfileInput({ id: OTHER }), NOW))).error).toEqual({
      code: 'PROFILE_NOT_FOUND',
      params: { profileId: OTHER },
    });
    const invalid = sampleProfileInput({
      args: ['--resume', 'x'],
      executable: { kind: 'path', path: 'C:\\Tools\\missing.exe' },
    });
    expect((await commandError(() => store.save(invalid, NOW))).error).toEqual({
      code: 'PROFILE_INVALID',
      params: { count: 2 },
    });
    // Warnings and infos do not block.
    store.save(
      sampleProfileInput({ args: ['--dangerously-skip-permissions'], env: { K: '${env:NOPE}' } }),
      NOW,
    );
    expect(store.list()).toHaveLength(2);
    expect(changes).toBe(1);
    await store.close();
  });
});

describe('remove and setDefault', () => {
  async function withWork(): Promise<{ home: string; store: PersistentProfileStore }> {
    const home = await tempHome();
    await writeProfiles(home, [{ ...STANDARD_PROFILE, isDefault: false }, work({ isDefault: true })]);
    return { home, store: await open(home) };
  }

  it('never deletes "Standard"', async () => {
    const { store } = await withWork();
    expect(
      (
        await commandError(() => {
          store.remove(STANDARD_PROFILE_ID);
        })
      ).error,
    ).toEqual({
      code: 'PROFILE_NOT_DELETABLE',
      params: { profileId: STANDARD_PROFILE_ID },
    });
    expect(
      (
        await commandError(() => {
          store.remove(OTHER);
        })
      ).error.code,
    ).toBe('PROFILE_NOT_FOUND');
    await store.close();
  });

  it('deleting the default makes "Standard" the default', async () => {
    const { home, store } = await withWork();
    store.setClaudeStatus(WORK, sampleClaudeInstallStatus());
    let changes = 0;
    store.onChange(() => {
      changes += 1;
    });
    store.remove(WORK);
    expect(store.list().map((p) => [p.id, p.isDefault])).toEqual([[STANDARD_PROFILE_ID, true]]);
    expect(store.getDefault().id).toBe(STANDARD_PROFILE_ID);
    expect(changes).toBe(1);
    await store.close();
    expect((await readProfiles(home)).map((p) => [p.id, p.isDefault])).toEqual([[STANDARD_PROFILE_ID, true]]);
  });

  it('sets exactly one default; refuses unknown profiles and profiles with errors', async () => {
    const { store } = await withWork();
    store.setDefault(STANDARD_PROFILE_ID);
    expect(store.list().map((p) => [p.id, p.isDefault])).toEqual([
      [STANDARD_PROFILE_ID, true],
      [WORK, false],
    ]);
    expect(
      (
        await commandError(() => {
          store.setDefault(OTHER);
        })
      ).error.code,
    ).toBe('PROFILE_NOT_FOUND');
    await store.close();

    const home = await tempHome();
    await writeProfiles(home, [STANDARD_PROFILE, work({ args: ['-p'] })]);
    const broken = await open(home);
    expect(
      (
        await commandError(() => {
          broken.setDefault(WORK);
        })
      ).error,
    ).toEqual({
      code: 'PROFILE_INVALID',
      params: { count: 1 },
    });
    expect(broken.getDefault().id).toBe(STANDARD_PROFILE_ID);
    await broken.close();
  });

  it('setDefault writes profiles.json even when only "Standard" exists', async () => {
    const home = await tempHome();
    const store = await open(home);
    store.setDefault(STANDARD_PROFILE_ID);
    await store.close();
    expect((await readProfiles(home)).map((p) => p.id)).toEqual([STANDARD_PROFILE_ID]);
  });
});

describe('summaries, claude status and onChange', () => {
  it('shows defaults, configDir, issues and the claude status; entryCount stays 0', async () => {
    const home = await tempHome();
    await writeProfiles(home, [
      STANDARD_PROFILE,
      work({
        configDir: 'D:\\claude\\work',
        args: ['--dangerously-skip-permissions'],
        defaults: { model: 'haiku', permissionMode: 'plan', effort: 'high' },
        env: { ANTHROPIC_API_KEY: 'secret-not-in-summaries' },
      }),
    ]);
    const store = await open(home);
    const summaries = store.summaries();
    expect(summaries.map((s) => profileSummarySchema.parse(s))).toEqual(summaries);
    expect(summaries[1]).toMatchObject({
      id: WORK,
      allowsBypass: true,
      defaults: { model: 'haiku', permissionMode: 'plan', effort: 'high' },
      configDir: 'D:\\claude\\work',
      issues: [
        {
          level: 'warning',
          issue: {
            code: 'PROFILE_BYPASS_ENABLED',
            params: { index: 0, flag: '--dangerously-skip-permissions' },
          },
        },
      ],
      entryCount: 0,
      claude: { state: 'checking' },
    });
    expect(JSON.stringify(summaries)).not.toContain('secret-not-in-summaries');

    const changes: string[] = [];
    const unsubscribe = store.onChange(() => changes.push('change'));
    store.setClaudeStatus(WORK, sampleClaudeInstallStatus());
    expect(store.summaries()[1]?.claude).toEqual(sampleClaudeInstallStatus());
    expect(store.claudeStatus(WORK)).toEqual(sampleClaudeInstallStatus());
    unsubscribe();
    store.setClaudeStatus(WORK, sampleClaudeInstallStatus({ state: 'error' }));
    expect(changes).toEqual(['change']);
    await store.close();
  });

  it('recomputes cached issues after a change; a failing listener does not break the change', async () => {
    const store = await open(await tempHome());
    store.onChange(() => {
      throw new Error('listener failed');
    });
    const saved = store.save(sampleProfileInput({ env: {} }), NOW);
    expect(store.summaries()[1]?.issues).toEqual([]);
    store.save(sampleProfileInput({ id: saved.id, env: {}, args: ['--verbose'], passRawArgs: true }), NOW);
    expect(store.summaries()[1]?.issues.map((i) => i.issue.code)).toEqual(['PROFILE_ARG_PASSED_RAW']);
    await store.close();
  });

  it('survives a reopen', async () => {
    const home = await tempHome();
    const first = await open(home);
    const saved = first.save(sampleProfileInput({ env: {} }), NOW);
    first.setDefault(saved.id);
    await first.close();
    const second = await open(home);
    expect(second.getDefault().id).toBe(saved.id);
    expect(second.get(saved.id)).toEqual({ ...saved, isDefault: true });
    await second.close();
  });
});

describe('readProfilesFile (read-only, preflight)', () => {
  it.each<[string, (home: string) => Promise<unknown>, string]>([
    ['missing', () => Promise.resolve(), 'missing'],
    ['ok', (home) => writeProfiles(home, [work({ isDefault: true })]), 'ok'],
    ['newer', (home) => writeProfiles(home, [], 7), 'newer'],
    ['broken JSON', (home) => writeFile(path.join(home, PROFILES_FILE), '{', 'utf8'), 'invalid'],
    ['invalid schema', (home) => writeProfiles(home, [{ id: 'nope' }]), 'invalid'],
  ])('%s', async (_name, prepare, kind) => {
    const home = await tempHome();
    await prepare(home);
    const before = await readdir(home);
    const read = await readProfilesFile(home);
    expect(read.kind).toBe(kind);
    expect(await readdir(home)).toEqual(before);
    if (read.kind === 'ok') {
      expect(read.repairs).toEqual(['standard_added']);
      expect(profilesOf(read).map((p) => p.id)).toEqual([STANDARD_PROFILE_ID, WORK]);
    } else {
      expect(profilesOf(read)).toEqual([STANDARD_PROFILE]);
    }
  });
});
