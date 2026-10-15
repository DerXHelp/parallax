import { describe, expect, it } from 'vitest';
import { SAMPLE_IDS } from '@shared/samples';
import { CommandError } from '../sync/ports';
import {
  CLAUDE_CODE_ENV_ALLOWLIST,
  buildEnv,
  buildEnvReport,
  clientAppId,
  deleteEnvVar,
  getEnvVar,
  resolveEnvRefs,
  setEnvVar,
  shouldRemoveEnvVar,
  stripNodeModulesBin,
  type BuildEnvInput,
} from './env';

const NO_PROFILE = { env: {}, configDir: null };

function input(base: BuildEnvInput['base'], partial: Partial<BuildEnvInput> = {}): BuildEnvInput {
  return {
    base,
    profile: NO_PROFILE,
    entryId: SAMPLE_IDS.entry,
    clientApp: 'parallax/1.2.3',
    delimiter: ';',
    ...partial,
  };
}

/** Variables the builder sets itself (they may match a removal rule). */
const BUILDER_VARS = new Set([
  'PARALLAX',
  'PARALLAX_ENTRY_ID',
  'CLAUDE_CODE_EMIT_SESSION_STATE_EVENTS',
  'CLAUDE_AGENT_SDK_CLIENT_APP',
  'CLAUDE_CONFIG_DIR',
]);

describe('shouldRemoveEnvVar (C.2, A.7)', () => {
  it.each([
    // the calling Claude session (A.7 list and what Claude Code 2.1.300 really sets)
    'CLAUDECODE',
    'claudecode',
    'CLAUDE_CODE_ENTRYPOINT',
    'CLAUDE_CODE_SESSION_ID',
    'CLAUDE_CODE_CHILD_SESSION',
    'CLAUDE_CODE_EXECPATH',
    'CLAUDE_CODE_SESSION_ATTENDED',
    'CLAUDE_CODE_SSE_PORT',
    'CLAUDE_CODE_MESSAGING_SOCKET',
    'CLAUDE_CODE_MESSAGING_TOKEN',
    'CLAUDE_CODE_BRIDGE_SESSION_ID',
    'CLAUDE_CODE_BRIDGE_ANYTHING',
    'Claude_Code_Session_Id',
    'CLAUDE_CODE_EMIT_SESSION_STATE_EVENTS',
    'CLAUDE_CODE_SOMETHING_NEW',
    'CLAUDE_PID',
    'CLAUDE_EFFORT',
    'CLAUDE_AGENT_SDK_VERSION',
    'CLAUDE_AGENT_SDK_CLIENT_APP',
    // pnpm/npm run state
    'npm_config_user_agent',
    'npm_execpath',
    'npm_node_execpath',
    'npm_command',
    'npm_lifecycle_event',
    'npm_package_name',
    'NPM_CONFIG_REGISTRY',
    'PNPM_HOME',
    'PNPM_PACKAGE_NAME',
    'pnpm_config_verify_deps_before_run',
    'INIT_CWD',
    'NODE_ENV',
    'node_env',
    'NODE_OPTIONS',
    // inherited Parallax variables (Parallax started from a Parallax session)
    'PARALLAX',
    'PARALLAX_ENTRY_ID',
    'parallax_entry_id',
  ])('removes %s', (name) => {
    expect(shouldRemoveEnvVar(name)).toBe(true);
  });

  it.each([
    ...CLAUDE_CODE_ENV_ALLOWLIST,
    'claude_code_git_bash_path',
    'CLAUDE_CONFIG_DIR',
    'CLAUDE_BASH_MAINTAIN_PROJECT_WORKING_DIR',
    'CLAUDECODE_X',
    'ANTHROPIC_API_KEY',
    'ANTHROPIC_BASE_URL',
    'NODE',
    'NODE_EXTRA_CA_CERTS',
    'NODE_TLS_REJECT_UNAUTHORIZED',
    'NPM',
    'PARALLAX_HOME',
    'PARALLAX_PORT',
    'PATH',
    'Path',
    'PATHEXT',
    'USERPROFILE',
    'SystemRoot',
    'GIT_EDITOR',
    'NoDefaultCurrentDirectoryInExePath',
    'HTTPS_PROXY',
  ])('keeps %s', (name) => {
    expect(shouldRemoveEnvVar(name)).toBe(false);
  });

  it('allowlists only machine-level CLAUDE_CODE_* variables', () => {
    expect(CLAUDE_CODE_ENV_ALLOWLIST).toEqual([
      'CLAUDE_CODE_GIT_BASH_PATH',
      'CLAUDE_CODE_USE_POWERSHELL_TOOL',
      'CLAUDE_CODE_USE_BEDROCK',
      'CLAUDE_CODE_USE_VERTEX',
      'CLAUDE_CODE_USE_FOUNDRY',
      'CLAUDE_CODE_SKIP_BEDROCK_AUTH',
      'CLAUDE_CODE_SKIP_VERTEX_AUTH',
      'CLAUDE_CODE_SKIP_FOUNDRY_AUTH',
      'CLAUDE_CODE_CLIENT_CERT',
      'CLAUDE_CODE_CLIENT_KEY',
      'CLAUDE_CODE_CLIENT_KEY_PASSPHRASE',
    ]);
  });
});

