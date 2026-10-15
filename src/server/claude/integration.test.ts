import { afterEach, describe, expect, it, vi } from 'vitest';
import { STANDARD_PROFILE_ID } from '@shared/common';
import { claudeInstallStatusSchema, type Profile } from '@shared/model';
import { SAMPLE_IDS, sampleClaudeInstallStatus, sampleProfile } from '@shared/samples';
import { logger } from '../lib/logger';
import type { RunFileOptions, RunFileResult } from '../lib/process';
import { CommandError } from '../sync/ports';
import { createClaudeIntegration, profileNeedsSetup } from './integration';
import { createProfileStore } from './profiles';
import { createMemoryFs } from './resolveClaude';

const LOCAL = 'C:\\Users\\u\\.local\\bin\\claude.exe';
const EMAIL = 'someone@example.com';
const AUTH_OK = JSON.stringify({
  loggedIn: true,
  authMethod: 'claude.ai',
  apiProvider: 'firstParty',
  email: EMAIL,
  orgName: 'Example Org',
  orgId: 'org-123',
  subscriptionType: 'max',
});

/** The env of a dev shell inside Claude Code (session variables that must not leak). */
const BASE_ENV = {
  Path: 'C:\\Users\\u\\.local\\bin;D:\\repo\\node_modules\\.bin',
  USERPROFILE: 'C:\\Users\\u',
  CLAUDECODE: '1',
  CLAUDE_CODE_SESSION_ID: 'outer-session',
  CLAUDE_CODE_MESSAGING_TOKEN: 'secret',
  npm_lifecycle_event: 'preflight',
};

interface Call {
  file: string;
  args: readonly string[];
  options: RunFileOptions;
}

function result(stdout: string, exitCode: number | null = 0): RunFileResult {
  return { exitCode, signal: null, stdout, stderr: '', timedOut: false };
}

function setup(
  options: {
    files?: Record<string, string>;
    hits?: string[];
    version?: () => Promise<RunFileResult>;
    auth?: () => Promise<RunFileResult>;
    profileList?: Profile[];
    sdkClaudeCodeVersion?: string | null;
    resolveCacheMs?: number;
  } = {},
) {
  const calls: Call[] = [];
  const fs = createMemoryFs(options.files ?? { [LOCAL]: '' });
  const integration = createClaudeIntegration({
    appVersion: '1.2.3',
    baseEnv: () => BASE_ENV,
    fs,
    where: (name, env) => {
      expect(name).toBe('claude');
      expect(env.CLAUDECODE).toBeUndefined();
      return Promise.resolve(options.hits ?? [LOCAL]);
    },
    runFile: (file, args, runOptions) => {
      calls.push({ file, args, options: runOptions });
      if (args[0] === '--version')
        return options.version?.() ?? Promise.resolve(result('2.1.300 (Claude Code)\n'));
      if (args.join(' ') === 'auth status --json')
        return options.auth?.() ?? Promise.resolve(result(AUTH_OK));
      throw new Error(`unexpected command ${args.join(' ')}`);
    },
    sdkClaudeCodeVersion:
      options.sdkClaudeCodeVersion === undefined ? '2.1.296' : options.sdkClaudeCodeVersion,
    now: () => new Date('2026-10-15T08:00:00.000Z'),
    ...(options.profileList === undefined ? {} : { profiles: createProfileStore(options.profileList) }),
    ...(options.resolveCacheMs === undefined ? {} : { resolveCacheMs: options.resolveCacheMs }),
  });
  return { integration, calls, fs };
}

