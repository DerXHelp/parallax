import { describe, expect, it } from 'vitest';
import { makeError } from '@shared/errors';
import { profileSummarySchema } from '@shared/model';
import { SAMPLE_IDS, sampleId, sampleProfile } from '@shared/samples';
import { profileNeedsSetup } from '../../claude/integration';
import { createProfileStore } from '../../claude/profiles';
import { CommandError } from '../../sync/ports';
import { FAKE_CLAUDE_PATH, createFakeClaudeIntegration } from './integration';

describe('createFakeClaudeIntegration', () => {
  it('profiles report ok/logged_in (no setup screen); summaries are schema-true', () => {
    const claude = createFakeClaudeIntegration();
    const [summary] = claude.profiles.summaries();
    expect(summary).toMatchObject({
      id: 'standard',
      isDefault: true,
      allowsBypass: false,
      claude: { state: 'ok', path: FAKE_CLAUDE_PATH },
    });
    expect(profileSummarySchema.parse(summary)).toStrictEqual(summary);
    if (summary === undefined) throw new Error('no profile summary');
    expect(profileNeedsSetup(summary.claude)).toBe(false);
  });

  it('launchSpecFor: fake .exe, empty env, profile values; allowsBypass option', async () => {
    const custom = sampleProfile({
      id: sampleId('pf', 1),
      isDefault: false,
      builtin: false,
      contextWindow: 400_000,
      configDir: 'D:\\cfg',
    });
    const claude = createFakeClaudeIntegration({ profiles: [sampleProfile(), custom], allowsBypass: true });
    const spec = await claude.launchSpecFor(custom.id, SAMPLE_IDS.entry);
    expect(spec).toEqual({
      profileId: custom.id,
      executablePath: FAKE_CLAUDE_PATH,
      executableVersion: '2.1.300',
      env: {},
      configDir: 'D:\\cfg',
      sdkOptions: {},
      extraArgs: {},
      allowDangerouslySkipPermissions: true,
      autoCompactWindow: 400_000,
      contextWindow: 400_000,
    });
    expect(claude.profiles.summaries().every((s) => s.allowsBypass)).toBe(true);
    expect(claude.launches).toEqual([{ profileId: custom.id, entryId: SAMPLE_IDS.entry }]);
  });

  it('unknown profile → PROFILE_NOT_FOUND; invalid args → PROFILE_INVALID; setLaunchError', async () => {
    const claude = createFakeClaudeIntegration({ profiles: [sampleProfile({ args: ['--resume', 'x'] })] });
    await expect(claude.launchSpecFor(sampleId('pf', 9), SAMPLE_IDS.entry)).rejects.toMatchObject({
      error: { code: 'PROFILE_NOT_FOUND' },
    });
    await expect(claude.launchSpecFor('standard', SAMPLE_IDS.entry)).rejects.toMatchObject({
      error: { code: 'PROFILE_INVALID' },
    });
    const ok = createFakeClaudeIntegration();
    ok.setLaunchError(makeError('CLAUDE_NOT_FOUND'));
    await expect(ok.launchSpecFor('standard', SAMPLE_IDS.entry)).rejects.toBeInstanceOf(CommandError);
    ok.setLaunchError(null);
    await expect(ok.launchSpecFor('standard', SAMPLE_IDS.entry)).resolves.toMatchObject({
      executablePath: FAKE_CLAUDE_PATH,
    });
  });

  it('checkProfile returns and stores ok', async () => {
    const claude = createFakeClaudeIntegration({ now: () => new Date('2026-10-15T09:00:00.000Z') });
    await expect(claude.checkProfile('standard')).resolves.toMatchObject({
      state: 'ok',
      checkedAt: '2026-10-15T09:00:00.000Z',
    });
    await expect(claude.checkProfile(sampleId('pf', 3))).rejects.toMatchObject({
      error: { code: 'PROFILE_NOT_FOUND' },
    });
  });

  it('WP-34: a passed store wins over `profiles`; checkProfile writes the ok status into it', async () => {
    const other = sampleProfile({ id: sampleId('pf', 2), name: 'Other', isDefault: false, builtin: false });
    const store = createProfileStore([sampleProfile(), other]);
    const claude = createFakeClaudeIntegration({
      store,
      profiles: [sampleProfile({ name: 'ignored' })],
      now: () => new Date('2026-10-15T09:00:00.000Z'),
    });
    expect(claude.profiles.list().map((p) => p.id)).toEqual(['standard', other.id]);
    // Created with ok for every profile already in the store (no setup screen).
    expect(store.claudeStatus(other.id).state).toBe('ok');
    store.setClaudeStatus(other.id, { ...store.claudeStatus(other.id), state: 'not_found' });
    await claude.checkProfile(other.id);
    expect(store.claudeStatus(other.id)).toMatchObject({
      state: 'ok',
      checkedAt: '2026-10-15T09:00:00.000Z',
    });
    expect(claude.profiles.summaries().find((s) => s.id === other.id)?.claude.state).toBe('ok');
  });

  it('WP-34: consoleLaunchFor → claude --resume <id> for the fake console; launch error; unknown profile', async () => {
    const claude = createFakeClaudeIntegration();
    const request = {
      profileId: 'standard',
      entryId: SAMPLE_IDS.entry,
      cwd: 'd:\\Work\\Mixed Case',
      resumeSessionId: SAMPLE_IDS.sessionId,
      model: 'opus',
      permissionMode: 'plan',
    } as const;
    await expect(claude.consoleLaunchFor(request)).resolves.toEqual({
      executablePath: FAKE_CLAUDE_PATH,
      args: ['--resume', SAMPLE_IDS.sessionId],
      env: {},
      explicitEnv: {},
      cwd: 'd:\\Work\\Mixed Case',
    });
    expect(claude.consoleLaunches).toEqual([request]);
    claude.setLaunchError(makeError('CLAUDE_NOT_FOUND'));
    await expect(claude.consoleLaunchFor(request)).rejects.toMatchObject({
      error: { code: 'CLAUDE_NOT_FOUND' },
    });
    claude.setLaunchError(null);
    await expect(claude.consoleLaunchFor({ ...request, profileId: sampleId('pf', 5) })).rejects.toMatchObject(
      {
        error: { code: 'PROFILE_NOT_FOUND' },
      },
    );
    const withEnv = createFakeClaudeIntegration({ consoleEnv: { API_TOKEN: 'fake-secret-1234' } });
    await expect(withEnv.consoleLaunchFor(request)).resolves.toMatchObject({
      env: { API_TOKEN: 'fake-secret-1234' },
      explicitEnv: { API_TOKEN: 'fake-secret-1234' },
    });
  });
});
