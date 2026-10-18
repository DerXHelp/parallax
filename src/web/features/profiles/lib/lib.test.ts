import { describe, expect, it } from 'vitest';
import { makeError } from '@shared/errors';
import type { ProfileIssue } from '@shared/model';
import { sampleId, sampleProfile } from '@shared/samples';
import { demoProfileIssues } from './demo-host';
import {
  CONTEXT_WINDOW_MAX,
  CONTEXT_WINDOW_MIN,
  PROFILE_NAME_MAX,
  buildInput,
  configDirChanged,
  draftFromProfile,
  draftKey,
  isBypassArg,
  newDraft,
  parseContextWindow,
  placeIssues,
  problemsFor,
  type ProfileDraft,
} from './draft';
import { isSecretEnvKey } from './secrets';

const WORK = sampleId('pf', 2);

function draft(patch: Partial<ProfileDraft> = {}): ProfileDraft {
  return { ...newDraft([]), name: 'Work', ...patch };
}

describe('isSecretEnvKey (same rule as the server)', () => {
  it.each([
    ['ANTHROPIC_API_KEY', true],
    ['github_token', true],
    ['CLIENT_SECRET', true],
    ['DB_PASSWORD_FILE', true],
    ['MyPassword', true],
    ['KEYCHAIN', false],
    ['TOKENS', false],
    ['HTTPS_PROXY', false],
    ['ANTHROPIC_BASE_URL', false],
  ])('%s → %s', (name, secret) => {
    expect(isSecretEnvKey(name)).toBe(secret);
  });
});

describe('draft ↔ ProfileInput', () => {
  it('round-trips a saved profile and drops empty rows', () => {
    const profile = sampleProfile({
      id: WORK,
      name: 'Work',
      color: 'blue',
      executable: { kind: 'path', path: 'C:\\bin\\claude.exe' },
      configDir: 'C:\\Users\\me\\.claude-work',
      env: { API_TOKEN: 'secret', HTTPS_PROXY: 'http://proxy' },
      args: ['--add-dir', 'D:\\shared'],
      passRawArgs: true,
      contextWindow: 400_000,
      defaults: { model: 'opus', permissionMode: 'plan', effort: 'high' },
    });
    const value = draftFromProfile(profile);
    value.env.push({ id: 'x', key: '', value: '' });
    value.args.push({ id: 'y', value: '' });
    const built = buildInput(value, WORK, { allowsBypass: false });
    expect(built.problems).toEqual([]);
    expect(built.input).toEqual({
      id: WORK,
      name: 'Work',
      color: 'blue',
      executable: { kind: 'path', path: 'C:\\bin\\claude.exe' },
      configDir: 'C:\\Users\\me\\.claude-work',
      env: { API_TOKEN: 'secret', HTTPS_PROXY: 'http://proxy' },
      contextWindow: 400_000,
      args: ['--add-dir', 'D:\\shared'],
      passRawArgs: true,
      defaults: { model: 'opus', permissionMode: 'plan', effort: 'high' },
    });
    expect(built.argRowIds).toEqual(value.args.slice(0, 2).map((row) => row.id));
    // Empty rows are no change.
    expect(draftKey(value)).toBe(draftKey(draftFromProfile(profile)));
  });

  it('a new profile has no id and the first unused color', () => {
    const fresh = newDraft([{ color: 'slate' }, { color: 'blue' }]);
    expect(fresh.color).toBe('green');
    const built = buildInput({ ...fresh, name: 'New' }, null, { allowsBypass: false });
    expect(built.input).not.toBeNull();
    expect(built.input !== null && 'id' in built.input).toBe(false);
    expect(built.input?.configDir).toBeNull();
  });

  it('reports the problems it can see before the server', () => {
    const fields = (value: ProfileDraft, allowsBypass = false) =>
      buildInput(value, null, { allowsBypass }).problems.map((problem) => [problem.field, problem.key]);
    expect(fields(draft({ name: '  ' }))).toEqual([['name', 'profiles.problems.nameRequired']]);
    expect(fields(draft({ executableKind: 'path', executablePath: ' ' }))).toEqual([
      ['executable', 'profiles.problems.executableRequired'],
    ]);
    expect(fields(draft({ contextWindow: '99999' }))).toEqual([['contextWindow', 'profiles.problems.contextWindow']]);
    expect(fields(draft({ contextWindow: 'abc' }))).toEqual([['contextWindow', 'profiles.problems.contextWindow']]);
    expect(fields(draft({ model: '-x' }))).toEqual([['model', 'profiles.problems.model']]);
    expect(fields(draft({ permissionMode: 'bypassPermissions' }))).toEqual([
      ['permissionMode', 'profiles.problems.bypassNotAllowed'],
    ]);
    expect(fields(draft({ permissionMode: 'bypassPermissions' }), true)).toEqual([]);
    const env = draft({
      env: [
        { id: 'a', key: 'PATH', value: 'x' },
        { id: 'b', key: 'Path', value: 'y' },
        { id: 'c', key: '', value: 'orphan' },
        { id: 'd', key: 'A=B', value: '1' },
      ],
    });
    const problems = buildInput(env, null, { allowsBypass: false }).problems;
    expect(problemsFor(problems, { envRow: 'b' })[0]?.key).toBe('profiles.problems.envKeyDuplicate');
    expect(problemsFor(problems, { envRow: 'c' })[0]?.key).toBe('profiles.problems.envKeyRequired');
    expect(problemsFor(problems, { envRow: 'd' })[0]?.key).toBe('profiles.problems.envKeyInvalid');
    expect(problemsFor(problems, { envRow: 'a' })).toEqual([]);
  });

  it('reads its limits from the contract', () => {
    expect([CONTEXT_WINDOW_MIN, CONTEXT_WINDOW_MAX, PROFILE_NAME_MAX]).toEqual([100_000, 1_000_000, 60]);
    expect(buildInput(draft({ name: 'x'.repeat(61) }), null, { allowsBypass: false }).problems[0]?.key).toBe(
      'profiles.problems.tooLong',
    );
    expect(buildInput(draft({ contextWindow: '100000' }), null, { allowsBypass: false }).problems).toEqual([]);
    expect(buildInput(draft({ contextWindow: '1000001' }), null, { allowsBypass: false }).problems).toHaveLength(1);
  });

  it('parses context windows with thousands separators', () => {
    expect(parseContextWindow('200000')).toBe(200_000);
    expect(parseContextWindow('1.000.000')).toBe(1_000_000);
    expect(parseContextWindow("400 000")).toBe(400_000);
    expect(parseContextWindow('1e6')).toBeNull();
    expect(buildInput(draft({ contextWindow: '1,000,000' }), null, { allowsBypass: false }).input?.contextWindow).toBe(
      1_000_000,
    );
  });

  it('notices config folder changes like Windows (case-insensitive)', () => {
    expect(configDirChanged('C:\\Users\\me\\.claude', 'c:\\users\\ME\\.claude\\')).toBe(false);
    expect(configDirChanged('C:\\Users\\me\\.claude', 'C:\\Users\\me\\.claude-work')).toBe(true);
    expect(configDirChanged(null, '')).toBe(false);
    expect(configDirChanged(null, 'C:\\x')).toBe(true);
  });

  it('marks bypass flags', () => {
    expect(isBypassArg('--dangerously-skip-permissions')).toBe(true);
    expect(isBypassArg(' --allow-dangerously-skip-permissions ')).toBe(true);
    expect(isBypassArg('--dangerously')).toBe(false);
  });
});