describe('stripNodeModulesBin', () => {
  it.each<[string, string, number]>([
    ['C:\\tools;D:\\repo\\node_modules\\.bin;C:\\Windows', 'C:\\tools;C:\\Windows', 1],
    ['D:\\repo\\node_modules\\.bin\\;C:\\x', 'C:\\x', 1],
    ['D:/repo/node_modules/.bin;C:\\x', 'C:\\x', 1],
    ['"D:\\repo\\node_modules\\.bin";C:\\x', 'C:\\x', 1],
    [' D:\\Repo\\NODE_MODULES\\.BIN ;C:\\x', 'C:\\x', 1],
    ['node_modules\\.bin;C:\\x', 'C:\\x', 1],
    [
      'D:\\a\\node_modules\\.bin;D:\\node_modules\\.bin;C:\\Program Files\\nodejs\\;C:\\x',
      'C:\\Program Files\\nodejs\\;C:\\x',
      2,
    ],
    [
      'D:\\repo\\node_modules\\.bin2;D:\\repo\\node_modules\\bin;D:\\x\\.bin',
      'D:\\repo\\node_modules\\.bin2;D:\\repo\\node_modules\\bin;D:\\x\\.bin',
      0,
    ],
    ['C:\\a;;C:\\b', 'C:\\a;;C:\\b', 0],
    ['', '', 0],
  ])('%s', (value, expected, removed) => {
    expect(stripNodeModulesBin(value, ';')).toEqual({ value: expected, removed });
  });
});

describe('resolveEnvRefs', () => {
  const machine: Record<string, string> = { USERPROFILE: 'C:\\Users\\u', Empty: '' };
  const lookup = (name: string): string | undefined => getEnvVar(machine, name);

  it.each<[string, string, string[]]>([
    ['plain', 'plain', []],
    ['${env:USERPROFILE}\\cfg', 'C:\\Users\\u\\cfg', []],
    ['${env:userprofile}', 'C:\\Users\\u', []],
    ['${env:USERPROFILE};${env:USERPROFILE}', 'C:\\Users\\u;C:\\Users\\u', []],
    ['a${env:Empty}b', 'ab', []],
    ['${env:MISSING}', '', ['MISSING']],
    ['${env:}', '', ['']],
    ['$env:USERPROFILE', '$env:USERPROFILE', []],
    ['${USERPROFILE}', '${USERPROFILE}', []],
  ])('%s', (value, expected, missing) => {
    expect(resolveEnvRefs(value, lookup)).toEqual({ value: expected, missing });
  });
});

