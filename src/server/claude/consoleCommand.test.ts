import { describe, expect, it } from 'vitest';
import { SAMPLE_IDS } from '@shared/samples';
import {
  consoleCommandFor,
  consoleCommandText,
  nativeCommandArg,
  posixConsoleCommandText,
  posixSecretPrompt,
  posixShellWord,
  powerShellEnvVariable,
  powerShellLiteral,
  secretPrompt,
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
    const text = consoleCommandText(spec({ explicitEnv: { API_BASE: 'https://gw.example.invalid' } }));
    expect(text).toContain(`$env:API_BASE='https://gw.example.invalid'`);
    expect(text).not.toContain('do-not-copy');
    expect(text).not.toContain('PARALLAX');
    expect(text).not.toContain('C:\\Windows');
  });

  it('ADR-123 (R4W-08): secret names get a hidden prompt instead of their value', () => {
    const text = consoleCommandText(
      spec({
        explicitEnv: {
          GATEWAY_TOKEN: 'x-secret-gateway-1',
          AWS_BEARER_TOKEN_BEDROCK: 'x-secret-bedrock-2',
          ANTHROPIC_CUSTOM_HEADERS: 'Authorization: x-secret-header-3',
          ANTHROPIC_BASE_URL: 'https://gw.example.invalid',
        },
      }),
    );
    for (const value of ['x-secret-gateway-1', 'x-secret-bedrock-2', 'x-secret-header-3']) {
      expect(text).not.toContain(value);
    }
    expect(text).toContain(
      `$env:GATEWAY_TOKEN=[Net.NetworkCredential]::new('', (Read-Host 'GATEWAY_TOKEN' -AsSecureString)).Password; `,
    );
    expect(text).toContain(`$env:AWS_BEARER_TOKEN_BEDROCK=${secretPrompt('AWS_BEARER_TOKEN_BEDROCK')}`);
    expect(text).toContain(`$env:ANTHROPIC_CUSTOM_HEADERS=${secretPrompt('ANTHROPIC_CUSTOM_HEADERS')}`);
    // Other values stay in the line; the prompt label is a literal (no injection through a name).
    expect(text).toContain(`$env:ANTHROPIC_BASE_URL='https://gw.example.invalid'`);
    expect(secretPrompt("A_TOKEN'; calc; '")).toContain(`Read-Host 'A_TOKEN''; calc; ''' -AsSecureString`);
    expect(text).not.toMatch(/[\r\n]/);
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

// ---- POSIX hosts (WP-106) ----

describe('posixShellWord', () => {
  it.each<[string, string]>([
    ['plain', 'plain'],
    ['--resume', '--resume'],
    ['/home/demo/.local/bin/claude', '/home/demo/.local/bin/claude'],
    ['--settings=x', '--settings=x'],
    ['with space', `'with space'`],
    ["it's", `'it'\\''s'`],
    ['$HOME and $(id) `id`', `'$HOME and $(id) \`id\`'`],
    ['~/x', `'~/x'`],
    ['=cmd', `'=cmd'`],
    ['a*b?[c]', `'a*b?[c]'`],
    ['{"autoCompactWindow":200000}', `'{"autoCompactWindow":200000}'`],
    ['Grüße', `'Grüße'`],
    ['', `''`],
    // Control characters: $'…' so the line stays one line.
    ['a\nb', `$'a\\nb'`],
    ["tab\there 'q' \\", `$'tab\\there \\'q\\' \\\\'`],
    ['bell\u0007', `$'bell\\x07'`],
  ])('%j → %s', (text, word) => {
    expect(posixShellWord(text)).toBe(word);
  });
});

describe('posixConsoleCommandText (WP-106)', () => {
  const CLAUDE = '/home/demo/.local/bin/claude';
  const spec = (p: Partial<ConsoleLaunchSpec> = {}): ConsoleLaunchSpec => ({
    executablePath: CLAUDE,
    args: ['--resume', SAMPLE_IDS.sessionId],
    env: {
      PATH: '/usr/bin',
      SECRET_ONLY_IN_ENV: 'do-not-copy',
      PARALLAX: '1',
      PARALLAX_ENTRY_ID: SAMPLE_IDS.entry,
    },
    explicitEnv: {},
    cwd: '/home/demo/work',
    ...p,
  });

  it('cd, the Parallax markers, the explicit env, then the program with every argument quoted', () => {
    const text = posixConsoleCommandText(
      spec({
        args: [
          '--add-dir',
          '/home/demo/shared dir',
          '--resume',
          SAMPLE_IDS.sessionId,
          '--settings',
          '{"a":1}',
        ],
        explicitEnv: {
          ANTHROPIC_BASE_URL: 'https://gateway.example.invalid',
          CLAUDE_CONFIG_DIR: "/home/demo/.claude 'work'",
        },
        cwd: "/home/demo/it's $here",
      }),
    );
    expect(text).toBe(
      `cd -- '/home/demo/it'\\''s $here' && PARALLAX=1 PARALLAX_ENTRY_ID=${SAMPLE_IDS.entry} ` +
        `ANTHROPIC_BASE_URL=https://gateway.example.invalid CLAUDE_CONFIG_DIR='/home/demo/.claude '\\''work'\\''' ` +
        `${CLAUDE} --add-dir '/home/demo/shared dir' --resume ${SAMPLE_IDS.sessionId} --settings '{"a":1}'`,
    );
    // Machine env stays out.
    expect(text).not.toContain('do-not-copy');
    expect(text).not.toContain('PATH=');
  });

  it('ADR-123: secret names are read hidden from the terminal, never copied', () => {
    const text = posixConsoleCommandText(
      spec({
        explicitEnv: {
          GATEWAY_TOKEN: 'x-secret-gateway-1',
          ANTHROPIC_BASE_URL: 'https://gw.example.invalid',
        },
      }),
    );
    expect(text).not.toContain('x-secret-gateway-1');
    expect(text).toContain(`GATEWAY_TOKEN=${posixSecretPrompt('GATEWAY_TOKEN')} `);
    expect(posixSecretPrompt('GATEWAY_TOKEN')).toBe(
      `"$(stty -echo; printf '%s: ' GATEWAY_TOKEN >/dev/tty; IFS= read -r v; stty echo; printf '\\n' >/dev/tty; printf '%s' "$v")"`,
    );
    // The prompt label is one quoted word (no injection through a name).
    expect(posixSecretPrompt("A_TOKEN'; id; '")).toContain(
      `printf '%s: ' 'A_TOKEN'\\''; id; '\\''' >/dev/tty`,
    );
    expect(text).toContain('ANTHROPIC_BASE_URL=https://gw.example.invalid');
    expect(text).not.toMatch(/[\r\n]/);
  });

  it('names that are no shell identifier go through env --; markers are not doubled', () => {
    const text = posixConsoleCommandText(
      spec({ explicitEnv: { 'MY-VAR': 'a b', PARALLAX: 'x', OK_NAME: '1', 'MY-TOKEN': 'x-secret-3' } }),
    );
    expect(text).toBe(
      `cd -- /home/demo/work && PARALLAX=1 PARALLAX_ENTRY_ID=${SAMPLE_IDS.entry} OK_NAME=1 ` +
        `env -- MY-VAR='a b' MY-TOKEN=${posixSecretPrompt('MY-TOKEN')} ${CLAUDE} --resume ${SAMPLE_IDS.sessionId}`,
    );
    expect(text).not.toContain('x-secret-3');
  });

  it('stays one line; a spec without markers (no entry) has none', () => {
    const text = posixConsoleCommandText(
      spec({ args: ['--append-system-prompt', 'line 1\nline 2'], explicitEnv: { NOTE: 'a\r\nb' }, env: {} }),
    );
    expect(text).not.toMatch(/[\r\n]/);
    expect(text).toBe(
      `cd -- /home/demo/work && NOTE=$'a\\r\\nb' ${CLAUDE} --append-system-prompt $'line 1\\nline 2'`,
    );
  });

  it('consoleCommandFor: PowerShell on Windows, the POSIX line elsewhere', () => {
    const windows: ConsoleLaunchSpec = { ...spec(), executablePath: EXE, cwd: 'D:\\work' };
    expect(consoleCommandFor(windows, 'win32')).toBe(consoleCommandText(windows));
    expect(consoleCommandFor(spec(), 'linux')).toBe(posixConsoleCommandText(spec()));
    expect(consoleCommandFor(spec(), 'darwin')).toBe(posixConsoleCommandText(spec()));
  });
});
