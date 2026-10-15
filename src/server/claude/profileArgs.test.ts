import { describe, expect, it } from 'vitest';
import type { ErrorPayload } from '@shared/errors';
import { BLOCKED_PROFILE_FLAGS, isBroadToolRule, parseProfileArgs, splitToolList } from './profileArgs';
import type { ParseProfileArgs, ProfileArgsResult } from './ports';

// Implements the frozen port type.
const parse: ParseProfileArgs = parseProfileArgs;

const EMPTY: ProfileArgsResult = {
  sdkOptions: {},
  extraArgs: {},
  allowDangerouslySkipPermissions: false,
  warnings: [],
  errors: [],
};

function result(partial: Partial<ProfileArgsResult>): ProfileArgsResult {
  return { ...EMPTY, ...partial };
}

const err = (
  code: ErrorPayload['code'],
  index: number,
  flag: string,
  extra: Record<string, string> = {},
) => ({
  code,
  params: { index, flag, ...extra },
});
const invalid = (index: number, flag: string, reason: string) =>
  err('PROFILE_ARG_INVALID', index, flag, { reason });

describe('parseProfileArgs: mapped flags (C.12)', () => {
  it.each<[string, string[], Partial<ProfileArgsResult>]>([
    ['nothing', [], {}],
    ['--model value', ['--model', 'haiku'], { sdkOptions: { model: 'haiku' } }],
    ['--model=value', ['--model=claude-sonnet-5-5'], { sdkOptions: { model: 'claude-sonnet-5-5' } }],
    [
      '--model Bedrock ARN',
      ['--model', 'arn:aws:bedrock:eu-central-1:1:x/y'],
      { sdkOptions: { model: 'arn:aws:bedrock:eu-central-1:1:x/y' } },
    ],
    ['--permission-mode', ['--permission-mode', 'plan'], { sdkOptions: { permissionMode: 'plan' } }],
    [
      '--permission-mode=acceptEdits',
      ['--permission-mode=acceptEdits'],
      { sdkOptions: { permissionMode: 'acceptEdits' } },
    ],
    [
      '--settings',
      ['--settings', 'D:\\cfg\\settings.json'],
      { sdkOptions: { settings: 'D:\\cfg\\settings.json' } },
    ],
    ['--settings json', ['--settings={"model":"haiku"}'], { sdkOptions: { settings: '{"model":"haiku"}' } }],
    [
      '--append-system-prompt (resume warning)',
      ['--append-system-prompt', 'Answer in German.'],
      {
        sdkOptions: { appendSystemPrompt: 'Answer in German.' },
        warnings: [err('PROFILE_ARG_RESUME_NO_EFFECT', 0, '--append-system-prompt')],
      },
    ],
    [
      '--append-system-prompt=-dash value',
      ['--append-system-prompt=-be terse'],
      {
        sdkOptions: { appendSystemPrompt: '-be terse' },
        warnings: [err('PROFILE_ARG_RESUME_NO_EFFECT', 0, '--append-system-prompt')],
      },
    ],
    [
      '--add-dir variadic',
      ['--add-dir', 'D:\\a', 'D:\\b'],
      { sdkOptions: { additionalDirectories: ['D:\\a', 'D:\\b'] } },
    ],
    [
      '--add-dir repeated',
      ['--add-dir', 'D:\\a', '--add-dir=D:\\b'],
      { sdkOptions: { additionalDirectories: ['D:\\a', 'D:\\b'] } },
    ],
    ['--plugin-dir', ['--plugin-dir', 'D:\\plugins\\p'], { sdkOptions: { plugins: ['D:\\plugins\\p'] } }],
    [
      '--mcp-config file + json',
      ['--mcp-config', 'D:\\mcp.json', '{"mcpServers":{}}'],
      { sdkOptions: { mcpConfig: ['D:\\mcp.json', '{"mcpServers":{}}'] } },
    ],
    ['--betas', ['--betas', 'a-2026', 'b-2026'], { sdkOptions: { betas: ['a-2026', 'b-2026'] } }],
    [
      '--allowedTools narrow rules',
      ['--allowedTools', 'Bash(git status:*) Read(./docs/**)', 'mcp__github__get_issue'],
      { sdkOptions: { allowedTools: ['Bash(git status:*)', 'Read(./docs/**)', 'mcp__github__get_issue'] } },
    ],
    [
      '--allowed-tools comma list',
      ['--allowed-tools', 'Bash(npm run test),Bash(git diff:*)'],
      { sdkOptions: { allowedTools: ['Bash(npm run test)', 'Bash(git diff:*)'] } },
    ],
    [
      '--disallowedTools (never a warning)',
      ['--disallowedTools', 'Bash', 'WebFetch'],
      { sdkOptions: { disallowedTools: ['Bash', 'WebFetch'] } },
    ],
    ['--disallowed-tools', ['--disallowed-tools=Write'], { sdkOptions: { disallowedTools: ['Write'] } }],
    [
      'everything together',
      ['--model', 'haiku', '--add-dir', 'D:\\a', '--disallowedTools', 'WebFetch', '--betas', 'x'],
      {
        sdkOptions: {
          model: 'haiku',
          additionalDirectories: ['D:\\a'],
          disallowedTools: ['WebFetch'],
          betas: ['x'],
        },
      },
    ],
  ])('%s', (_name, args, expected) => {
    expect(parse(args, false)).toEqual(result(expected));
    // Mapped flags behave the same with "pass raw".
    expect(parse(args, true)).toEqual(result(expected));
  });
});

