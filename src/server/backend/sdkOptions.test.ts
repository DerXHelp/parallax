import type { CanUseTool, Options, SpawnedProcess, SpawnOptions } from '@anthropic-ai/claude-agent-sdk';
import { describe, expect, it } from 'vitest';
import { SAMPLE_IDS } from '@shared/samples';
import type { LaunchSpec } from '../claude/ports';
import { buildQueryOptions, flagSettingsAfterStart, optionIssues, SETTING_SOURCES } from './sdkOptions';
import type { StartSessionRequest } from './types';

const canUseTool: CanUseTool = () => Promise.resolve({ behavior: 'deny', message: 'test' });
const spawn = (_o: SpawnOptions): SpawnedProcess => {
  throw new Error('not spawned in this test');
};
const stderr = (_d: string): void => undefined;
const hooks = { canUseTool, spawn, stderr };

const EXE = 'C:\\Users\\u\\.local\\bin\\claude.exe';

function launch(p: Partial<LaunchSpec> = {}): LaunchSpec {
  return {
    profileId: SAMPLE_IDS.profile,
    executablePath: EXE,
    executableVersion: '2.1.300',
    env: { PATH: 'C:\\Windows\\System32', PARALLAX: '1', PARALLAX_ENTRY_ID: SAMPLE_IDS.entry },
    configDir: null,
    sdkOptions: {},
    extraArgs: {},
    allowDangerouslySkipPermissions: false,
    autoCompactWindow: null,
    contextWindow: null,
    ...p,
  };
}

function request(p: Partial<StartSessionRequest> = {}): StartSessionRequest {
  return {
    entryId: SAMPLE_IDS.entry,
    cwd: 'c:\\Work\\Repo',
    launch: launch(),
    resumeSessionId: null,
    model: null,
    permissionMode: null,
    effort: null,
    promptSuggestions: false,
    canUseTool: () => Promise.resolve({ behavior: 'deny', message: 'x' }),
    ...p,
  };
}

/** Keys that are always present (WP-13 §3.2 table). */
const BASE_KEYS = [
  'canUseTool',
  'cwd',
  'env',
  'includePartialMessages',
  'pathToClaudeCodeExecutable',
  'promptSuggestions',
  'settingSources',
  'spawnClaudeCodeProcess',
  'stderr',
  'systemPrompt',
  'thinking',
  'toolConfig',
];

describe('buildQueryOptions – fixed rows', () => {
  const req = request();
  const options = buildQueryOptions(req, hooks);

  it('sets exactly the always-present keys for a minimal request', () => {
    expect(Object.keys(options).sort()).toEqual(BASE_KEYS);
  });

  it.each<[string, keyof Options, unknown]>([
    ['cwd exactly as stored (B)', 'cwd', 'c:\\Work\\Repo'],
    ['pathToClaudeCodeExecutable (C.7)', 'pathToClaudeCodeExecutable', EXE],
    ['settingSources', 'settingSources', ['user', 'project', 'local']],
    ['preset system prompt without append (C.12)', 'systemPrompt', { type: 'preset', preset: 'claude_code' }],
    ['includePartialMessages', 'includePartialMessages', true],
    ['thinking adaptive/summarized', 'thinking', { type: 'adaptive', display: 'summarized' }],
    [
      'toolConfig previewFormat markdown (F.5)',
      'toolConfig',
      { askUserQuestion: { previewFormat: 'markdown' } },
    ],
    ['promptSuggestions from the request', 'promptSuggestions', false],
  ])('%s', (_label, key, value) => {
    expect(options[key]).toEqual(value);
  });

  it('passes the hooks through unchanged', () => {
    expect(options.canUseTool).toBe(canUseTool);
    expect(options.spawnClaudeCodeProcess).toBe(spawn);
    expect(options.stderr).toBe(stderr);
  });

  it('passes launch.env unchanged, as a copy (the SDK mutates it)', () => {
    expect(options.env).toEqual(req.launch.env);
    expect(options.env).not.toBe(req.launch.env);
    expect(options.settingSources).not.toBe(SETTING_SOURCES);
  });

  it('keeps cwd byte-identical (drive letter spelling is part of the CLI project dir, F.15)', () => {
    expect(buildQueryOptions(request({ cwd: 'C:\\work\\repo\\' }), hooks).cwd).toBe('C:\\work\\repo\\');
  });

  it('never sets the deliberately omitted options', () => {
    for (const key of [
      'enableFileCheckpointing',
      'perTaskStopAffordance',
      'sessionId',
      'forkSession',
      'maxTurns',
      'abortController',
      'permissionMode',
      'allowDangerouslySkipPermissions',
      'model',
      'effort',
      'resume',
      'settings',
      'extraArgs',
      'plugins',
      'betas',
      'additionalDirectories',
      'allowedTools',
      'disallowedTools',
    ] as const) {
      expect(options).not.toHaveProperty(key);
    }
  });
});

