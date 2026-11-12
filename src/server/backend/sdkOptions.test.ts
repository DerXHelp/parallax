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

/**
 * Keys that are always present (WP-13 §3.2 table; Phase 3: stop per task, summaries). WP61-02: no
 * `settings` without a flag value – `todoFeatureEnabled` is not sent (no effect with CLI 2.1.322).
 */
const BASE_KEYS = [
  'agentProgressSummaries',
  'canUseTool',
  'cwd',
  'env',
  'includePartialMessages',
  'pathToClaudeCodeExecutable',
  'perTaskStopAffordance',
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
    ['perTaskStopAffordance on (Phase 3, ADR-149)', 'perTaskStopAffordance', true],
    ['agentProgressSummaries on (Phase 3, task_progress.summary)', 'agentProgressSummaries', true],
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
      'sessionId',
      'forkSession',
      'maxTurns',
      'abortController',
      'permissionMode',
      'allowDangerouslySkipPermissions',
      'model',
      'effort',
      'resume',
      'extraArgs',
      'plugins',
      'betas',
      'additionalDirectories',
      'allowedTools',
      'disallowedTools',
      // WP61-02: no flag settings without a value.
      'settings',
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
  it.each<[string, Partial<LaunchSpec>, object | null]>([
    ['nothing (inline settings)', {}, null],
    ['only autoCompactWindow (inline settings)', { autoCompactWindow: 300_000 }, null],
    // WP61-02: a settings file alone needs no flag settings after the start (no todo flag).
    ['only a settings path', { sdkOptions: { settings: 'D:\\s.json' } }, null],
    [
      'settings path + autoCompactWindow',
      { sdkOptions: { settings: 'D:\\s.json' }, autoCompactWindow: 300_000 },
      { autoCompactWindow: 300_000 },
    ],
  ])('%s', (_label, partial, expected) => {
    expect(flagSettingsAfterStart(request({ launch: launch(partial) }))).toEqual(expected);
  });
});

describe('fast mode as flag setting (Phase 2, WP-31)', () => {
  const path = { sdkOptions: { settings: 'D:\\cfg\\settings.json' } };
  it.each<[string, Partial<StartSessionRequest>, Options['settings'], object | null]>([
    ['absent → the CLI decides', {}, undefined, null],
    ['null → the CLI decides', { fastMode: null }, undefined, null],
    ['true → inline settings.fastMode', { fastMode: true }, { fastMode: true }, null],
    ['false → inline settings.fastMode false', { fastMode: false }, { fastMode: false }, null],
    [
      'together with autoCompactWindow',
      { fastMode: true, launch: launch({ autoCompactWindow: 400_000 }) },
      { autoCompactWindow: 400_000, fastMode: true },
      null,
    ],
    [
      'settings file → path inline, fast mode after the start',
      { fastMode: true, launch: launch(path) },
      'D:\\cfg\\settings.json',
      { fastMode: true },
    ],
    [
      'settings file + autoCompactWindow + fast mode → both after the start',
      { fastMode: false, launch: launch({ ...path, autoCompactWindow: 300_000 }) },
      'D:\\cfg\\settings.json',
      { autoCompactWindow: 300_000, fastMode: false },
    ],
  ])('%s', (_label, partial, settings, after) => {
    const req = request(partial);
    const options = buildQueryOptions(req, hooks);
    expect(options.settings).toEqual(settings);
    expect(flagSettingsAfterStart(req)).toEqual(after);
  });
});

describe('Phase 3 options (WP-52)', () => {
  const settingsFile = { sdkOptions: { settings: 'D:\\cfg\\settings.json' } };
  it.each<[string, Partial<StartSessionRequest>, Partial<Options>, object | null]>([
    [
      'plain profile: stop per task, summaries (WP61-02: no todo flag)',
      {},
      { perTaskStopAffordance: true, agentProgressSummaries: true },
      null,
    ],
    [
      'profile with a settings file: same options, nothing after the start',
      { launch: launch(settingsFile) },
      { perTaskStopAffordance: true, agentProgressSummaries: true, settings: 'D:\\cfg\\settings.json' },
      null,
    ],
    [
      'settings file + resume + fast mode',
      { launch: launch(settingsFile), resumeSessionId: SAMPLE_IDS.sessionId, fastMode: true },
      { perTaskStopAffordance: true, agentProgressSummaries: true, resume: SAMPLE_IDS.sessionId },
      { fastMode: true },
    ],
  ])('%s', (_label, partial, expected, after) => {
    const req = request(partial);
    expect(buildQueryOptions(req, hooks)).toMatchObject(expected);
    expect(flagSettingsAfterStart(req)).toEqual(after);
  });

  it.each<[string, readonly string[] | undefined, string | null | undefined, string[] | undefined]>([
    ['no folders → omitted', undefined, undefined, undefined],
    ['attachment folder null → omitted', [], null, undefined],
    ['empty attachment folder string → omitted', undefined, '', undefined],
    ['only the attachment folder', undefined, 'C:\\px\\attachments\\en_1', ['C:\\px\\attachments\\en_1']],
    ['profile folders + attachment folder', ['D:\\shared'], 'C:\\px\\att', ['D:\\shared', 'C:\\px\\att']],
    ['attachment folder already in the profile (case/slash differ)', ['C:\\PX\\Att\\'], 'c:/px/att', ['C:\\PX\\Att\\']],
    ['duplicate profile folders are dropped too', ['D:\\a', 'd:\\A', 'D:\\b'], null, ['D:\\a', 'D:\\b']],
  ])('additionalDirectories: %s', (_label, profileDirs, attachmentsDir, expected) => {
    const sdkOptions = profileDirs === undefined ? {} : { additionalDirectories: [...profileDirs] };
    const req = request({ launch: launch({ sdkOptions }), ...(attachmentsDir === undefined ? {} : { attachmentsDir }) });
    const options = buildQueryOptions(req, hooks);
    if (expected === undefined) expect(options).not.toHaveProperty('additionalDirectories');
    else expect(options.additionalDirectories).toEqual(expected);
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

  it('drops beta names that are no beta header and reports them (R2-11)', () => {
    const req = request({
      launch: launch({ sdkOptions: { betas: ['context-1m-2025-08-07', 'Bad Beta', '', 'x;y'] } }),
    });
    expect(buildQueryOptions(req, hooks).betas).toEqual(['context-1m-2025-08-07']);
    expect(optionIssues(req)).toEqual(['invalid beta names are omitted: "Bad Beta", "", "x;y"']);
    const onlyInvalid = request({ launch: launch({ sdkOptions: { betas: ['NOPE'] } }) });
    expect('betas' in buildQueryOptions(onlyInvalid, hooks)).toBe(false);
  });
});