describe('parseProfileArgs: bypass (C.3)', () => {
  it.each(['--dangerously-skip-permissions', '--allow-dangerously-skip-permissions'])(
    '%s → allowDangerouslySkipPermissions + warning, never extraArgs',
    (flag) => {
      for (const passRaw of [false, true]) {
        expect(parse([flag], passRaw)).toEqual(
          result({
            allowDangerouslySkipPermissions: true,
            warnings: [err('PROFILE_BYPASS_ENABLED', 0, flag)],
          }),
        );
      }
    },
  );

  it('--permission-mode bypassPermissions also allows bypass', () => {
    expect(parse(['--permission-mode', 'bypassPermissions'], false)).toEqual(
      result({
        sdkOptions: { permissionMode: 'bypassPermissions' },
        allowDangerouslySkipPermissions: true,
        warnings: [err('PROFILE_BYPASS_ENABLED', 0, '--permission-mode')],
      }),
    );
  });

  it('both bypass flags are fine; one flag twice is a duplicate', () => {
    expect(
      parse(['--dangerously-skip-permissions', '--allow-dangerously-skip-permissions'], false).errors,
    ).toEqual([]);
    expect(parse(['--dangerously-skip-permissions', '--dangerously-skip-permissions'], false).errors).toEqual(
      [invalid(1, '--dangerously-skip-permissions', 'duplicate')],
    );
  });

  it('a bypass flag takes no value', () => {
    expect(parse(['--dangerously-skip-permissions=true'], false)).toEqual(
      result({ errors: [invalid(0, '--dangerously-skip-permissions', 'unexpected_value')] }),
    );
  });
});

describe('parseProfileArgs: blocked flags (Plan + C.12)', () => {
  const blocked = [
    ...BLOCKED_PROFILE_FLAGS,
    '--system-prompt',
    '--system-prompt-file',
    '--RESUME',
    '--Continue',
    '-P',
    '-pc',
    '-cw',
  ];

  it('blocks exactly the documented list', () => {
    expect(BLOCKED_PROFILE_FLAGS).toEqual([
      '-p',
      '--print',
      '--output-format',
      '--input-format',
      '-r',
      '--resume',
      '-c',
      '--continue',
      '--permission-prompt-tool',
      '--replay-user-messages',
      '--session-id',
      '--fork-session',
      '--setting-sources',
      '--max-turns',
      '--json-schema',
      '--resume-session-at',
      '-w',
      '--worktree',
      '--remote',
      '--teleport',
      '--sdk-url',
      '-h',
      '--help',
      '-v',
      '--version',
    ]);
  });

  it.each(blocked)('%s is blocked, also with pass raw', (flag) => {
    for (const passRaw of [false, true]) {
      expect(parse([flag], passRaw)).toEqual(result({ errors: [err('PROFILE_ARG_BLOCKED', 0, flag)] }));
    }
  });

  it.each([
    ['--output-format=json', '--output-format'],
    ['--resume=abc', '--resume'],
    ['--system-prompt=You are …', '--system-prompt'],
  ])('%s is blocked (flag %s)', (arg, flag) => {
    expect(parse([arg], true).errors).toEqual([err('PROFILE_ARG_BLOCKED', 0, flag)]);
  });

  it('consumes the value of a blocked flag (no follow-up error)', () => {
    expect(parse(['--resume', 'abc', '--model', 'haiku'], false)).toEqual(
      result({ sdkOptions: { model: 'haiku' }, errors: [err('PROFILE_ARG_BLOCKED', 0, '--resume')] }),
    );
  });

  it('does not block similar allowed flags', () => {
    expect(parse(['--append-system-prompt', 'x'], false).errors).toEqual([]);
    expect(parse(['--resumes'], true).errors).toEqual([]);
  });
});