describe('case-insensitive helpers', () => {
  it('get/set/delete treat Path and PATH as one variable', () => {
    const env: Record<string, string> = { Path: 'a', PATHEXT: '.EXE' };
    expect(getEnvVar(env, 'PATH')).toBe('a');
    setEnvVar(env, 'PATH', 'b');
    expect(env).toEqual({ PATH: 'b', PATHEXT: '.EXE' });
    deleteEnvVar(env, 'path');
    expect(env).toEqual({ PATHEXT: '.EXE' });
  });

  it('clientAppId uses the product id', () => {
    expect(clientAppId('0.0.0')).toBe('parallax/0.0.0');
  });
});

describe('buildEnvReport (C.2)', () => {
  /** What a dev shell inside Claude Code + `pnpm run` looks like (names as observed in WP-11). */
  const devShell: Record<string, string> = {
    Path: 'C:\\Users\\u\\.local\\bin;D:\\repo\\node_modules\\.bin;D:\\repo\\node_modules\\.bin;C:\\Program Files\\nodejs\\;C:\\Windows\\system32',
    PATHEXT: '.COM;.EXE;.BAT;.CMD',
    USERPROFILE: 'C:\\Users\\u',
    SystemRoot: 'C:\\Windows',
    CLAUDECODE: '1',
    CLAUDE_CODE_ENTRYPOINT: 'cli',
    CLAUDE_CODE_SESSION_ID: 'session-uuid',
    CLAUDE_CODE_CHILD_SESSION: '1',
    CLAUDE_CODE_SESSION_ATTENDED: '1',
    CLAUDE_CODE_MESSAGING_SOCKET: '\\\\.\\pipe\\claude',
    CLAUDE_CODE_MESSAGING_TOKEN: 'secret-token',
    CLAUDE_CODE_BRIDGE_SESSION_ID: 'bridge',
    CLAUDE_CODE_GIT_BASH_PATH: 'C:\\Git\\bin\\bash.exe',
    CLAUDE_CODE_USE_POWERSHELL_TOOL: '1',
    CLAUDE_PID: '4242',
    CLAUDE_EFFORT: 'high',
    CLAUDE_AGENT_SDK_VERSION: '0.3.296',
    CLAUDE_CONFIG_DIR: 'C:\\Users\\u\\.claude-work',
    GIT_EDITOR: 'true',
    INIT_CWD: 'D:\\repo',
    NODE: 'C:\\Program Files\\nodejs\\node.exe',
    NODE_ENV: 'development',
    NODE_OPTIONS: '--inspect',
    PNPM_PACKAGE_NAME: 'parallax',
    npm_command: 'run-script',
    npm_config_user_agent: 'pnpm/12.8.2 npm/? node/? win32 x64',
    npm_execpath: 'C:\\Users\\u\\AppData\\Roaming\\npm\\node_modules\\pnpm\\pnpm.exe',
    npm_node_execpath: 'C:\\Program Files\\nodejs\\node.exe',
    pnpm_config_verify_deps_before_run: 'false',
    PARALLAX: '1',
    PARALLAX_ENTRY_ID: 'en_ffffffffffffffffffffffffffffffff',
    PARALLAX_HOME: 'D:\\tmp\\home',
    ANTHROPIC_API_KEY: 'test',
  };

  it('leaks no session or run-state variable (table over the observed dev shell)', () => {
    const { env } = buildEnvReport(input(devShell));
    for (const key of Object.keys(env)) {
      if (BUILDER_VARS.has(key)) continue;
      expect(shouldRemoveEnvVar(key), key).toBe(false);
    }
    expect(env).toEqual({
      Path: 'C:\\Users\\u\\.local\\bin;C:\\Program Files\\nodejs\\;C:\\Windows\\system32',
      PATHEXT: '.COM;.EXE;.BAT;.CMD',
      USERPROFILE: 'C:\\Users\\u',
      SystemRoot: 'C:\\Windows',
      CLAUDE_CODE_GIT_BASH_PATH: 'C:\\Git\\bin\\bash.exe',
      CLAUDE_CODE_USE_POWERSHELL_TOOL: '1',
      CLAUDE_CONFIG_DIR: 'C:\\Users\\u\\.claude-work',
      GIT_EDITOR: 'true',
      NODE: 'C:\\Program Files\\nodejs\\node.exe',
      PARALLAX_HOME: 'D:\\tmp\\home',
      ANTHROPIC_API_KEY: 'test',
      PARALLAX: '1',
      PARALLAX_ENTRY_ID: SAMPLE_IDS.entry,
      CLAUDE_CODE_EMIT_SESSION_STATE_EVENTS: '1',
      CLAUDE_AGENT_SDK_CLIENT_APP: 'parallax/1.2.3',
    });
  });

  it('reports removed names (sorted), dropped PATH entries and the builder variables', () => {
    const report = buildEnvReport(input(devShell));
    expect(report.removed).toEqual(
      [
        'CLAUDECODE',
        'CLAUDE_CODE_ENTRYPOINT',
        'CLAUDE_CODE_SESSION_ID',
        'CLAUDE_CODE_CHILD_SESSION',
        'CLAUDE_CODE_SESSION_ATTENDED',
        'CLAUDE_CODE_MESSAGING_SOCKET',
        'CLAUDE_CODE_MESSAGING_TOKEN',
        'CLAUDE_CODE_BRIDGE_SESSION_ID',
        'CLAUDE_PID',
        'CLAUDE_EFFORT',
        'CLAUDE_AGENT_SDK_VERSION',
        'INIT_CWD',
        'NODE_ENV',
        'NODE_OPTIONS',
        'PNPM_PACKAGE_NAME',
        'npm_command',
        'npm_config_user_agent',
        'npm_execpath',
        'npm_node_execpath',
        'pnpm_config_verify_deps_before_run',
        'PARALLAX',
        'PARALLAX_ENTRY_ID',
      ].sort((a, b) => a.localeCompare(b)),
    );
    expect(report.pathEntriesRemoved).toBe(2);
    expect(report.set).toEqual({
      PARALLAX: '1',
      PARALLAX_ENTRY_ID: SAMPLE_IDS.entry,
      CLAUDE_CODE_EMIT_SESSION_STATE_EVENTS: '1',
      CLAUDE_AGENT_SDK_CLIENT_APP: 'parallax/1.2.3',
    });
    expect(report.issues).toEqual([]);
  });

  it('never leaks variables of the real calling process (live process.env of this test run)', () => {
    const { env } = buildEnvReport(input(process.env));
    for (const key of Object.keys(env)) {
      if (BUILDER_VARS.has(key)) continue;
      expect(shouldRemoveEnvVar(key), key).toBe(false);
    }
    expect(Object.keys(env).filter((key) => /^claudecode$/i.test(key))).toEqual([]);
    const pathValue = getEnvVar(env, 'PATH') ?? '';
    expect(pathValue.toLowerCase()).not.toMatch(/node_modules[\\/]\.bin/);
  });

  it('keeps one spelling per name (first seen wins) and cleans the PATH under its own spelling', () => {
    const { env } = buildEnvReport(
      input({ Path: 'C:\\a;D:\\r\\node_modules\\.bin', PATH: 'ignored', foo: '1', FOO: '2' }),
    );
    expect(env.Path).toBe('C:\\a');
    expect(env.PATH).toBeUndefined();
    expect(env.foo).toBe('1');
    expect(env.FOO).toBeUndefined();
  });

  it('skips undefined values', () => {
    expect(buildEnvReport(input({ A: undefined, B: 'b' })).env.B).toBe('b');
    expect(Object.keys(buildEnvReport(input({ A: undefined })).env)).not.toContain('A');
  });

  describe('profile env', () => {
    const base = {
      Path: 'C:\\Windows;D:\\r\\node_modules\\.bin',
      USERPROFILE: 'C:\\Users\\u',
      NPM_CONFIG_REGISTRY: 'https://nexus.corp/npm/',
      Mixed: 'm',
    };

    it('merges case-insensitively: PATH replaces Path, foo replaces FOO', () => {
      const { env } = buildEnvReport(
        input(
          { ...base, FOO: 'old' },
          { profile: { env: { PATH: 'C:\\only', foo: 'new' }, configDir: null } },
        ),
      );
      expect(env.PATH).toBe('C:\\only');
      expect(env.Path).toBeUndefined();
      expect(env.foo).toBe('new');
      expect(env.FOO).toBeUndefined();
    });

    it('resolves ${env:NAME} against the cleaned machine env (PATH without node_modules\\.bin)', () => {
      const { env } = buildEnvReport(
        input(base, { profile: { env: { PATH: 'C:\\extra;${env:path}' }, configDir: null } }),
      );
      expect(env.PATH).toBe('C:\\extra;C:\\Windows');
    });

    it('resolves a removed machine variable on purpose (${env:NPM_CONFIG_REGISTRY})', () => {
      const { env, issues } = buildEnvReport(
        input(base, {
          profile: { env: { NPM_CONFIG_REGISTRY: '${env:NPM_CONFIG_REGISTRY}' }, configDir: null },
        }),
      );
      expect(issues).toEqual([]);
      expect(env.NPM_CONFIG_REGISTRY).toBe('https://nexus.corp/npm/');
    });

    it('does not chain references between profile entries', () => {
      const { env, issues } = buildEnvReport(
        input(base, { profile: { env: { A: 'x', B: '${env:A}' }, configDir: null } }),
      );
      expect(env.A).toBe('x');
      expect(env.B).toBeUndefined();
      expect(issues).toEqual([{ code: 'PROFILE_ENV_REF_UNRESOLVED', params: { name: 'A', key: 'B' } }]);
    });

    it('reports every unresolved reference and leaves the key unset', () => {
      const { env, issues } = buildEnvReport(
        input(base, {
          profile: { env: { KEY: '${env:NOPE}-${env:ALSO_NOPE}', OK: '${env:Mixed}' }, configDir: null },
        }),
      );
      expect(env.KEY).toBeUndefined();
      expect(env.OK).toBe('m');
      expect(issues.map((issue) => issue.params)).toEqual([
        { name: 'NOPE', key: 'KEY' },
        { name: 'ALSO_NOPE', key: 'KEY' },
      ]);
    });

    it('lets the profile set otherwise removed variables explicitly (arbitrary env, Plan)', () => {
      const { env } = buildEnvReport(
        input(base, {
          profile: {
            env: { NODE_OPTIONS: '--max-old-space-size=4096', ANTHROPIC_API_KEY: 'test' },
            configDir: null,
          },
        }),
      );
      expect(env.NODE_OPTIONS).toBe('--max-old-space-size=4096');
      expect(env.ANTHROPIC_API_KEY).toBe('test');
    });

    it('cannot override the Parallax variables', () => {
      const { env } = buildEnvReport(
        input(base, {
          profile: {
            env: {
              parallax: '0',
              PARALLAX_ENTRY_ID: 'x',
              claude_agent_sdk_client_app: 'evil',
              CLAUDE_CODE_EMIT_SESSION_STATE_EVENTS: '0',
            },
            configDir: null,
          },
        }),
      );
      expect(env.PARALLAX).toBe('1');
      expect(env.parallax).toBeUndefined();
      expect(env.PARALLAX_ENTRY_ID).toBe(SAMPLE_IDS.entry);
      expect(env.CLAUDE_AGENT_SDK_CLIENT_APP).toBe('parallax/1.2.3');
      expect(env.claude_agent_sdk_client_app).toBeUndefined();
      expect(env.CLAUDE_CODE_EMIT_SESSION_STATE_EVENTS).toBe('1');
    });

    it.each([['A=B'], ['NUL\0']])('rejects the invalid variable name %j', (key) => {
      const { env, issues } = buildEnvReport(
        input(base, { profile: { env: { [key]: 'v' }, configDir: null } }),
      );
      expect(issues).toEqual([{ code: 'VALIDATION_FAILED', params: { path: 'profile.env', key } }]);
      expect(env[key]).toBeUndefined();
    });

    it('rejects a NUL in a value', () => {
      const { issues } = buildEnvReport(input(base, { profile: { env: { A: 'x\0y' }, configDir: null } }));
      expect(issues[0]?.code).toBe('VALIDATION_FAILED');
    });

    it('never reports profile env values in `set`', () => {
      const { set } = buildEnvReport(
        input(base, { profile: { env: { SECRET_TOKEN: 'hunter2' }, configDir: null } }),
      );
      expect(JSON.stringify(set)).not.toContain('hunter2');
    });
  });

  describe('Parallax variables', () => {
    it('omits PARALLAX_ENTRY_ID without an entry, also when it was inherited', () => {
      const { env, set } = buildEnvReport(
        input({ PARALLAX_ENTRY_ID: 'en_old', parallax_entry_id: 'x' }, { entryId: null }),
      );
      expect(Object.keys(env).filter((key) => key.toUpperCase() === 'PARALLAX_ENTRY_ID')).toEqual([]);
      expect(set.PARALLAX_ENTRY_ID).toBeUndefined();
      expect(env.PARALLAX).toBe('1');
    });

    it('sets CLAUDE_CONFIG_DIR from the profile, over the inherited value and profile.env', () => {
      const { env } = buildEnvReport(
        input(
          { claude_config_dir: 'C:\\inherited' },
          { profile: { env: { CLAUDE_CONFIG_DIR: 'C:\\from-env' }, configDir: 'D:\\claude\\work' } },
        ),
      );
      expect(env.CLAUDE_CONFIG_DIR).toBe('D:\\claude\\work');
      expect(env.claude_config_dir).toBeUndefined();
    });

    it('keeps an inherited CLAUDE_CONFIG_DIR when the profile has none', () => {
      expect(buildEnvReport(input({ CLAUDE_CONFIG_DIR: 'C:\\c' })).env.CLAUDE_CONFIG_DIR).toBe('C:\\c');
    });

    it.each<[string, string]>([
      ['\\\\server\\share\\claude', 'unc'],
      ['\\\\?\\C:\\claude', 'device'],
      ['relative\\claude', 'not_absolute'],
      ['C:\\claude:stream', 'ads'],
    ])('rejects the unsafe configDir %s (C.10)', (configDir, reason) => {
      const { env, issues } = buildEnvReport(input({}, { profile: { env: {}, configDir } }));
      expect(issues).toEqual([{ code: 'PATH_REJECTED', params: { reason, field: 'configDir' } }]);
      expect(env.CLAUDE_CONFIG_DIR).toBeUndefined();
    });
  });
});

describe('buildEnv', () => {
  it('returns the env of the report', () => {
    const base = { Path: 'C:\\a', CLAUDECODE: '1' };
    expect(buildEnv(input(base))).toEqual(buildEnvReport(input(base)).env);
  });

  it('throws CommandError with the first issue', () => {
    let caught: unknown;
    try {
      buildEnv(input({}, { profile: { env: { K: '${env:MISSING_VAR}' }, configDir: null } }));
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(CommandError);
    expect((caught as CommandError).error).toEqual({
      code: 'PROFILE_ENV_REF_UNRESOLVED',
      params: { name: 'MISSING_VAR', key: 'K' },
    });
  });

  it('uses the platform delimiter by default', () => {
    const { delimiter: _ignored, ...withoutDelimiter } = input({ PATH: 'C:\\a;D:\\r\\node_modules\\.bin' });
    expect(buildEnv(withoutDelimiter).PATH).toBe(
      process.platform === 'win32' ? 'C:\\a' : 'C:\\a;D:\\r\\node_modules\\.bin',
    );
  });
});
