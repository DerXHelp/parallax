/**
 * Fake pseudo console (WP-99) for tests, dev and E2E with the FakeBackend: starts NOTHING, behaves
 * like a tiny shell. The composition wires it instead of `conpty.ts` when the FakeBackend runs.
 *
 * - Prompt by the program's base name: `cmd.exe` → `<cwd>>`, `powershell.exe` → `PS <cwd>> `,
 *   `bash.exe` (and `bash`, `sh`, `zsh` of a Linux host) → `$ `, anything else `> `.
 * - Typed characters are echoed; Backspace/DEL removes the last one; escape sequences (arrow keys
 *   …) are ignored. Enter (`\r`) runs the line:
 *   - `echo X` → `X`
 *   - `exit [n]` → the shell ends with exit code n (default 0), no prompt afterwards
 *   - `flood N` → N lines `line 1` … `line N` (produced lazily while being read, at most 100 000)
 *   - `cls`/`clear` → `ESC[2J ESC[H`
 *   - anything else → one "not recognized" line
 * - `\x03` (Ctrl+C) → `^C`, a new line and the prompt.
 * - WP-111: a script run (`cmd.exe /d /s /c "<command>"` as `windowsCommandLine`, or `-c`/`-Command
 *   <command>` in the arguments, `fakeScriptCommand`) shows no prompt: the parts of the command (split
 *   at `&&`) run like typed lines, an unknown one ends it with exit code 1, the end with 0.
 * - `pid` is null; resizes and inputs are recorded for tests; `emit`/`exit` drive it from a test.
 */
import path from 'node:path';
import type { PtyFactory, PtyProcess, PtySpawnOptions } from './ports';