describe('parseProfileArgs: unknown flags and "pass raw"', () => {
  it.each<[string[], Record<string, string | null>]>([
    [['--verbose'], { verbose: null }],
    [['--fallback-model', 'haiku'], { 'fallback-model': 'haiku' }],
    [['--foo=bar'], { foo: 'bar' }],
    [['--foo='], { foo: '' }],
    [['--strict-mcp-config', '--agents', '{"a":{}}'], { 'strict-mcp-config': null, agents: '{"a":{}}' }],
  ])('passRaw: %j → extraArgs %j (info PASSED_RAW)', (args, extraArgs) => {
    const parsed = parse(args, true);
    expect(parsed.extraArgs).toEqual(extraArgs);
    expect(parsed.errors).toEqual([]);
    expect(parsed.warnings.map((warning) => warning.code)).toEqual(
      Object.keys(extraArgs).map(() => 'PROFILE_ARG_PASSED_RAW'),
    );
  });

  it('without pass raw an unknown flag is not allowed (and its value is consumed)', () => {
    expect(parse(['--fallback-model', 'haiku', '--verbose'], false)).toEqual(
      result({
        errors: [
          err('PROFILE_ARG_NOT_ALLOWED', 0, '--fallback-model'),
          err('PROFILE_ARG_NOT_ALLOWED', 2, '--verbose'),
        ],
      }),
    );
  });

  it('a raw flag may appear once (extraArgs is a record, C.12)', () => {
    expect(parse(['--foo', 'a', '--foo', 'b'], true)).toEqual(
      result({
        extraArgs: { foo: 'a' },
        warnings: [err('PROFILE_ARG_PASSED_RAW', 0, '--foo')],
        errors: [invalid(2, '--foo', 'duplicate')],
      }),
    );
  });

  it('short unknown flags cannot be passed raw', () => {
    expect(parse(['-x'], true)).toEqual(result({ errors: [err('PROFILE_ARG_NOT_ALLOWED', 0, '-x')] }));
    expect(parse(['-x'], false)).toEqual(result({ errors: [err('PROFILE_ARG_NOT_ALLOWED', 0, '-x')] }));
  });

  it('a malformed long flag is not a flag', () => {
    expect(parse(['--foo.bar'], true)).toEqual(result({ errors: [invalid(0, '--foo.bar', 'not_a_flag')] }));
    expect(parse(['--=x'], true)).toEqual(result({ errors: [invalid(0, '--', 'not_a_flag')] }));
  });

  it('a raw flag takes at most one value', () => {
    expect(parse(['--foo', 'a', 'b'], true)).toEqual(
      result({
        extraArgs: { foo: 'a' },
        warnings: [err('PROFILE_ARG_PASSED_RAW', 0, '--foo')],
        errors: [invalid(2, 'b', 'not_a_flag')],
      }),
    );
  });
});

