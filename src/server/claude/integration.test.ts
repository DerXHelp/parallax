import { mkdtemp } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { STANDARD_PROFILE_ID } from '@shared/common';
import { claudeInstallStatusSchema, type Profile } from '@shared/model';
import { SAMPLE_IDS, sampleClaudeInstallStatus, sampleProfile, sampleProfileInput } from '@shared/samples';
import { REDACTED, logger, redactText } from '../lib/logger';
import type { RunFileOptions, RunFileResult } from '../lib/process';
import { createStoreWarnings } from '../store/jsonStore';
import { CommandError } from '../sync/ports';
import { createClaudeIntegration, profileNeedsSetup } from './integration';
import type { ConsoleLaunchRequest } from './ports';
import { openProfileStore, type PersistentProfileStore } from './profileStore';
import { createProfileStore } from './profiles';
import { createMemoryFs } from '../lib/windows';

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
    profiles?: PersistentProfileStore;
    sdkClaudeCodeVersion?: string | null;
    resolveCacheMs?: number;
    persistentEnv?: () => Promise<ReadonlyMap<string, string> | null>;
    baseEnv?: Record<string, string>;
  } = {},
) {
  const calls: Call[] = [];
  const fs = createMemoryFs(options.files ?? { [LOCAL]: '' });
  const integration = createClaudeIntegration({
    appVersion: '1.2.3',
    baseEnv: () => options.baseEnv ?? BASE_ENV,
    persistentEnv: options.persistentEnv ?? (() => Promise.resolve(null)),
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
    ...(options.profiles === undefined ? {} : { profiles: options.profiles }),
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

  it('keeps persistent machine variables (Nexus, ADR-021), reads the source once, never session markers', async () => {
    let reads = 0;
    const { integration, calls } = setup({
      persistentEnv: () => {
        reads += 1;
        return Promise.resolve(
          new Map([
            ['NPM_LIFECYCLE_EVENT', 'preflight'],
            ['CLAUDECODE', '1'],
          ]),
        );
      },
    });
    const spec = await integration.launchSpecFor(STANDARD_PROFILE_ID, SAMPLE_IDS.entry);
    await integration.checkProfile(STANDARD_PROFILE_ID);
    await integration.launchSpecFor(STANDARD_PROFILE_ID, SAMPLE_IDS.entry);
    expect(reads).toBe(1);
    // run state and session markers stay removed although "persistent" with the same value
    expect(spec.env.npm_lifecycle_event).toBeUndefined();
    expect(spec.env.CLAUDECODE).toBeUndefined();
    expect(calls.every((call) => call.options.env?.CLAUDECODE === undefined)).toBe(true);
  });

  it('passes a persistent NPM_CONFIG_REGISTRY on and survives a failing source', async () => {
    const nexus = 'https://nexus.corp/npm/';
    const ok = setup({ persistentEnv: () => Promise.resolve(new Map([['NPM_LIFECYCLE_EVENT', 'x']])) });
    expect(
      (await ok.integration.launchSpecFor(STANDARD_PROFILE_ID, SAMPLE_IDS.entry)).env,
    ).not.toHaveProperty('npm_lifecycle_event');
    const failing = setup({ persistentEnv: () => Promise.reject(new Error('reg.exe missing')) });
    const spec = await failing.integration.launchSpecFor(STANDARD_PROFILE_ID, SAMPLE_IDS.entry);
    expect(spec.executablePath).toBe(LOCAL);
    const integration = createClaudeIntegration({
      appVersion: '1.2.3',
      baseEnv: () => ({ ...BASE_ENV, NPM_CONFIG_REGISTRY: nexus }),
      persistentEnv: () => Promise.resolve(new Map([['NPM_CONFIG_REGISTRY', nexus]])),
      fs: createMemoryFs({ [LOCAL]: '' }),
      where: () => Promise.resolve([LOCAL]),
      runFile: () => Promise.resolve(result('2.1.300 (Claude Code)\n')),
      sdkClaudeCodeVersion: '2.1.296',
    });
    expect(
      (await integration.launchSpecFor(STANDARD_PROFILE_ID, SAMPLE_IDS.entry)).env.NPM_CONFIG_REGISTRY,
    ).toBe(nexus);
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
    // ADR-102: every error issue of the profile check blocks the start.
    ['unsafe config dir', { configDir: '\\\\server\\share' }, 'PROFILE_INVALID', { count: 1 }],
    [
      'executable that is not an .exe',
      { executable: { kind: 'path', path: 'C:\\Tools\\claude.cmd' } },
      'PROFILE_INVALID',
      { count: 1 },
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

describe('consoleLaunchFor (Phase 2, ADR-104)', () => {
  const request = (p: Partial<ConsoleLaunchRequest> = {}): ConsoleLaunchRequest => ({
    profileId: STANDARD_PROFILE_ID,
    entryId: SAMPLE_IDS.entry,
    cwd: 'D:\\Work\\Repo ü',
    resumeSessionId: SAMPLE_IDS.sessionId,
    model: null,
    permissionMode: null,
    ...p,
  });
  /** A Claude Code tool shell: session markers plus the tool-shell settings of R1-03. */
  const TOOL_SHELL_ENV = { ...BASE_ENV, GIT_EDITOR: 'true', NO_COLOR: '1', SECRET_HOME: 'machine-only' };

  it('builds the console spec: profile args + --resume (+ model/mode/settings), terminal env, exact cwd', async () => {
    const profile = sampleProfile({
      configDir: 'D:\\claude\\work',
      contextWindow: 200_000,
      args: ['--add-dir', 'D:\\shared', '--verbose'],
      passRawArgs: true,
      env: { ANTHROPIC_BASE_URL: 'https://gateway.corp', HOME_COPY: '${env:SECRET_HOME}' },
    });
    const { integration } = setup({ profileList: [profile], baseEnv: TOOL_SHELL_ENV });
    const spec = await integration.consoleLaunchFor(
      request({ model: 'haiku', permissionMode: 'acceptEdits' }),
    );
    expect(spec.executablePath).toBe(LOCAL);
    expect(spec.cwd).toBe('D:\\Work\\Repo ü');
    expect(spec.args).toEqual([
      '--add-dir',
      'D:\\shared',
      '--verbose',
      '--resume',
      SAMPLE_IDS.sessionId,
      '--model',
      'haiku',
      '--permission-mode',
      'acceptEdits',
      '--settings',
      '{"autoCompactWindow":200000}',
    ]);
    expect(spec.explicitEnv).toEqual({
      ANTHROPIC_BASE_URL: 'https://gateway.corp',
      HOME_COPY: 'machine-only',
      CLAUDE_CONFIG_DIR: 'D:\\claude\\work',
    });
    expect(spec.env).toMatchObject({
      ...spec.explicitEnv,
      PARALLAX: '1',
      PARALLAX_ENTRY_ID: SAMPLE_IDS.entry,
      Path: 'C:\\Users\\u\\.local\\bin',
    });
    for (const marker of [
      'CLAUDECODE',
      'CLAUDE_CODE_SESSION_ID',
      'CLAUDE_CODE_MESSAGING_TOKEN',
      'GIT_EDITOR',
      'NO_COLOR',
    ]) {
      expect(spec.env).not.toHaveProperty(marker);
    }
    expect(spec.env.npm_lifecycle_event).toBeUndefined();
  });

  it('does not add --model, --permission-mode or --settings the profile args already set', async () => {
    const warn = vi.spyOn(logger, 'warn');
    const profile = sampleProfile({
      contextWindow: 300_000,
      args: ['--model=opus', '--permission-mode', 'plan', '--settings', 'D:\\s.json'],
    });
    const { integration } = setup({ profileList: [profile] });
    const spec = await integration.consoleLaunchFor(
      request({ model: 'haiku', permissionMode: 'acceptEdits' }),
    );
    expect(spec.args).toEqual([
      '--model=opus',
      '--permission-mode',
      'plan',
      '--settings',
      'D:\\s.json',
      '--resume',
      SAMPLE_IDS.sessionId,
    ]);
    expect(spec.explicitEnv).toEqual({});
    expect(warn).toHaveBeenCalledWith(
      { profileId: STANDARD_PROFILE_ID },
      expect.stringContaining('autoCompactWindow'),
    );
  });

  it('registers secret values of the explicit env with the logger', async () => {
    const secret = 'console-secret-value-77';
    const { integration } = setup({
      profileList: [sampleProfile({ env: { GATEWAY_TOKEN: '${env:GW}' } })],
      baseEnv: { ...BASE_ENV, GW: secret },
    });
    const spec = await integration.consoleLaunchFor(request());
    expect(spec.explicitEnv).toEqual({ GATEWAY_TOKEN: secret });
    expect(redactText(`token ${secret}`)).toBe(`token ${REDACTED}`);
  });

  it.each<[string, 'launch' | 'check']>([
    ['launchSpecFor', 'launch'],
    ['checkProfile', 'check'],
  ])(
    'R4-07 (ADR-124): %s registers the resolved secret values of the profile (not only the console)',
    async (_name, call) => {
      const secret = `resolved-${call}-secret-4711`;
      const plain = `resolved-${call}-plain-value`;
      const profile = sampleProfile({
        env: { AWS_BEARER_TOKEN_BEDROCK: '${env:BEDROCK}', NOTE: '${env:PLAIN_NOTE}' },
      });
      const { integration } = setup({
        profileList: [profile],
        baseEnv: { ...BASE_ENV, BEDROCK: secret, PLAIN_NOTE: plain },
      });
      expect(redactText(`x ${secret}`)).toBe(`x ${secret}`);
      if (call === 'launch') await integration.launchSpecFor(profile.id, SAMPLE_IDS.entry);
      else await integration.checkProfile(profile.id);
      expect(redactText(`x ${secret}`)).toBe(`x ${REDACTED}`);
      expect(redactText(`x ${plain}`)).toBe(`x ${plain}`);
    },
  );

  it.each<[string, Partial<Profile>, Partial<ConsoleLaunchRequest>, string, Record<string, unknown>]>([
    ['error issues', { args: ['--print'] }, {}, 'PROFILE_INVALID', { count: 1 }],
    [
      'unresolved env reference',
      { env: { K: '${env:NOT_SET_ANYWHERE}' } },
      {},
      'PROFILE_ENV_REF_UNRESOLVED',
      { name: 'NOT_SET_ANYWHERE', key: 'K' },
    ],
    ['unsafe cwd', {}, { cwd: '\\\\server\\share\\repo' }, 'PATH_REJECTED', { reason: 'unc', field: 'cwd' }],
    [
      'unknown profile',
      {},
      { profileId: 'pf_0123456789abcdef0123456789abcdef' },
      'PROFILE_NOT_FOUND',
      { profileId: 'pf_0123456789abcdef0123456789abcdef' },
    ],
  ])('throws for %s', async (_name, partial, req, code, params) => {
    const { integration, calls } = setup({ profileList: [sampleProfile(partial)] });
    const error = await commandError(integration.consoleLaunchFor(request(req)));
    expect(error.error).toEqual({ code, params });
    expect(calls).toEqual([]);
  });

  it('throws CLAUDE_NOT_FOUND like launchSpecFor', async () => {
    const { integration } = setup({ files: {}, hits: [] });
    expect((await commandError(integration.consoleLaunchFor(request()))).error.code).toBe('CLAUDE_NOT_FOUND');
  });
});

describe('with a persistent profile store (ADR-102)', () => {
  const OTHER = 'C:\\Tools\\claude-next\\claude.exe';

  async function persistent(): Promise<PersistentProfileStore> {
    return openProfileStore({
      home: await mkdtemp(path.join(process.env.PARALLAX_HOME ?? os.tmpdir(), 'wp32-integration-')),
      warnings: createStoreWarnings(),
      debounceMs: 5,
      issueContext: () => ({ env: {}, persistentEnv: new Map(), exists: () => true }),
    });
  }

  it('uses the store, keeps the cache for unrelated changes and drops it when the executable changes', async () => {
    const store = await persistent();
    const { integration, calls } = setup({ profiles: store, files: { [LOCAL]: '', [OTHER]: '' } });
    const versionCalls = () => calls.filter((call) => call.args[0] === '--version').map((call) => call.file);
    const id = store.save(sampleProfileInput({ env: {}, configDir: null, args: [] }), new Date()).id;
    expect(integration.profiles).toBe(store);

    await integration.launchSpecFor(id, SAMPLE_IDS.entry);
    store.save(sampleProfileInput({ id, name: 'Renamed', env: {}, configDir: null, args: [] }), new Date());
    await integration.launchSpecFor(id, SAMPLE_IDS.entry);
    expect(versionCalls()).toEqual([LOCAL]);

    store.save(
      sampleProfileInput({
        id,
        executable: { kind: 'path', path: OTHER },
        env: {},
        configDir: null,
        args: [],
      }),
      new Date(),
    );
    const spec = await integration.launchSpecFor(id, SAMPLE_IDS.entry);
    expect(spec.executablePath).toBe(OTHER);
    expect(versionCalls()).toEqual([LOCAL, OTHER]);
    await store.close();
  });

  it('checkProfile stores the status in the persistent store (onChange)', async () => {
    const store = await persistent();
    const { integration } = setup({ profiles: store });
    let changes = 0;
    store.onChange(() => {
      changes += 1;
    });
    const status = await integration.checkProfile(STANDARD_PROFILE_ID);
    expect(store.claudeStatus(STANDARD_PROFILE_ID)).toEqual(status);
    expect(changes).toBe(1);
    await store.close();
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
