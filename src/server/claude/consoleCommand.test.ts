import { describe, expect, it } from 'vitest';
import { SAMPLE_IDS } from '@shared/samples';
import {
  consoleCommandText,
  nativeCommandArg,
  powerShellEnvVariable,
  powerShellLiteral,
} from './consoleCommand';
import type { ConsoleLaunchSpec } from './ports';

const EXE = String.raw`C:\Users\u\.local\bin\claude.exe`;

describe('powerShellLiteral', () => {
  it.each<[string, string]>([
    ['plain', `'plain'`],
    ['with space', `'with space'`],
    ["it's", `'it''s'`],
    ['$HOME and $(calc)', `'$HOME and $(calc)'`],
    ['`n backtick', "'`n backtick'"],
    ['Ümläut ß €', `'Ümläut ß €'`],
    ['', `''`],
    ['"double"', `'"double"'`],
    // PowerShell treats ‘ ’ ‚ ‛ as single quotes as well.
    ['smart’quote ‘x’ ‚y‛', `'smart’’quote ‘‘x’’ ‚‚y‛‛'`],
    // A line break: double-quoted with backtick escapes, so the command stays one line.
    ['a\nb', '"a`nb"'],
    ['x $y `z "q" “r” „s\r\n', '"x `$y ``z `"q`" `“r`” `„s`r`n"'],
  ])('%j → %s', (text, literal) => {
    expect(powerShellLiteral(text)).toBe(literal);
  });
});

describe('powerShellEnvVariable', () => {
  it.each<[string, string]>([
    ['ANTHROPIC_API_KEY', '$env:ANTHROPIC_API_KEY'],
    ['_x1', '$env:_x1'],
    ['ProgramFiles(x86)', '${env:ProgramFiles(x86)}'],
    ['MY-VAR', '${env:MY-VAR}'],
    ['1ST', '${env:1ST}'],
    ['a{b}`c', '${env:a`{b`}``c}'],
  ])('%s → %s', (name, variable) => {
    expect(powerShellEnvVariable(name)).toBe(variable);
  });
});

describe('nativeCommandArg (MSVC quoting under legacy argument passing)', () => {
  it.each<[string, string]>([
    ['--resume', '--resume'],
    [SAMPLE_IDS.sessionId, SAMPLE_IDS.sessionId],
    ['with space', '"with space"'],
    ['', '""'],
    ['--%', '"--%"'],
    ['{"autoCompactWindow":200000}', String.raw`"{\"autoCompactWindow\":200000}"`],
    ['C:\\x\\', 'C:\\x\\'],
    // Trailing backslashes before the closing quote are doubled.
    ['C:\\a b\\', '"C:\\a b\\\\"'],
    [String.raw`a\"b`, String.raw`"a\\\"b"`],
    ['Antworte mit „Ja oder Nein“', '"Antworte mit „Ja oder Nein“"'],
    ['multi\nline', '"multi\nline"'],
    // A whitespace after an odd number of `"`: PowerShell adds the surrounding quotes itself.
    ['a " b', String.raw`a \" b`],
    ['{"a": "b c"}', String.raw`{\"a\": \"b c\"}`],
  ])('%j → %s', (arg, native) => {
    expect(nativeCommandArg(arg)).toBe(native);
  });
});

describe('consoleCommandText', () => {
  const spec = (p: Partial<ConsoleLaunchSpec> = {}): ConsoleLaunchSpec => ({
    executablePath: EXE,
    args: ['--resume', SAMPLE_IDS.sessionId],
    env: { Path: 'C:\\Windows', SECRET_ONLY_IN_ENV: 'do-not-copy', PARALLAX: '1' },
    explicitEnv: {},
    cwd: 'D:\\work',
    ...p,
  });

  it('sets the location, the explicit env, then calls the exe with every argument quoted', () => {
    const text = consoleCommandText(
      spec({
        args: [
          '--add-dir',
          'D:\\shared dir',
          '--resume',
          SAMPLE_IDS.sessionId,
          '--settings',
          '{"autoCompactWindow":200000}',
        ],
        explicitEnv: {
          ANTHROPIC_BASE_URL: 'https://gateway.example.invalid',
          'ProgramFiles(x86)': 'C:\\x',
          CLAUDE_CONFIG_DIR: "C:\\Users\\u\\.claude 'work'",
        },
        cwd: "D:\\work\\it's $here",
      }),
    );
    expect(text).toBe(
      String.raw`Set-Location -LiteralPath 'D:\work\it''s $here'; ` +
        String.raw`$env:ANTHROPIC_BASE_URL='https://gateway.example.invalid'; ` +
        String.raw`${'$'}{env:ProgramFiles(x86)}='C:\x'; ` +
        String.raw`$env:CLAUDE_CONFIG_DIR='C:\Users\u\.claude ''work'''; ` +
        String.raw`& { $PSNativeCommandArgumentPassing='Legacy'; & '${EXE}' '--add-dir' '"D:\shared dir"' ` +
        `'--resume' '${SAMPLE_IDS.sessionId}' '--settings' ` +
        String.raw`'"{\"autoCompactWindow\":200000}"' }`,
    );
  });

  it('only copies the explicit env (no machine env, no Parallax markers)', () => {
    const text = consoleCommandText(spec({ explicitEnv: { API_TOKEN: 'secret-value' } }));
    expect(text).toContain(`$env:API_TOKEN='secret-value'`);
    expect(text).not.toContain('do-not-copy');
    expect(text).not.toContain('PARALLAX');
    expect(text).not.toContain('C:\\Windows');
  });

  it.each<[string, string[], string]>([
    ['spaces', ['--append-system-prompt=be brief'], `'"--append-system-prompt=be brief"'`],
    ['single quotes', ["--append-system-prompt=it's"], `'--append-system-prompt=it''s'`],
    ['dollar', ['--model', '$model'], `'--model' '$model'`],
    ['backtick', ['--x=`n'], "'--x=`n'"],
    ['umlauts', ['--append-system-prompt=Grüße'], `'--append-system-prompt=Grüße'`],
    ['empty args', ['--append-system-prompt', ''], `'--append-system-prompt' '""'`],
  ])('quotes %s', (_name, args, expected) => {
    expect(consoleCommandText(spec({ args }))).toBe(
      `Set-Location -LiteralPath 'D:\\work'; & { $PSNativeCommandArgumentPassing='Legacy'; & '${EXE}' ${expected} }`,
    );
  });

  it('stays one line for values and arguments with line breaks', () => {
    const text = consoleCommandText(
      spec({
        args: ['--append-system-prompt', 'line 1\nline 2'],
        explicitEnv: { NOTE: 'a\r\nb' },
        cwd: 'D:\\w',
      }),
    );
    expect(text).not.toMatch(/[\r\n]/);
    expect(text).toContain('$env:NOTE="a`r`nb"');
    expect(text).toContain(`"\`"line 1\`nline 2\`""`);
  });
});