describe('buildQueryOptions – request-dependent rows', () => {
  it.each<[string, Partial<StartSessionRequest>, Partial<Options>]>([
    ['promptSuggestions true', { promptSuggestions: true }, { promptSuggestions: true }],
    ['permissionMode set (profile/resume, C.3)', { permissionMode: 'plan' }, { permissionMode: 'plan' }],
    ['permissionMode default', { permissionMode: 'default' }, { permissionMode: 'default' }],
    ['permissionMode acceptEdits', { permissionMode: 'acceptEdits' }, { permissionMode: 'acceptEdits' }],
    ['permissionMode auto', { permissionMode: 'auto' }, { permissionMode: 'auto' }],
    ['model', { model: 'haiku' }, { model: 'haiku' }],
    ['effort', { effort: 'high' }, { effort: 'high' }],
    ['resume (F.14)', { resumeSessionId: SAMPLE_IDS.sessionId }, { resume: SAMPLE_IDS.sessionId }],
    [
      'resume with the last actual mode (C.3)',
      { resumeSessionId: SAMPLE_IDS.sessionId, permissionMode: 'acceptEdits' },
      { resume: SAMPLE_IDS.sessionId, permissionMode: 'acceptEdits' },
    ],
    [
      'bypass with allowDangerouslySkipPermissions',
      {
        permissionMode: 'bypassPermissions',
        launch: launch({ allowDangerouslySkipPermissions: true }),
      },
      { permissionMode: 'bypassPermissions', allowDangerouslySkipPermissions: true },
    ],
    [
      'allowDangerouslySkipPermissions without a bypass start mode',
      { launch: launch({ allowDangerouslySkipPermissions: true }) },
      { allowDangerouslySkipPermissions: true },
    ],
  ])('%s', (_label, partial, expected) => {
    const options = buildQueryOptions(request(partial), hooks);
    expect(options).toMatchObject(expected);
    expect(Object.keys(options).sort()).toEqual(
      [...BASE_KEYS, ...Object.keys(expected)].sort().filter(unique),
    );
  });

  it('omits permissionMode for null (C.3, F.2)', () => {
    expect(buildQueryOptions(request({ permissionMode: null }), hooks)).not.toHaveProperty('permissionMode');
  });

  it('drops bypassPermissions without allowDangerouslySkipPermissions (defense in depth, C.3)', () => {
    const req = request({ permissionMode: 'bypassPermissions' });
    const options = buildQueryOptions(req, hooks);
    expect(options).not.toHaveProperty('permissionMode');
    expect(options).not.toHaveProperty('allowDangerouslySkipPermissions');
    expect(optionIssues(req)).toEqual([
      'permissionMode bypassPermissions without allowDangerouslySkipPermissions is omitted',
    ]);
  });
});

function unique(value: string, index: number, all: string[]): boolean {
  return all.indexOf(value) === index;
}

