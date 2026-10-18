/**
 * Windows command lines (WP-33, ADR-104/109/110): one string that `CommandLineToArgvW` (and the
 * MSVC CRT, which agree on everything produced here) splits back into exactly `args`. Used where a
 * whole command line travels as ONE value – `Start-Process -ArgumentList <line>` (console),
 * `WshShortcut.Arguments` (autostart) and the `shell\open\command` of the protocol handler – never
 * for a shell: nothing here protects against cmd.exe metacharacters (`&`, `|`, `%`, `^`).
 *
 * Rules (MS docs "Parsing C++ command-line arguments"): an argument is quoted when it is empty or
 * contains a space, tab, newline, vertical tab or `"`; inside quotes, backslashes are literal
 * unless they precede a `"` – then each is doubled and the quote is escaped as `\"`; trailing
 * backslashes before the closing quote are doubled.
 */

const NEEDS_QUOTES = /[ \t\n\v"]/;

/**
 * The inside of a quoted argument (the quotes themselves are not added): `"` → `\"` with the
 * backslashes before it doubled, trailing backslashes doubled (a closing quote follows). Also the
 * base of the console copy command (claude/consoleCommand.ts, R4-14).
 */
export function quotedArgBody(arg: string): string {
  let out = '';
  let backslashes = 0;
  for (const ch of arg) {
    if (ch === '\\') {
      backslashes += 1;
      continue;
    }
    if (ch === '"') {
      out += `${'\\'.repeat(backslashes * 2 + 1)}"`;
    } else {
      out += `${'\\'.repeat(backslashes)}${ch}`;
    }
    backslashes = 0;
  }
  return `${out}${'\\'.repeat(backslashes * 2)}`;
}

/** One argument, quoted only when needed. */
export function quoteWindowsArg(arg: string): string {
  if (arg !== '' && !NEEDS_QUOTES.test(arg)) return arg;
  return `"${quotedArgBody(arg)}"`;
}

/** `args` joined into one command line (`CommandLineToArgvW` rules, see the file comment). */
export function windowsCommandLine(args: readonly string[]): string {
  return args.map(quoteWindowsArg).join(' ');
}