async function commandError(promise: Promise<unknown>): Promise<CommandError> {
  try {
    await promise;
  } catch (error) {
    if (error instanceof CommandError) return error;
    throw error;
  }
  throw new Error('expected a CommandError');
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe('launchSpecFor', () => {
  it('builds the spec for "Standard": resolved .exe, cleaned env, no extras', async () => {
    const { integration, calls } = setup();
    const spec = await integration.launchSpecFor(STANDARD_PROFILE_ID, SAMPLE_IDS.entry);
    expect(spec).toEqual({
      profileId: STANDARD_PROFILE_ID,
      executablePath: LOCAL,
      executableVersion: '2.1.300',
      env: {
        Path: 'C:\\Users\\u\\.local\\bin',
        USERPROFILE: 'C:\\Users\\u',
        PARALLAX: '1',
        PARALLAX_ENTRY_ID: SAMPLE_IDS.entry,
        CLAUDE_CODE_EMIT_SESSION_STATE_EVENTS: '1',
        CLAUDE_AGENT_SDK_CLIENT_APP: 'parallax/1.2.3',
      },
      configDir: null,
      sdkOptions: {},
      extraArgs: {},
      allowDangerouslySkipPermissions: false,
      autoCompactWindow: null,
      contextWindow: null,
    });
    expect(calls.map((call) => call.args)).toEqual([['--version']]);
    expect(calls[0]?.options.env).toEqual(spec.env);
  });

  it('maps profile args, config dir and context window', async () => {
    const profile = sampleProfile({
      configDir: 'D:\\claude\\work',
      contextWindow: 200_000,
      args: ['--model', 'haiku', '--add-dir', 'D:\\shared', '--dangerously-skip-permissions', '--verbose'],
      passRawArgs: true,
      env: { ANTHROPIC_BASE_URL: 'https://gateway.corp', HOME_COPY: '${env:USERPROFILE}' },
    });
    const { integration } = setup({ profileList: [profile] });
    const spec = await integration.launchSpecFor(STANDARD_PROFILE_ID, SAMPLE_IDS.entry);
    expect(spec).toMatchObject({
      configDir: 'D:\\claude\\work',
      sdkOptions: { model: 'haiku', additionalDirectories: ['D:\\shared'] },
      extraArgs: { verbose: null },
      allowDangerouslySkipPermissions: true,
      autoCompactWindow: 200_000,
      contextWindow: 200_000,
    });
    expect(spec.env).toMatchObject({
      CLAUDE_CONFIG_DIR: 'D:\\claude\\work',
      ANTHROPIC_BASE_URL: 'https://gateway.corp',
      HOME_COPY: 'C:\\Users\\u',
    });
  });

  it.each<[string, Partial<Profile>, string, Record<string, unknown>]>([
    ['invalid args', { args: ['--resume', 'x', 'stray'] }, 'PROFILE_INVALID', { count: 2 }],
    [
      'unresolved env reference',
      { env: { K: '${env:NOT_SET_ANYWHERE}' } },
      'PROFILE_ENV_REF_UNRESOLVED',
      { name: 'NOT_SET_ANYWHERE', key: 'K' },
    ],
    [
      'unsafe config dir',
      { configDir: '\\\\server\\share' },
      'PATH_REJECTED',
      { reason: 'unc', field: 'configDir' },
    ],
  ])('throws for %s', async (_name, partial, code, params) => {
    const { integration, calls } = setup({ profileList: [sampleProfile(partial)] });
    const error = await commandError(integration.launchSpecFor(STANDARD_PROFILE_ID, SAMPLE_IDS.entry));
    expect(error.error).toEqual({ code, params });
    expect(calls).toEqual([]);
  });

  it('throws PROFILE_NOT_FOUND and CLAUDE_NOT_FOUND', async () => {
    const { integration } = setup({ files: {}, hits: [] });
    expect(
      (await commandError(integration.launchSpecFor('pf_0123456789abcdef0123456789abcdef', SAMPLE_IDS.entry)))
        .error,
    ).toEqual({
      code: 'PROFILE_NOT_FOUND',
      params: { profileId: 'pf_0123456789abcdef0123456789abcdef' },
    });
    expect(
      (await commandError(integration.launchSpecFor(STANDARD_PROFILE_ID, SAMPLE_IDS.entry))).error,
    ).toEqual({
      code: 'CLAUDE_NOT_FOUND',
      params: { source: 'path', candidates: 0 },
    });
  });

  it('still launches when --version fails (version unknown)', async () => {
    const { integration } = setup({ version: () => Promise.resolve(result('', 1)) });
    const spec = await integration.launchSpecFor(STANDARD_PROFILE_ID, SAMPLE_IDS.entry);
    expect(spec.executableVersion).toBeNull();
  });

  it('caches the resolution, re-checks the path and dedupes parallel calls', async () => {
    const { integration, calls, fs } = setup();
    await Promise.all([
      integration.launchSpecFor(STANDARD_PROFILE_ID, SAMPLE_IDS.entry),
      integration.launchSpecFor(STANDARD_PROFILE_ID, SAMPLE_IDS.entry),
    ]);
    await integration.launchSpecFor(STANDARD_PROFILE_ID, SAMPLE_IDS.entry);
    expect(calls).toHaveLength(1);
    expect(fs.touched.filter((p) => p === LOCAL).length).toBeGreaterThan(1);
  });

  it('resolves again after the cache time', async () => {
    const { integration, calls } = setup({ resolveCacheMs: 0 });
    await integration.launchSpecFor(STANDARD_PROFILE_ID, SAMPLE_IDS.entry);
    await integration.launchSpecFor(STANDARD_PROFILE_ID, SAMPLE_IDS.entry);
    expect(calls).toHaveLength(2);
  });
});

describe('checkProfile ("Profil testen")', () => {
  it('runs exactly `--version` and `auth status --json` with buildEnv and stores the status', async () => {
    const { integration, calls } = setup();
    const status = await integration.checkProfile(STANDARD_PROFILE_ID);
    expect(status).toEqual(sampleClaudeInstallStatus({ path: LOCAL }));
    expect(claudeInstallStatusSchema.parse(status)).toEqual(status);
    expect(calls.map((call) => [call.file, ...call.args])).toEqual([
      [LOCAL, '--version'],
      [LOCAL, 'auth', 'status', '--json'],
    ]);
    for (const call of calls) {
      expect(call.options.env?.CLAUDECODE).toBeUndefined();
      expect(call.options.env?.CLAUDE_CODE_SESSION_ID).toBeUndefined();
      expect(call.options.env?.PARALLAX).toBe('1');
      expect(call.options.env?.PARALLAX_ENTRY_ID).toBeUndefined();
    }
    expect(integration.profiles.summaries()[0]?.claude).toEqual(status);
    expect(profileNeedsSetup(status)).toBe(false);
  });

  it('never logs or returns e-mail/org', async () => {
    const debug = vi.spyOn(logger, 'debug');
    const { integration } = setup();
    const status = await integration.checkProfile(STANDARD_PROFILE_ID);
    const text = JSON.stringify([status, debug.mock.calls, integration.profiles.summaries()]);
    expect(text).not.toContain(EMAIL);
    expect(text).not.toContain('Example Org');
    expect(text).not.toContain('org-123');
  });

  it.each<[string, Parameters<typeof setup>[0], Partial<ReturnType<typeof sampleClaudeInstallStatus>>]>([
    [
      'CLI older than the SDK expects (C.7)',
      { sdkClaudeCodeVersion: '2.1.400' },
      {
        versionStatus: 'too_old',
        error: { code: 'CLAUDE_VERSION_TOO_OLD', params: { version: '2.1.300', required: '2.1.400' } },
      },
    ],
    ['unknown SDK requirement', { sdkClaudeCodeVersion: null }, { versionStatus: 'unknown' }],
    [
      'logged out',
      {
        auth: () =>
          Promise.resolve(result('{"loggedIn":false,"authMethod":"none","apiProvider":"firstParty"}', 1)),
      },
      {
        auth: { state: 'logged_out', method: 'none', apiProvider: 'firstParty', subscriptionType: null },
        error: { code: 'CLAUDE_NOT_LOGGED_IN', params: {} },
      },
    ],
    [
      'unparsable auth status',
      { auth: () => Promise.resolve(result('error: something', 2)) },
      {
        auth: { state: 'error', method: null, apiProvider: null, subscriptionType: null },
        error: { code: 'CLAUDE_AUTH_FAILED', params: { reason: 'unparsable', exitCode: 2 } },
      },
    ],
    [
      'auth status timeout',
      { auth: () => Promise.resolve({ ...result(''), timedOut: true, exitCode: null }) },
      {
        auth: { state: 'error', method: null, apiProvider: null, subscriptionType: null },
        error: { code: 'CLAUDE_AUTH_FAILED', params: { reason: 'timeout' } },
      },
    ],
  ])('%s', async (_name, options, expected) => {
    const { integration } = setup(options);
    const status = await integration.checkProfile(STANDARD_PROFILE_ID);
    expect(status).toEqual(sampleClaudeInstallStatus({ path: LOCAL, ...expected }));
  });

  it('reports a broken executable as error without asking auth', async () => {
    const { integration, calls } = setup({
      version: () => Promise.reject(Object.assign(new Error('x'), { code: 'EACCES' })),
    });
    const status = await integration.checkProfile(STANDARD_PROFILE_ID);
    expect(status).toMatchObject({
      state: 'error',
      path: LOCAL,
      version: null,
      error: { code: 'CLAUDE_SPAWN_FAILED', params: { reason: 'EACCES' } },
    });
    expect(calls).toHaveLength(1);
    expect(profileNeedsSetup(status)).toBe(true);
  });

  it('reports not_found', async () => {
    const { integration, calls } = setup({ files: {}, hits: [] });
    const status = await integration.checkProfile(STANDARD_PROFILE_ID);
    expect(status).toEqual({
      state: 'not_found',
      path: null,
      version: null,
      versionStatus: 'unknown',
      auth: { state: 'unknown', method: null, apiProvider: null, subscriptionType: null },
      error: { code: 'CLAUDE_NOT_FOUND', params: { source: 'path', candidates: 0 } },
      checkedAt: '2026-10-15T08:00:00.000Z',
    });
    expect(calls).toEqual([]);
  });

  it('reports env issues before touching claude', async () => {
    const { integration, calls } = setup({
      profileList: [sampleProfile({ env: { K: '${env:NOPE_NOPE}' } })],
    });
    const status = await integration.checkProfile(STANDARD_PROFILE_ID);
    expect(status.state).toBe('error');
    expect(status.error).toEqual({
      code: 'PROFILE_ENV_REF_UNRESOLVED',
      params: { name: 'NOPE_NOPE', key: 'K' },
    });
    expect(calls).toEqual([]);
  });

  it('throws PROFILE_NOT_FOUND for unknown profiles', async () => {
    const { integration } = setup();
    expect(
      (await commandError(integration.checkProfile('pf_0123456789abcdef0123456789abcdef'))).error.code,
    ).toBe('PROFILE_NOT_FOUND');
  });

  it('refreshes the launch cache', async () => {
    const { integration, calls } = setup();
    await integration.checkProfile(STANDARD_PROFILE_ID);
    await integration.launchSpecFor(STANDARD_PROFILE_ID, SAMPLE_IDS.entry);
    expect(calls.filter((call) => call.args[0] === '--version')).toHaveLength(1);
  });
});

describe('profileNeedsSetup', () => {
  it.each<[Partial<ReturnType<typeof sampleClaudeInstallStatus>>, boolean]>([
    [{}, false],
    [{ versionStatus: 'too_old' }, false],
    [{ state: 'not_found' }, true],
    [{ state: 'error' }, true],
    [{ state: 'checking' }, true],
    [{ auth: { state: 'logged_out', method: null, apiProvider: null, subscriptionType: null } }, true],
    [{ auth: { state: 'unknown', method: null, apiProvider: null, subscriptionType: null } }, true],
  ])('%j → %s', (partial, needsSetup) => {
    expect(profileNeedsSetup(sampleClaudeInstallStatus(partial))).toBe(needsSetup);
  });
});
