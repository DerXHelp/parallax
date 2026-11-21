/**
 * "Copy console command" (ADR-104 fallback; pure, table-tested): one PowerShell line that runs
 * `claude --resume <id>` like the external console –
 *
 *   Set-Location -LiteralPath '<cwd>'; $env:NAME='<value>'; …; & { $PSNativeCommandArgumentPassing='Legacy'; & '<exe>' '<arg>' … }
 *
 * ADR-123: a variable with a secret name (`isSecretEnvKey`, ADR-124) gets no value in the line but a
 * hidden prompt (`Read-Host -AsSecureString`) – the copied text never carries profile secrets.
 *
 * PowerShell literals are single-quoted with every quote character doubled (PowerShell also treats
 * ‘ ’ ‚ ‛ as single quotes); a value with a line break becomes a double-quoted literal with
 * backtick escapes so the command stays one line.
 *
 * Arguments of a native command are re-joined into a Windows command line by PowerShell. Windows
 * PowerShell 5.1 ("Legacy") passes an empty string as nothing and embedded `"` unescaped; 7.3+
 * ("Standard") escapes them itself. The line therefore pins `Legacy` inside a script block (no
 * lasting change of the user's session; a plain variable in 5.1) and passes each argument already
 * quoted by the MSVC rules (CommandLineToArgvW) – verified with Windows PowerShell 5.1 for spaces,
 * `'`, `$`, `` ` ``, umlauts, empty arguments, JSON, trailing backslashes and line breaks.
 * Known limit (5.1 only): an argument in which EVERY whitespace follows an odd number of `"`
 * (e.g. `"a b"` with its quotes) is re-quoted by PowerShell and arrives split – the external
 * console itself (WP-33, Start-Process with a complete command line) is not affected.
 *
 * POSIX hosts (WP-106, WP-100 §5.5): one line for sh, bash and zsh (`posixConsoleCommandText`) –
 *
 *   cd -- '<cwd>' && PARALLAX=1 PARALLAX_ENTRY_ID=<id> NAME='<value>' … '<exe>' '<arg>' …
 *
 * like the console the terminal emulator opens (`PARALLAX=1` and the entry id of the spec, then the
 * profile's explicit env). Words are single-quoted (`'` as `'\''`) unless they are plain; a word with
 * a control character (line break, tab …) becomes `$'…'` so the line stays one line. A name that is
 * no shell identifier goes through `env -- 'NAME=value'`. Secret names (ADR-123) are read hidden
 * from the terminal when the line runs (`stty -echo`, `read -r`) – never part of the copied text.
 * `consoleCommandFor` picks the line of the host's platform.
 */
import { isSecretEnvKey } from '@shared/secrets';
import { quotedArgBody } from '../lib/cmdline';
import type { ConsoleLaunchSpec } from './ports';

const SIMPLE_ENV_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;

/** A PowerShell string literal with exactly the value `text`. */
export function powerShellLiteral(text: string): string {
  if (/[\r\n]/.test(text)) {
    const escaped = text
      .replace(/[`$"“”„]/g, (char) => `\`${char}`)
      .replace(/\r/g, '`r')
      .replace(/\n/g, '`n');
    return `"${escaped}"`;
  }
  return `'${text.replace(/['‘’‚‛]/g, (char) => char + char)}'`;
}

/** `$env:NAME` or, for other names (`ProgramFiles(x86)`, `A-B` …), `${env:NAME}` with escapes. */
export function powerShellEnvVariable(name: string): string {
  if (SIMPLE_ENV_NAME.test(name)) return `$env:${name}`;
  return `\${env:${name.replace(/[`{}]/g, (char) => `\`${char}`)}}`;
}

/**
 * ADR-123: the value of a secret variable is asked for, hidden, when the line runs – it never
 * travels in the copied text (clipboard history, sync). Works in Windows PowerShell 5.1 and 7.
 */
export function secretPrompt(name: string): string {
  return `[Net.NetworkCredential]::new('', (Read-Host ${powerShellLiteral(name)} -AsSecureString)).Password`;
}

/** For every whitespace of `arg`: is the number of `"` before it even? */
function quoteParityAtWhitespace(arg: string): boolean[] {
  const parity: boolean[] = [];
  let quotes = 0;
  for (const char of arg) {
    if (char === '"') quotes += 1;
    else if (/\s/.test(char)) parity.push(quotes % 2 === 0);
  }
  return parity;
}

/**
 * The argument string to hand to PowerShell (legacy passing) so that the native program receives
 * exactly `arg`. Legacy PowerShell wraps an argument in `"…"` itself when a whitespace follows an
 * even number of `"` (5.1 counts every `"`, 7.x only unescaped ones).
 */
