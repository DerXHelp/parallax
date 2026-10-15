import { describe, expect, it } from 'vitest';
import { STANDARD_PROFILE_ID } from '@shared/common';
import { profileSchema, profileSummarySchema } from '@shared/model';
import { sampleClaudeInstallStatus, sampleProfile } from '@shared/samples';
import { STANDARD_PROFILE, createProfileStore, profileSummary, uncheckedClaudeStatus } from './profiles';

const OTHER_ID = 'pf_0123456789abcdef0123456789abcdef';

describe('built-in profile "Standard"', () => {
  it('matches the contract (WP-02 §5.1)', () => {
    const time = STANDARD_PROFILE.createdAt;
    expect(STANDARD_PROFILE).toEqual(sampleProfile({ createdAt: time, updatedAt: time }));
    expect(profileSchema.parse(STANDARD_PROFILE)).toEqual(STANDARD_PROFILE);
    expect(STANDARD_PROFILE).toMatchObject({
      id: STANDARD_PROFILE_ID,
      name: 'Standard',
      isDefault: true,
      builtin: true,
      executable: { kind: 'auto' },
      configDir: null,
      env: {},
      args: [],
      passRawArgs: false,
      defaults: { model: null, permissionMode: null, effort: null },
    });
  });

  it('is deeply frozen', () => {
    expect(Object.isFrozen(STANDARD_PROFILE)).toBe(true);
    expect(() => {
      STANDARD_PROFILE.args.push('--dangerously-skip-permissions');
    }).toThrow(TypeError);
    expect(() => {
      STANDARD_PROFILE.env.X = '1';
    }).toThrow(TypeError);
  });
});

describe('createProfileStore (Phase 1)', () => {
  it('contains only "Standard" by default', () => {
    const store = createProfileStore();
    expect(store.list()).toEqual([STANDARD_PROFILE]);
    expect(store.get(STANDARD_PROFILE_ID)).toBe(STANDARD_PROFILE);
    expect(store.get(OTHER_ID)).toBeUndefined();
    expect(store.getDefault()).toBe(STANDARD_PROFILE);
  });

  it('summarizes without env or args, status "checking" before the first check', () => {
    const [summary] = createProfileStore().summaries();
    expect(summary).toEqual({
      id: STANDARD_PROFILE_ID,
      name: 'Standard',
      color: 'slate',
      isDefault: true,
      builtin: true,
      allowsBypass: false,
      claude: uncheckedClaudeStatus(),
    });
    expect(profileSummarySchema.parse(summary)).toEqual(summary);
  });

  it('keeps the last claude status per profile', () => {
    const store = createProfileStore();
    const status = sampleClaudeInstallStatus();
    store.setClaudeStatus(STANDARD_PROFILE_ID, status);
    expect(store.claudeStatus(STANDARD_PROFILE_ID)).toBe(status);
    expect(store.summaries()[0]?.claude).toBe(status);
    expect(store.claudeStatus(OTHER_ID)).toEqual(uncheckedClaudeStatus());
  });

  it('derives allowsBypass from the args (C.3)', () => {
    const bypass = sampleProfile({
      id: OTHER_ID,
      isDefault: false,
      builtin: false,
      args: ['--dangerously-skip-permissions'],
    });
    expect(profileSummary(bypass, uncheckedClaudeStatus()).allowsBypass).toBe(true);
    const mode = sampleProfile({ args: ['--permission-mode', 'bypassPermissions'] });
    expect(profileSummary(mode, uncheckedClaudeStatus()).allowsBypass).toBe(true);
  });

  it('has exactly one default (the first marked one, else the first)', () => {
    const a = sampleProfile({ id: OTHER_ID, name: 'A', isDefault: false, builtin: false });
    const store = createProfileStore([
      a,
      STANDARD_PROFILE,
      { ...STANDARD_PROFILE, id: 'pf_ffffffffffffffffffffffffffffffff' },
    ]);
    expect(store.getDefault()).toBe(STANDARD_PROFILE);
    expect(
      store
        .summaries()
        .filter((s) => s.isDefault)
        .map((s) => s.id),
    ).toEqual([STANDARD_PROFILE_ID]);
    expect(createProfileStore([a]).getDefault()).toBe(a);
  });

  it('needs at least one profile', () => {
    expect(() => createProfileStore([])).toThrow();
  });
});