describe('buildQueryOptions – profile options (launch.sdkOptions, C.12)', () => {
  it.each<[string, Partial<LaunchSpec>, Partial<Options>]>([
    [
      'appendSystemPrompt → preset append',
      { sdkOptions: { appendSystemPrompt: 'Be brief.' } },
      { systemPrompt: { type: 'preset', preset: 'claude_code', append: 'Be brief.' } },
    ],
    [
      'additionalDirectories',
      { sdkOptions: { additionalDirectories: ['D:\\shared'] } },
      { additionalDirectories: ['D:\\shared'] },
    ],
    [
      'allowedTools',
      { sdkOptions: { allowedTools: ['Read', 'Bash(git:*)'] } },
      { allowedTools: ['Read', 'Bash(git:*)'] },
    ],
    ['disallowedTools', { sdkOptions: { disallowedTools: ['WebFetch'] } }, { disallowedTools: ['WebFetch'] }],
    ['betas', { sdkOptions: { betas: ['context-1m-2025-08-07'] } }, { betas: ['context-1m-2025-08-07'] }],
    [
      'plugins → local plugin configs (WP-11 follow-up)',
      { sdkOptions: { plugins: ['D:\\plugins\\a', 'D:\\plugins\\b'] } },
      {
        plugins: [
          { type: 'local', path: 'D:\\plugins\\a' },
          { type: 'local', path: 'D:\\plugins\\b' },
        ],
      },
    ],
    [
      'settings path',
      { sdkOptions: { settings: 'D:\\cfg\\settings.json' } },
      { settings: 'D:\\cfg\\settings.json' },
    ],
    [
      'autoCompactWindow without a settings path → inline settings (C.1)',
      { autoCompactWindow: 400_000 },
      { settings: { autoCompactWindow: 400_000 } },
    ],
    [
      'settings path + autoCompactWindow → path here, window after start',
      { sdkOptions: { settings: 'D:\\cfg\\settings.json' }, autoCompactWindow: 400_000 },
      { settings: 'D:\\cfg\\settings.json' },
    ],
    [
      'extraArgs passed through',
      { extraArgs: { verbose: null, 'some-flag': 'x' } },
      { extraArgs: { verbose: null, 'some-flag': 'x' } },
    ],
    [
      'mcpConfig → extraArgs mcp-config (first value)',
      { sdkOptions: { mcpConfig: ['D:\\mcp\\a.json', 'D:\\mcp\\b.json'] }, extraArgs: { 'some-flag': null } },
      { extraArgs: { 'some-flag': null, 'mcp-config': 'D:\\mcp\\a.json' } },
    ],
  ])('%s', (_label, partial, expected) => {
    const options = buildQueryOptions(request({ launch: launch(partial) }), hooks);
    expect(options).toEqual(expect.objectContaining(expected));
  });

  it('ignores empty profile lists and the model/permissionMode of the profile (the manager decides)', () => {
    const options = buildQueryOptions(
      request({
        launch: launch({
          sdkOptions: {
            additionalDirectories: [],
            allowedTools: [],
            disallowedTools: [],
            betas: [],
            plugins: [],
            mcpConfig: [],
            model: 'opus',
            permissionMode: 'plan',
          },
        }),
      }),
      hooks,
    );
    expect(Object.keys(options).sort()).toEqual(BASE_KEYS);
  });

  it('does not mutate the launch spec', () => {
    const spec = launch({
      extraArgs: { a: null },
      sdkOptions: { mcpConfig: ['D:\\m.json'], allowedTools: ['Read'] },
    });
    const snapshot = structuredClone(spec);
    const options = buildQueryOptions(request({ launch: spec }), hooks);
    options.allowedTools?.push('Write');
    if (options.extraArgs !== undefined) options.extraArgs.b = null;
    expect(spec).toEqual(snapshot);
  });
});

describe('flagSettingsAfterStart (C.1)', () => {
  it.each<[string, Partial<LaunchSpec>, { autoCompactWindow: number } | null]>([
    ['nothing', {}, null],
    ['only autoCompactWindow (inline settings)', { autoCompactWindow: 300_000 }, null],
    ['only a settings path', { sdkOptions: { settings: 'D:\\s.json' } }, null],
    [
      'settings path + autoCompactWindow',
      { sdkOptions: { settings: 'D:\\s.json' }, autoCompactWindow: 300_000 },
      { autoCompactWindow: 300_000 },
    ],
  ])('%s', (_label, partial, expected) => {
    expect(flagSettingsAfterStart(launch(partial))).toEqual(expected);
  });
});

describe('optionIssues', () => {
  it('is empty for a plain request', () => {
    expect(optionIssues(request())).toEqual([]);
  });

  it('reports dropped --mcp-config values (Phase 2, §7)', () => {
    expect(
      optionIssues(
        request({ launch: launch({ sdkOptions: { mcpConfig: ['a.json', 'b.json', 'c.json'] } }) }),
      ),
    ).toEqual(['only the first of 3 --mcp-config values is passed (extraArgs holds one value per flag)']);
  });
});