/** Most lines of one `flood`. */
export const FAKE_FLOOD_MAX_LINES = 100_000;
/** Lines of a flood are produced in blocks of about this size. */
const FLOOD_BLOCK_BYTES = 16 * 1024;
// eslint-disable-next-line no-control-regex -- ESC starts exactly the sequences that are dropped
const ESCAPE_SEQUENCE = /\x1b(?:\[[0-?]*[ -/]*[@-~]|O.|.)/gsu;

export interface FakePtyProcess extends PtyProcess {
  readonly options: PtySpawnOptions;
  /** Every `write` as passed. */
  readonly writes: readonly string[];
  readonly resizes: readonly (readonly [cols: number, rows: number])[];
  readonly closed: boolean;
  /** Queues output as if the shell wrote it. */
  emit(output: string | Uint8Array): void;
  /** Ends the shell with `code` (like `exit n`). */
  exit(code: number): void;
  /** Bytes queued and not read yet (a running flood counts as 1 until produced). */
  pendingBytes(): number;
}

export interface FakePtyFactory extends PtyFactory {
  /** Every started fake, oldest first. */
  readonly spawned: readonly FakePtyProcess[];
}

/** The prompt of a fake shell for `executablePath`. */
export function fakePrompt(executablePath: string, cwd: string): string {
  switch (path.win32.basename(executablePath).toLowerCase()) {
    case 'cmd.exe':
      return `${cwd}>`;
    case 'powershell.exe':
      return `PS ${cwd}> `;
    case 'bash.exe':
    case 'bash':
    case 'sh':
    case 'zsh':
      return '$ ';
    default:
      return '> ';
  }
}

/**
 * The command of a script run (WP-111, `TerminalService.runScript`), or null for an interactive shell:
 * the text after `/c` of a verbatim Windows command line (outer quotes removed), else the argument
 * after `-c`/`-Command`.
 */
export function fakeScriptCommand(
  options: Pick<PtySpawnOptions, 'args' | 'windowsCommandLine'>,
): string | null {
  const line = options.windowsCommandLine;
  if (line !== undefined) {
    const match = /\s\/c\s+(.*)$/isu.exec(line);
    if (match !== null) return (match[1] ?? '').replace(/^"(.*)"$/su, '$1');
  }
  const index = options.args.findIndex((arg) => arg === '-c' || arg === '-Command');
  return index < 0 ? null : (options.args[index + 1] ?? null);
}

interface Flood {
  next: number;
  last: number;
}

function createFakePty(options: PtySpawnOptions): FakePtyProcess {
  const prompt = fakePrompt(options.executablePath, options.cwd);
  const queue: (Uint8Array | Flood)[] = [];
  const writes: string[] = [];
  const resizes: (readonly [number, number])[] = [];
  let line = '';
  let code: number | null = null;
  let closed = false;

  const exited = (): boolean => code !== null;

  const out = (text: string): void => {
    if (text !== '') queue.push(Buffer.from(text, 'utf8'));
  };

  /** Runs one line; false = the command is unknown. */
  const run = (input: string): boolean => {
    const trimmed = input.trim();
    if (trimmed === '') return true;
    const name = trimmed.split(/\s/u, 1)[0] ?? '';
    const arg = trimmed.slice(name.length).trim();
    switch (name.toLowerCase()) {
      case 'echo':
        out(`${arg}\r\n`);
        return true;
      case 'exit': {
        const parsed = Number.parseInt(arg, 10);
        code = Number.isSafeInteger(parsed) ? parsed : 0;
        return true;
      }
      case 'flood': {
        const count = Number.parseInt(arg, 10);
        if (Number.isSafeInteger(count) && count > 0) {
          queue.push({ next: 1, last: Math.min(count, FAKE_FLOOD_MAX_LINES) });
        }
        return true;
      }
      case 'cls':
      case 'clear':
        out('\x1b[2J\x1b[H');
        return true;
      default:
        out(`'${name}' is not recognized as an internal or external command.\r\n`);
        return false;
    }
  };

  const key = (char: string): void => {
    if (exited()) return;
    switch (char) {
      case '\r':
        out('\r\n');
        run(line);
        line = '';
        if (!exited()) out(prompt);
        return;
      case '\x03':
        line = '';
        out(`^C\r\n${prompt}`);
        return;
      case '\x7f':
      case '\b': {
        if (line === '') return;
        const chars = Array.from(line);
        chars.pop();
        line = chars.join('');
        out('\b \b');
        return;
      }
      default:
        if ((char.codePointAt(0) ?? 0) < 0x20) return;
        line += char;
        out(char);
    }
  };

  /** Turns the flood at the head of the queue into its next block of lines. */
  const produce = (flood: Flood): void => {
    const lines: string[] = [];
    let size = 0;
    while (flood.next <= flood.last && size < FLOOD_BLOCK_BYTES) {
      const text = `line ${String(flood.next)}\r\n`;
      lines.push(text);
      size += text.length;
      flood.next += 1;
    }
    if (flood.next > flood.last) queue.shift();
    if (lines.length > 0) queue.unshift(Buffer.from(lines.join(''), 'utf8'));
  };

  const script = fakeScriptCommand(options);
  if (script === null) {
    out(prompt);
  } else {
    for (const part of script.split('&&')) {
      if (!run(part)) code = 1;
      if (exited()) break;
    }
    code ??= 0;
  }

  return {
    pid: null,
    options,
    writes,
    resizes,
    get closed() {
      return closed;
    },
    read(max) {
      if (closed) return null;
      const parts: Uint8Array[] = [];
      let total = 0;
      while (total < max) {
        const head = queue[0];
        if (head === undefined) break;
        if (!(head instanceof Uint8Array)) {
          produce(head);
          continue;
        }
        const take = Math.min(head.length, max - total);
        parts.push(head.subarray(0, take));
        total += take;
        if (take === head.length) queue.shift();
        else queue[0] = head.subarray(take);
      }
      return total === 0 ? null : Buffer.concat(parts, total);
    },
    write(data) {
      if (closed || exited()) return false;
      writes.push(data);
      for (const char of data.replace(ESCAPE_SEQUENCE, '')) key(char);
      return true;
    },
    resize(cols, rows) {
      if (closed) return false;
      resizes.push([cols, rows]);
      return true;
    },
    exitCode: () => code,
    close() {
      if (closed) return;
      closed = true;
      queue.length = 0;
    },
    emit(output) {
      if (closed) return;
      queue.push(typeof output === 'string' ? Buffer.from(output, 'utf8') : output);
    },
    exit(exitCode) {
      code ??= exitCode;
    },
    pendingBytes: () => queue.reduce((sum, item) => sum + (item instanceof Uint8Array ? item.length : 1), 0),
  };
}

/** A `PtyFactory` whose shells are fakes (see the file comment); `spawned` lists them. */
export function createFakePtyFactory(): FakePtyFactory {
  const spawned: FakePtyProcess[] = [];
  return {
    spawned,
    spawn(options) {
      const pty = createFakePty(options);
      spawned.push(pty);
      return pty;
    },
  };
}
