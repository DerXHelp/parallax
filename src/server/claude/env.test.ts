import { describe, expect, it } from 'vitest';
import { SAMPLE_IDS } from '@shared/samples';
import { getEnvVar } from '../lib/windows';
import { CommandError } from '../sync/ports';
import {
  CLAUDE_CODE_ENV_ALLOWLIST,
  CLAUDE_SESSION_TOOL_SHELL_VARS,
  TERMINAL_TOOL_SHELL_VARS,
  buildEnv,
  buildEnvReport,
  clientAppId,
  deleteEnvVar,
  envRemovalReason,
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
    // R1-03: further markers of the calling session (AI_AGENT = claude-code_<version>_agent)
    'AI_AGENT',
    'ai_agent',
    'CLAUDE_PROJECT_DIR',
    'CLAUDE_ENV_FILE',
    'CLAUDE_PLUGIN_ROOT',
    'CLAUDE_PLUGIN_DATA',
    // pnpm/npm run state (names observed with `pnpm run` 12.8)
    'npm_config_user_agent',
    'npm_config_node_gyp',
    'npm_execpath',
    'npm_node_execpath',
    'npm_command',
    'npm_lifecycle_event',
    'npm_lifecycle_script',
    'npm_package_json',
    'npm_package_name',
    'npm_package_version',
    'NPM_CONFIG_REGISTRY',
    'PNPM_HOME',
    'PNPM_PACKAGE_NAME',
    'PNPM_SCRIPT_SRC_DIR',
    'pnpm_config_verify_deps_before_run',
    'INIT_CWD',
    'NODE_ENV',
    'node_env',
    'NODE_OPTIONS',
    // inherited Parallax variables (Parallax started from a Parallax session)
    'PARALLAX',
    'PARALLAX_ENTRY_ID',
    'parallax_entry_id',
    // WP22-07: every control variable of the server environment
    'PARALLAX_HOME',
    'parallax_home',
    'PARALLAX_PORT',
    'PARALLAX_BACKEND',
    'PARALLAX_LIVE',
    'PARALLAX_VALIDATE',
    'PARALLAX_DEV_WEB_PORT',
    'PARALLAX_LOG_LEVEL',
    'PARALLAX_E2E_SKIP_BUILD',
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
    'PARALLAXHOME',
    'MY_PARALLAX_HOME',
    'PATH',
    'Path',
    'PATHEXT',
    'USERPROFILE',
    'SystemRoot',
    'GIT_EDITOR',
    'GIT_TERMINAL_PROMPT',
    'GCM_INTERACTIVE',
    'NO_COLOR',
    'MCP_TIMEOUT',
    'NoDefaultCurrentDirectoryInExePath',
    'HTTPS_PROXY',
    'AI_AGENTS',
    'CLAUDE_PROJECT',
  ])('keeps %s', (name) => {
    expect(shouldRemoveEnvVar(name)).toBe(false);
  });

  it.each([
    ['CLAUDECODE', 'session'],
    ['CLAUDE_CODE_SESSION_ID', 'session'],
    ['CLAUDE_AGENT_SDK_VERSION', 'session'],
    ['AI_AGENT', 'session'],
    ['PARALLAX_ENTRY_ID', 'session'],
    ['PARALLAX_HOME', 'session'],
    ['INIT_CWD', 'run_state'],
    ['npm_lifecycle_event', 'run_state'],
    ['npm_package_name', 'run_state'],
    ['npm_execpath', 'run_state'],
    ['npm_config_user_agent', 'run_state'],
    ['PNPM_SCRIPT_SRC_DIR', 'run_state'],
    ['NPM_CONFIG_REGISTRY', 'machine_overridable'],
    ['npm_config_cafile', 'machine_overridable'],
    ['PNPM_HOME', 'machine_overridable'],
    ['NODE_OPTIONS', 'machine_overridable'],
    ['NODE_ENV', 'machine_overridable'],
    ['CLAUDE_CODE_GIT_BASH_PATH', null],
    ['PATH', null],
  ] as const)('classifies %s as %s', (name, reason) => {
    expect(envRemovalReason(name)).toBe(reason);
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
    AI_AGENT: 'claude-code_2-1-299_agent',
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
        'AI_AGENT',
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
        'PARALLAX_HOME',
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

    it('WP22-07: of the server environment only PARALLAX=1 and the own PARALLAX_ENTRY_ID reach claude', () => {
      // What a launcher-started server inherits (Parallax developed inside a Parallax session, live run).
      const server: Record<string, string> = {
        Path: 'C:\\Windows',
        PARALLAX: '1',
        PARALLAX_ENTRY_ID: 'en_parent',
        PARALLAX_HOME: 'C:\\Users\\u\\AppData\\Local\\Temp\\parallax-live\\home',
        parallax_port: '4711',
        PARALLAX_BACKEND: 'sdk',
        PARALLAX_LIVE: '1',
        PARALLAX_VALIDATE: 'log',
        PARALLAX_DEV_WEB_PORT: '5199',
        PARALLAX_LOG_LEVEL: 'debug',
        PARALLAX_TOASTS: 'off',
        PARALLAX_SOMETHING_NEW: 'x',
      };
      for (const persistent of [
        null,
        new Map(Object.entries(server).map(([k, v]) => [k.toUpperCase(), v])),
      ]) {
        const { env, removed, keptPersistent } = buildEnvReport(input(server, { persistent }));
        expect(
          Object.keys(env)
            .filter((key) => key.toUpperCase().startsWith('PARALLAX'))
            .sort(),
        ).toEqual(['PARALLAX', 'PARALLAX_ENTRY_ID']);
        expect(env.PARALLAX).toBe('1');
        expect(env.PARALLAX_ENTRY_ID).toBe(SAMPLE_IDS.entry);
        expect(keptPersistent).toEqual([]);
        expect(removed).toEqual(
          expect.arrayContaining([
            'PARALLAX_HOME',
            'parallax_port',
            'PARALLAX_LIVE',
            'PARALLAX_SOMETHING_NEW',
          ]),
        );
      }
    });

    it('keeps a PARALLAX_* variable the profile sets on purpose (step 3)', () => {
      const { env } = buildEnvReport(
        input(
          { PARALLAX_HOME: 'D:\\server-home' },
          { profile: { env: { PARALLAX_HOME: 'D:\\x' }, configDir: null } },
        ),
      );
      expect(env.PARALLAX_HOME).toBe('D:\\x');
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

describe('persistent machine variables (Nexus, ADR-021)', () => {
  const NEXUS = 'https://nexus.corp/repository/npm/';
  /** A dev shell inside Claude Code + `pnpm run` on a machine with a company registry. */
  const shell: Record<string, string> = {
    Path: 'C:\\Windows',
    NPM_CONFIG_REGISTRY: NEXUS,
    PNPM_HOME: 'C:\\Users\\u\\AppData\\Local\\pnpm',
    NODE_OPTIONS: '--use-system-ca',
    NODE_ENV: 'development',
    npm_config_cafile: 'C:\\certs\\corp.pem',
    npm_lifecycle_event: 'dev',
    npm_execpath: 'C:\\pnpm\\pnpm.cjs',
    INIT_CWD: 'D:\\repo',
    CLAUDECODE: '1',
    CLAUDE_CODE_SESSION_ID: 'session',
    CLAUDE_AGENT_SDK_VERSION: '0.3.296',
    AI_AGENT: 'claude-code_2-1-299_agent',
    PARALLAX_ENTRY_ID: 'en_x',
  };
  const report = (persistent: Record<string, string> | null) =>
    buildEnvReport(
      input(shell, {
        persistent:
          persistent === null
            ? null
            : new Map(Object.entries(persistent).map(([k, v]) => [k.toUpperCase(), v])),
      }),
    );

  it('without a persistent source everything removable is removed (default)', () => {
    const { env, keptPersistent } = report(null);
    expect(keptPersistent).toEqual([]);
    expect(
      Object.keys(env).filter(
        (key) => key !== 'Path' && !key.startsWith('PARALLAX') && !key.startsWith('CLAUDE_'),
      ),
    ).toEqual([]);
  });

  it('keeps NPM_*/PNPM_*/NODE_OPTIONS/NODE_ENV that are persistent with the same value', () => {
    const { env, keptPersistent, removed } = report({
      NPM_CONFIG_REGISTRY: NEXUS,
      PNPM_HOME: 'C:\\Users\\u\\AppData\\Local\\pnpm',
      NODE_OPTIONS: '--use-system-ca',
      npm_config_cafile: 'C:\\certs\\corp.pem',
    });
    expect(keptPersistent).toEqual(
      ['NODE_OPTIONS', 'npm_config_cafile', 'NPM_CONFIG_REGISTRY', 'PNPM_HOME'].sort((a, b) =>
        a.localeCompare(b),
      ),
    );
    expect(env).toMatchObject({
      NPM_CONFIG_REGISTRY: NEXUS,
      PNPM_HOME: 'C:\\Users\\u\\AppData\\Local\\pnpm',
      NODE_OPTIONS: '--use-system-ca',
      npm_config_cafile: 'C:\\certs\\corp.pem',
    });
    expect(removed).toContain('NODE_ENV');
  });

  it('removes a persistent name whose process value differs (run state of pnpm run)', () => {
    const { env, removed } = report({
      NPM_CONFIG_REGISTRY: 'https://registry.npmjs.org/',
      NODE_ENV: 'production',
    });
    expect(env.NPM_CONFIG_REGISTRY).toBeUndefined();
    expect(env.NODE_ENV).toBeUndefined();
    expect(removed).toEqual(expect.arrayContaining(['NPM_CONFIG_REGISTRY', 'NODE_ENV']));
  });

  it('never keeps session markers or run state, even when they are persistent with the same value', () => {
    const { env, keptPersistent } = report({
      CLAUDECODE: '1',
      CLAUDE_CODE_SESSION_ID: 'session',
      CLAUDE_AGENT_SDK_VERSION: '0.3.296',
      AI_AGENT: 'claude-code_2-1-299_agent',
      PARALLAX_ENTRY_ID: 'en_x',
      npm_lifecycle_event: 'dev',
      npm_execpath: 'C:\\pnpm\\pnpm.cjs',
      INIT_CWD: 'D:\\repo',
    });
    expect(keptPersistent).toEqual([]);
    for (const name of [
      'CLAUDECODE',
      'CLAUDE_CODE_SESSION_ID',
      'CLAUDE_AGENT_SDK_VERSION',
      'AI_AGENT',
      'npm_lifecycle_event',
      'npm_execpath',
      'INIT_CWD',
    ]) {
      expect(env[name], name).toBeUndefined();
    }
    expect(env.PARALLAX_ENTRY_ID).toBe(SAMPLE_IDS.entry);
  });

  it('matches names case-insensitively (persistent source is upper-cased)', () => {
    const { env } = buildEnvReport(
      input({ npm_config_registry: NEXUS }, { persistent: new Map([['NPM_CONFIG_REGISTRY', NEXUS]]) }),
    );
    expect(env.npm_config_registry).toBe(NEXUS);
  });
});

describe('target terminal (R1-03, Phase 2)', () => {
  const toolShell: Record<string, string> = {
    Path: 'C:\\Windows',
    GIT_EDITOR: 'true',
    GIT_TERMINAL_PROMPT: '0',
    GIT_ASKPASS: '',
    GCM_INTERACTIVE: 'never',
    COREPACK_ENABLE_AUTO_PIN: '0',
    NO_COLOR: '1',
    PYTHONIOENCODING: 'utf-8:surrogateescape',
    PSExecutionPolicyPreference: 'Bypass',
    NoDefaultCurrentDirectoryInExePath: '1',
    MCP_TIMEOUT: '120000',
  };

  it('lists exactly the observed tool-shell variables', () => {
    expect(TERMINAL_TOOL_SHELL_VARS).toEqual([
      'GIT_EDITOR',
      'GIT_TERMINAL_PROMPT',
      'GIT_ASKPASS',
      'GCM_INTERACTIVE',
      'COREPACK_ENABLE_AUTO_PIN',
      'NO_COLOR',
      'PYTHONIOENCODING',
      'PSEXECUTIONPOLICYPREFERENCE',
    ]);
  });

  it('drops the tool-shell settings of a calling Claude session, keeps NoDefaultCurrentDirectoryInExePath', () => {
    const { env } = buildEnvReport(input({ ...toolShell, CLAUDECODE: '1' }, { target: 'terminal' }));
    for (const name of Object.keys(toolShell)) {
      const expectedKept = ['Path', 'NoDefaultCurrentDirectoryInExePath', 'MCP_TIMEOUT'].includes(name);
      expect(name in env, name).toBe(expectedKept);
    }
  });

  it('keeps them for the SDK target (except PSExecutionPolicyPreference, ADR-128) and for a terminal not started from Claude Code', () => {
    expect(buildEnvReport(input({ ...toolShell, CLAUDECODE: '1' })).env).toMatchObject({
      GIT_EDITOR: 'true',
    });
    expect(buildEnvReport(input(toolShell, { target: 'terminal' })).env).toMatchObject({
      GIT_EDITOR: 'true',
      NO_COLOR: '1',
    });
  });

  it('keeps a tool-shell variable the user set persistently with the same value', () => {
    const { env, keptPersistent } = buildEnvReport(
      input(
        { ...toolShell, GIT_EDITOR: 'code --wait', CLAUDECODE: '1' },
        { target: 'terminal', persistent: new Map([['GIT_EDITOR', 'code --wait']]) },
      ),
    );
    expect(env.GIT_EDITOR).toBe('code --wait');
    expect(keptPersistent).toEqual(['GIT_EDITOR']);
  });

  it('reports every removed tool-shell variable with the reason tool_shell', () => {
    const { removed, reasons } = buildEnvReport(
      input({ ...toolShell, CLAUDECODE: '1' }, { target: 'terminal' }),
    );
    const names = TERMINAL_TOOL_SHELL_VARS.map(
      (upper) => Object.keys(toolShell).find((key) => key.toUpperCase() === upper) ?? upper,
    );
    expect(removed).toEqual([...names, 'CLAUDECODE'].sort((a, b) => a.localeCompare(b)));
    for (const name of names) expect(reasons.get(name), name).toBe('tool_shell');
    expect(reasons.get('CLAUDECODE')).toBe('session');
  });
});

describe('ADR-128: PSExecutionPolicyPreference of a calling Claude session for every target (WP41-08)', () => {
  /** The tool shell of a Claude Code session (2.1.299) – `pnpm start`/`pnpm dev` run from there. */
  const toolShell: Record<string, string> = {
    Path: 'C:\\Windows',
    GIT_EDITOR: 'true',
    GIT_TERMINAL_PROMPT: '0',
    GIT_ASKPASS: '',
    GCM_INTERACTIVE: 'never',
    COREPACK_ENABLE_AUTO_PIN: '0',
    NO_COLOR: '1',
    PYTHONIOENCODING: 'utf-8:surrogateescape',
    PSExecutionPolicyPreference: 'Bypass',
    NoDefaultCurrentDirectoryInExePath: '1',
    MCP_TIMEOUT: '120000',
    CLAUDECODE: '1',
  };
  const KEPT = {
    GIT_EDITOR: 'true',
    GIT_TERMINAL_PROMPT: '0',
    GIT_ASKPASS: '',
    GCM_INTERACTIVE: 'never',
    COREPACK_ENABLE_AUTO_PIN: '0',
    NO_COLOR: '1',
    PYTHONIOENCODING: 'utf-8:surrogateescape',
    NoDefaultCurrentDirectoryInExePath: '1',
    MCP_TIMEOUT: '120000',
  };
  const policyKeys = (env: Record<string, string>): string[] =>
    Object.keys(env).filter((key) => key.toUpperCase() === 'PSEXECUTIONPOLICYPREFERENCE');

  it('lists only PSExecutionPolicyPreference (a subset of the terminal list)', () => {
    expect(CLAUDE_SESSION_TOOL_SHELL_VARS).toEqual(['PSEXECUTIONPOLICYPREFERENCE']);
    for (const name of CLAUDE_SESSION_TOOL_SHELL_VARS) expect(TERMINAL_TOOL_SHELL_VARS).toContain(name);
  });

  it.each<[string, Partial<BuildEnvInput>]>([
    ['SDK session (default target)', {}],
    ['SDK session (explicit target sdk)', { target: 'sdk' }],
    ['"Profil testen" / preflight (no entry)', { entryId: null }],
  ])('%s: removed with reason tool_shell, the other tool-shell settings stay', (_name, partial) => {
    const { env, removed, keptPersistent, reasons } = buildEnvReport(input(toolShell, partial));
    expect(policyKeys(env)).toEqual([]);
    expect(env).toMatchObject(KEPT);
    expect(removed).toEqual(['CLAUDECODE', 'PSExecutionPolicyPreference']);
    expect(keptPersistent).toEqual([]);
    expect(reasons.get('PSExecutionPolicyPreference')).toBe('tool_shell');
    expect(reasons.has('GIT_EDITOR')).toBe(false);
  });

  it.each([
    ['psexecutionpolicypreference', 'CLAUDECODE'],
    ['PSEXECUTIONPOLICYPREFERENCE', 'claudecode'],
    ['PsExecutionPolicyPreference', 'ClaudeCode'],
  ])('matches %s case-insensitively (marker %s)', (policy, marker) => {
    const { env, removed, reasons } = buildEnvReport(
      input({ Path: 'C:\\Windows', [policy]: 'Bypass', [marker]: '1', NO_COLOR: '1' }),
    );
    expect(policyKeys(env)).toEqual([]);
    expect(env.NO_COLOR).toBe('1');
    expect(removed).toContain(policy);
    expect(reasons.get(policy)).toBe('tool_shell');
  });

  it('without a calling Claude session (no CLAUDECODE) nothing changes – for every target', () => {
    const { CLAUDECODE: _marker, ...plain } = toolShell;
    for (const target of ['sdk', 'terminal'] as const) {
      const { env, removed, reasons } = buildEnvReport(input(plain, { target }));
      expect(env.PSExecutionPolicyPreference, target).toBe('Bypass');
      expect(env, target).toMatchObject(KEPT);
      expect(removed, target).toEqual([]);
      expect(reasons.size, target).toBe(0);
    }
  });

  it('keeps it when it is set persistently with the same value (reason tool_shell), removes it otherwise', () => {
    const same = buildEnvReport(
      input(toolShell, { persistent: new Map([['PSEXECUTIONPOLICYPREFERENCE', 'Bypass']]) }),
    );
    expect(same.env.PSExecutionPolicyPreference).toBe('Bypass');
    expect(same.keptPersistent).toEqual(['PSExecutionPolicyPreference']);
    expect(same.removed).toEqual(['CLAUDECODE']);
    expect(same.reasons.get('PSExecutionPolicyPreference')).toBe('tool_shell');

    const other = buildEnvReport(
      input(toolShell, { persistent: new Map([['PSEXECUTIONPOLICYPREFERENCE', 'RemoteSigned']]) }),
    );
    expect(policyKeys(other.env)).toEqual([]);
    expect(other.keptPersistent).toEqual([]);
    expect(other.removed).toContain('PSExecutionPolicyPreference');
  });

  it('a profile can still set it on purpose (step 3, also via ${env:…} of the machine)', () => {
    const { env, issues } = buildEnvReport(
      input(toolShell, {
        profile: {
          env: { PSExecutionPolicyPreference: '${env:PSExecutionPolicyPreference}' },
          configDir: null,
        },
      }),
    );
    expect(issues).toEqual([]);
    expect(env.PSExecutionPolicyPreference).toBe('Bypass');
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