export function nativeCommandArg(arg: string): string {
  // `--%` alone is PowerShell's stop-parsing token even when quoted: quote it for the program.
  if (arg !== '' && arg !== '--%' && !/[\s"]/.test(arg)) return arg;
  const body = quotedArgBody(arg);
  const parity = quoteParityAtWhitespace(arg);
  // Every whitespace after an even number of `"` (or none at all): PowerShell keeps `"…"` as is.
  if (parity.every((even) => even)) return `"${body}"`;
  // Otherwise PowerShell adds the surrounding quotes itself (5.1: if one whitespace follows an
  // even count – else the known limit above; 7.x: always, escaped quotes are not counted).
  return body;
}

/**
 * One PowerShell line: cwd, the profile's explicit env (secret names as a hidden prompt, ADR-123),
 * then `& '<exe>' <args>` (see module comment).
 */
export function consoleCommandText(spec: ConsoleLaunchSpec): string {
  const parts = [`Set-Location -LiteralPath ${powerShellLiteral(spec.cwd)}`];
  for (const [name, value] of Object.entries(spec.explicitEnv)) {
    const assigned = isSecretEnvKey(name) ? secretPrompt(name) : powerShellLiteral(value);
    parts.push(`${powerShellEnvVariable(name)}=${assigned}`);
  }
  const call = [
    powerShellLiteral(spec.executablePath),
    ...spec.args.map((arg) => powerShellLiteral(nativeCommandArg(arg))),
  ];
  parts.push(`& { $PSNativeCommandArgumentPassing='Legacy'; & ${call.join(' ')} }`);
  return parts.join('; ');
}

// ---- POSIX shells (WP-106) ----

/** Characters that never need quoting in sh, bash or zsh (a leading `=` would be zsh's `=cmd`). */
const PLAIN_POSIX_WORD = /^[A-Za-z0-9_@%+:,./-][A-Za-z0-9_@%+:,./=-]*$/;
// eslint-disable-next-line no-control-regex -- control characters are exactly what is searched for
const POSIX_CONTROL = /[\u0000-\u001f\u007f]/;
const POSIX_ESCAPES: Readonly<Record<string, string>> = { '\n': '\\n', '\r': '\\r', '\t': '\\t' };

/** One shell word with exactly the value `text` (see the module comment). */
export function posixShellWord(text: string): string {
  if (PLAIN_POSIX_WORD.test(text)) return text;
  if (!POSIX_CONTROL.test(text)) return `'${text.replace(/'/g, `'\\''`)}'`;
  let body = '';
  for (const char of text) {
    if (char === '\\' || char === "'") body += `\\${char}`;
    else if (POSIX_CONTROL.test(char)) {
      body += POSIX_ESCAPES[char] ?? `\\x${char.charCodeAt(0).toString(16).padStart(2, '0')}`;
    } else body += char;
  }
  return `$'${body}'`;
}

/**
 * ADR-123 on POSIX: the value of a secret variable, read hidden from the terminal when the line runs
 * (the prompt goes to `/dev/tty`; the substitution's output is the value).
 */
export function posixSecretPrompt(name: string): string {
  return (
    `"$(stty -echo; printf '%s: ' ${posixShellWord(name)} >/dev/tty; IFS= read -r v; ` +
    `stty echo; printf '\\n' >/dev/tty; printf '%s' "$v")"`
  );
}

/** The two Parallax markers of the console env (`PARALLAX=1`, `PARALLAX_ENTRY_ID`), in this order. */
const PARALLAX_MARKERS = ['PARALLAX', 'PARALLAX_ENTRY_ID'] as const;

/** One line for sh/bash/zsh: cwd, Parallax markers, the explicit env, then the program (see above). */
export function posixConsoleCommandText(spec: ConsoleLaunchSpec): string {
  const assignments: string[] = [];
  const envWords: string[] = [];
  const add = (name: string, value: string, secret: boolean): void => {
    const assigned = secret ? posixSecretPrompt(name) : posixShellWord(value);
    if (SIMPLE_ENV_NAME.test(name)) assignments.push(`${name}=${assigned}`);
    else envWords.push(`${posixShellWord(`${name}=`)}${assigned}`);
  };
  for (const name of PARALLAX_MARKERS) {
    const value = spec.env[name];
    if (value !== undefined) add(name, value, false);
  }
  for (const [name, value] of Object.entries(spec.explicitEnv)) {
    if ((PARALLAX_MARKERS as readonly string[]).includes(name)) continue;
    add(name, value, isSecretEnvKey(name));
  }
  const words = [
    ...assignments,
    ...(envWords.length === 0 ? [] : ['env', '--', ...envWords]),
    posixShellWord(spec.executablePath),
    ...spec.args.map(posixShellWord),
  ];
  return `cd -- ${posixShellWord(spec.cwd)} && ${words.join(' ')}`;
}

/** The console line of a host platform: PowerShell on Windows, the POSIX line elsewhere. */
export function consoleCommandFor(spec: ConsoleLaunchSpec, platform: NodeJS.Platform): string {
  return platform === 'win32' ? consoleCommandText(spec) : posixConsoleCommandText(spec);
}