describe('placeIssues', () => {
  it('puts argument findings on the row they were computed for, env findings on the variable', () => {
    const issues: ProfileIssue[] = [
      { level: 'error', issue: makeError('PROFILE_ARG_BLOCKED', { index: 1, flag: '--resume' }) },
      { level: 'error', issue: makeError('PROFILE_INVALID', { field: 'executable', reason: 'not_exe' }) },
      { level: 'warning', issue: makeError('PROFILE_ENV_REF_UNRESOLVED', { name: 'X', key: 'API_TOKEN' }) },
      { level: 'error', issue: makeError('PROFILE_INVALID', { count: 3 }) },
      { level: 'error', issue: makeError('PROFILE_ARG_NOT_ALLOWED', { index: 7, flag: '--gone' }) },
    ];
    const placed = placeIssues(issues, ['r1', 'r2'], [{ id: 'e1', key: 'API_TOKEN', value: '${env:X}' }]);
    expect(placed.args.get('r2')?.map((finding) => finding.issue.code)).toEqual(['PROFILE_ARG_BLOCKED']);
    expect(placed.args.has('r1')).toBe(false);
    expect(placed.executable).toHaveLength(1);
    expect(placed.env.get('e1')).toHaveLength(1);
    expect(placed.general.map((finding) => finding.issue.code)).toEqual(['PROFILE_INVALID', 'PROFILE_ARG_NOT_ALLOWED']);
  });
});

describe('demo profile check (playground/tests stand-in)', () => {
  it('imitates the server shapes', () => {
    const issues = demoProfileIssues({
      executable: { kind: 'auto' },
      configDir: null,
      env: { TOKEN_X_KEY: '${env:NOPE}' },
      args: ['--dangerously-skip-permissions', '--verbose', '--resume', 'x', '--add-dir'],
      passRawArgs: true,
    });
    expect(issues.map((finding) => [finding.level, finding.issue.code, finding.issue.params.index ?? null])).toEqual([
      ['error', 'PROFILE_ARG_BLOCKED', 2],
      ['error', 'PROFILE_ARG_INVALID', 4],
      ['warning', 'PROFILE_BYPASS_ENABLED', 0],
      ['warning', 'PROFILE_ENV_REF_UNRESOLVED', null],
      ['info', 'PROFILE_ARG_PASSED_RAW', 1],
    ]);
  });
});
