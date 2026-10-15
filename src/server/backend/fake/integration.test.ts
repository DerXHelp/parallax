import { describe, expect, it } from 'vitest';
import { makeError } from '@shared/errors';
import { profileSummarySchema } from '@shared/model';
import { SAMPLE_IDS, sampleId, sampleProfile } from '@shared/samples';
import { profileNeedsSetup } from '../../claude/integration';
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
});