describe('parseProfileArgs: invalid input', () => {
  it.each<[string[], ReturnType<typeof invalid>[]]>([
    [['plain'], [invalid(0, 'plain', 'not_a_flag')]],
    [[''], [invalid(0, '', 'not_a_flag')]],
    [['-'], [invalid(0, '-', 'not_a_flag')]],
    [['--'], [invalid(0, '--', 'not_a_flag')]],
    [[`x${'y'.repeat(100)}`], [invalid(0, `x${'y'.repeat(39)}`, 'not_a_flag')]],
    [['--model'], [invalid(0, '--model', 'missing_value')]],
    [['--model='], [invalid(0, '--model', 'missing_value')]],
    [['--model', '   '], [invalid(0, '--model', 'missing_value')]],
    [['--model=-bad'], [invalid(0, '--model', 'invalid_value')]],
    [['--model', 'has space'], [invalid(0, '--model', 'invalid_value')]],
    [['--model', 'a', '--model', 'b'], [invalid(2, '--model', 'duplicate')]],
    [['--permission-mode', 'yolo'], [invalid(0, '--permission-mode', 'invalid_value')]],
    [
      ['--permission-mode', 'default', '--permission-mode=plan'],
      [invalid(2, '--permission-mode', 'duplicate')],
    ],
    [['--settings', 'a', '--settings', 'b'], [invalid(2, '--settings', 'duplicate')]],
    [['--add-dir'], [invalid(0, '--add-dir', 'missing_value')]],
    [['--add-dir', '\\\\server\\share'], [invalid(0, '--add-dir', 'invalid_value')]],
    [['--add-dir', 'relative\\dir'], [invalid(0, '--add-dir', 'invalid_value')]],
    [['--plugin-dir', 'C:\\p:ads'], [invalid(0, '--plugin-dir', 'invalid_value')]],
    [['--allowedTools', ' , '], [invalid(0, '--allowedTools', 'missing_value')]],
    [['--settings', 'a\0b'], [invalid(0, '--settings', 'invalid_value')]],
  ])('%j', (args, errors) => {
    expect(parse(args, false).errors).toEqual(errors);
  });

  it('a missing value does not swallow the next flag', () => {
    expect(parse(['--model', '--add-dir', 'D:\\a'], false)).toEqual(
      result({
        sdkOptions: { additionalDirectories: ['D:\\a'] },
        errors: [invalid(0, '--model', 'missing_value')],
      }),
    );
  });

  it('reports every issue with the index of its flag', () => {
    const parsed = parse(['--model', 'haiku', 'stray', '--resume', 'x', '--bogus', '--add-dir'], false);
    expect(parsed.errors).toEqual([
      invalid(2, 'stray', 'not_a_flag'),
      err('PROFILE_ARG_BLOCKED', 3, '--resume'),
      err('PROFILE_ARG_NOT_ALLOWED', 5, '--bogus'),
      invalid(6, '--add-dir', 'missing_value'),
    ]);
    expect(parsed.sdkOptions).toEqual({ model: 'haiku' });
  });
});

describe('blanket --allowedTools (C.12 warning)', () => {
  it('warns once per broad entry with its value', () => {
    expect(
      parse(['--allowedTools', 'Bash Edit(src/**) Write', '--allowed-tools=mcp__github'], false),
    ).toEqual(
      result({
        sdkOptions: { allowedTools: ['Bash', 'Edit(src/**)', 'Write', 'mcp__github'] },
        warnings: [
          err('PROFILE_ARG_BROAD_ALLOWED_TOOLS', 0, '--allowedTools', { value: 'Bash' }),
          err('PROFILE_ARG_BROAD_ALLOWED_TOOLS', 0, '--allowedTools', { value: 'Write' }),
          err('PROFILE_ARG_BROAD_ALLOWED_TOOLS', 2, '--allowed-tools', { value: 'mcp__github' }),
        ],
      }),
    );
  });

  it.each([
    ['*', true],
    ['Bash', true],
    ['Edit', true],
    ['Read', true],
    ['Bash(*)', true],
    ['Bash(:*)', true],
    ['Bash()', true],
    ['Edit(**)', true],
    ['mcp__github', true],
    ['mcp__github__*', true],
    ['Bash(git status:*)', false],
    ['Bash(npm run test)', false],
    ['Read(./docs/**)', false],
    ['WebFetch(domain:example.com)', false],
    ['mcp__github__get_issue', false],
  ])('isBroadToolRule(%s) = %s', (rule, broad) => {
    expect(isBroadToolRule(rule)).toBe(broad);
  });
});

describe('splitToolList', () => {
  it.each<[string, string[]]>([
    ['Bash Edit', ['Bash', 'Edit']],
    ['Bash,Edit', ['Bash', 'Edit']],
    ['Bash, Edit ,Write', ['Bash', 'Edit', 'Write']],
    ['Bash(npm run test) Edit', ['Bash(npm run test)', 'Edit']],
    ['Bash(a, b),Read(x y)', ['Bash(a, b)', 'Read(x y)']],
    ['  ', []],
    ['', []],
  ])('%j', (value, tools) => {
    expect(splitToolList(value)).toEqual(tools);
  });
});
