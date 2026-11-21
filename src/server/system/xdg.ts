/**
 * Linux desktop integration (WP-106, WP-100 §5.8) – the freedesktop counterparts of the Windows
 * entries, with the same ownership rules (system/markers.ts: own, deferred, foreign – judged by the
 * `Exec` line; a foreign entry is never replaced or removed):
 *
 * - program entry (start menu): `$XDG_DATA_HOME/applications/parallax.desktop` (default
 *   `~/.local/share/applications`) – only for an installation, with `Icon=<root>/parallax.svg`;
 * - autostart: `$XDG_CONFIG_HOME/autostart/parallax.desktop` (default `~/.config/autostart`, XDG
 *   Autostart) – `settings.autostart.enabled`;
 * - protocol handler `parallax:`: `$XDG_DATA_HOME/applications/parallax-url-handler.desktop`
 *   (`NoDisplay=true`, `MimeType=x-scheme-handler/parallax;`, `Exec=… --open %u`) and
 *   `xdg-mime default parallax-url-handler.desktop x-scheme-handler/parallax` –
 *   `settings.notifications.openOnClick`. The current default is asked first: another program's
 *   handler stays (`foreign`). Removing deletes the own file; the default in `mimeapps.list` then
 *   points nowhere, which the desktop ignores.
 *
 * Every entry names `StartupWMClass=parallax` (the Chrome window's `--class`, launcher/chromeWindow.ts).
 * `Exec` follows the Desktop Entry Specification: arguments with reserved characters in `"…"` (inside
 * `"` `` ` `` `$` `\` escaped), `%` as `%%`, then the string escapes of the file format (`\` → `\\`).
 * Commands with control characters are refused (they could not be written as one line).
 * Files go through `DesktopFs` (default: the real file system, atomic writes) – tests use memory.
 * Paths come only from the given environment (`HOME`, `XDG_*`; absolute and safe by the POSIX rules),
 * never from `os.homedir()`: a test run hands in an empty one and nothing is written (R6).
 */
import { mkdir, readFile, rm } from 'node:fs/promises';
import path from 'node:path';
import { PROTOCOL_SCHEME } from '@shared/http';
import { POSIX_PATHS } from '@shared/paths';
import { PRODUCT_NAME } from '@shared/product';
import { CHROME_WM_CLASS } from '../launcher/chromeWindow';
import { toError } from '../lib/async';
import { writeFileAtomic } from '../lib/fs';
import { fsErrorCode } from '../lib/paths';
import { guiEnvironment, systemTool, type RunFileFn } from '../lib/process';
import type { StartCommand } from './autostart';
import { fileState } from './memo';
import { LAUNCHER_ONLY_MARKERS, entryOwner, type EntryMarkers, type EntryOwner } from './markers';
import type { SystemOpResult } from './run';

/** File name of the program entry and of the autostart entry. */
export const DESKTOP_ENTRY_FILE = 'parallax.desktop';
/** File name of the (hidden) entry that handles `parallax:` links. */
export const URL_HANDLER_FILE = 'parallax-url-handler.desktop';
/** MIME type of the scheme (`xdg-mime`). */
export const URL_HANDLER_MIME = `x-scheme-handler/${PROTOCOL_SCHEME}`;
/** Reason when no safe `HOME` is set (the counterpart of `APPDATA is not set`). */
export const HOME_MISSING = 'HOME is not set';
/** `reason` of an entry (or a scheme default) that belongs to another program. */
export const FOREIGN_ENTRY = 'foreign';
export const XDG_MIME_TIMEOUT_MS = 10_000;

// ---- locations ----

function absoluteVar(env: Readonly<Record<string, string | undefined>>, name: string): string | null {
  const value = env[name];
  return value !== undefined && value !== '' && POSIX_PATHS.issue(value) === null ? value : null;
}

/** `$XDG_DATA_HOME` (absolute only), else `$HOME/.local/share`; null without a safe HOME. */
export function xdgDataHome(env: Readonly<Record<string, string | undefined>>): string | null {
  const own = absoluteVar(env, 'XDG_DATA_HOME');
  if (own !== null) return own;
  const home = absoluteVar(env, 'HOME');
  return home === null ? null : path.posix.join(home, '.local', 'share');
}

/** `$XDG_CONFIG_HOME` (absolute only), else `$HOME/.config`; null without a safe HOME. */
export function xdgConfigHome(env: Readonly<Record<string, string | undefined>>): string | null {
  const own = absoluteVar(env, 'XDG_CONFIG_HOME');
  if (own !== null) return own;
  const home = absoluteVar(env, 'HOME');
  return home === null ? null : path.posix.join(home, '.config');
}

/** `<data>/applications/parallax.desktop`, or null. */
export function programEntryPath(env: Readonly<Record<string, string | undefined>>): string | null {
  const data = xdgDataHome(env);
  return data === null ? null : path.posix.join(data, 'applications', DESKTOP_ENTRY_FILE);
}

/** `<data>/applications/parallax-url-handler.desktop`, or null. */
export function urlHandlerEntryPath(env: Readonly<Record<string, string | undefined>>): string | null {
  const data = xdgDataHome(env);
  return data === null ? null : path.posix.join(data, 'applications', URL_HANDLER_FILE);
}

/** `<config>/autostart/parallax.desktop`, or null. */
export function autostartEntryPath(env: Readonly<Record<string, string | undefined>>): string | null {
  const config = xdgConfigHome(env);
  return config === null ? null : path.posix.join(config, 'autostart', DESKTOP_ENTRY_FILE);
}

// ---- the Exec line ----

// Control characters (C0, DEL) – never part of a desktop entry value.
// eslint-disable-next-line no-control-regex
const CONTROL = /[\u0000-\u001f\u007f]/;
/** Reserved characters of an `Exec` argument (Desktop Entry Specification, "The Exec key"). */
const RESERVED = /[\s"'\\><~|&;$*?#()`]/;

/** One `Exec` argument (see the file comment). */
export function desktopExecArg(arg: string): string {
  const percent = arg.replace(/%/g, '%%');
  if (arg !== '' && !RESERVED.test(arg)) return percent;
  return `"${percent.replace(/["`$\\]/g, (char) => `\\${char}`)}"`;
}

/** A string value of the file format: `\` → `\\` (control characters are refused before). */
function desktopString(value: string): string {
  return value.replace(/\\/g, '\\\\');
}

/** The string escapes of the file format undone (`\\`, `\s`, `\n`, `\t`, `\r`). */
function unescapeDesktopString(value: string): string {
  return value.replace(/\\([\\sntr])/g, (_whole, code: string) =>
    code === 's' ? ' ' : code === 'n' ? '\n' : code === 't' ? '\t' : code === 'r' ? '\r' : '\\',
  );
}

/** The `Exec` value (string escapes undone) of the `[Desktop Entry]` group, or null. */
export function desktopExecValue(text: string): string | null {
  let inMain = false;
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (line.startsWith('[')) {
      inMain = line === '[Desktop Entry]';
      continue;
    }
    if (!inMain) continue;
    const match = /^Exec\s*=\s*(.*)$/.exec(line);
    if (match !== null) return unescapeDesktopString(match[1] ?? '');
  }
  return null;
}

/**
 * `Exec` value → argv: `"…"` groups (inside, `\"` `` \` `` `\$` `\\` are one character), `%%` is `%`,
 * field codes (`%u`, `%f` …) are dropped. Null for an unbalanced quote.
 */
export function parseDesktopExec(value: string): string[] | null {
  const args: string[] = [];
  let current = '';
  let started = false;
  let quoted = false;
  for (let i = 0; i < value.length; i += 1) {
    const char = value.charAt(i);
    if (quoted) {
      if (char === '\\' && i + 1 < value.length) {
        current += value.charAt(i + 1);
        i += 1;
      } else if (char === '"') {
        quoted = false;
      } else {
        current += char;
      }
      continue;
    }
    if (char === '"') {
      quoted = true;
      started = true;
    } else if (/\s/.test(char)) {
      if (started) args.push(current);
      current = '';
      started = false;
    } else {
      current += char;
      started = true;
    }
  }
  if (quoted) return null;
  if (started) args.push(current);
  return args.filter((arg) => !/^%[a-zA-Z]$/.test(arg)).map((arg) => arg.replace(/%%/g, '%'));
}

/** `Exec` of a start command (+ an unquoted field code such as `%u`), or null with control characters. */
export function desktopExecLine(command: StartCommand, fieldCode: string | null = null): string | null {
  const parts = [command.node, ...command.args];
  if (parts.some((part) => CONTROL.test(part))) return null;
  const line = parts.map(desktopExecArg).join(' ');
  return fieldCode === null ? line : `${line} ${fieldCode}`;
}

export type DesktopEntryKind = 'program' | 'autostart' | 'url-handler';

/**
 * The text of one entry, or null if the command cannot be written (control characters). `icon`
 * only for the program entry.
 */
export function desktopEntryText(
  kind: DesktopEntryKind,
  command: StartCommand,
  icon: string | null = null,
): string | null {
  const exec = desktopExecLine(command, kind === 'url-handler' ? '%u' : null);
  if (exec === null || CONTROL.test(command.cwd) || (icon !== null && CONTROL.test(icon))) return null;
  const lines = [
    '[Desktop Entry]',
    'Type=Application',
    'Version=1.5',
    `Name=${PRODUCT_NAME}`,
    'Comment=Mission control for parallel Claude Code sessions',
    'Comment[de]=Leitstand für parallele Claude-Code-Sessions',
    `Exec=${desktopString(exec)}`,
    `Path=${desktopString(command.cwd)}`,
    'Terminal=false',
    `StartupWMClass=${CHROME_WM_CLASS}`,
  ];
  if (kind === 'program') {
    if (icon !== null) lines.push(`Icon=${desktopString(icon)}`);
    lines.push('Categories=Development;');
  }
  if (kind === 'url-handler') lines.push('NoDisplay=true', `MimeType=${URL_HANDLER_MIME};`);
  if (kind === 'autostart') lines.push('X-GNOME-Autostart-enabled=true');
  return `${lines.join('\n')}\n`;
}

// ---- files ----

/** File access of the entries (default `nodeDesktopFs`; tests: memory). */
export interface DesktopFs {
  /** The file's text, null if it does not exist; other errors throw. */
  readText(file: string): Promise<string | null>;
  /** Writes atomically, the folder created if missing. */
  write(file: string, text: string): Promise<void>;
  /** Deletes; a missing file is fine. */
  remove(file: string): Promise<void>;
  /** Size and time for the ADR-229 memo (`absent` if missing). */
  state(file: string): Promise<string>;
}

export const nodeDesktopFs: DesktopFs = {
  async readText(file) {
    try {
      return await readFile(file, 'utf8');
    } catch (error) {
      if (fsErrorCode(error) === 'ENOENT') return null;
      throw error;
    }
  },
  async write(file, text) {
    await mkdir(path.posix.dirname(file), { recursive: true });
    await writeFileAtomic(file, text);
  },
  async remove(file) {
    await rm(file, { force: true });
  },
  state: fileState,
};

/** Entries in memory (tests, like `memoryMemo`): `files` maps a path to its text. */
export function memoryDesktopFs(initial: Readonly<Record<string, string>> = {}): DesktopFs & {
  files: Map<string, string>;
} {
  const files = new Map(Object.entries(initial));
  let writes = 0;
  const versions = new Map<string, number>();
  return {
    files,
    readText: (file) => Promise.resolve(files.get(file) ?? null),
    write: (file, text) => {
      files.set(file, text);
      writes += 1;
      versions.set(file, writes);
      return Promise.resolve();
    },
    remove: (file) => {
      files.delete(file);
      return Promise.resolve();
    },
    state: (file) => {
      const text = files.get(file);
      return Promise.resolve(
        text === undefined ? 'absent' : `${String(text.length)}:${String(versions.get(file) ?? 0)}`,
      );
    },
  };
}

export interface DesktopEntryOptions {
  fs: DesktopFs;
  /** Which existing entry is own/deferred (system/markers.ts); default `LAUNCHER_ONLY_MARKERS`. */
  markers?: EntryMarkers;
}

/** Who holds `file`: nobody, Parallax (own/deferred) or another program (no `Exec` → foreign). */
async function holder(file: string, opts: DesktopEntryOptions): Promise<EntryOwner | 'none'> {
  const text = await opts.fs.readText(file);
  if (text === null) return 'none';
  const exec = desktopExecValue(text);
  const argv = exec === null ? null : parseDesktopExec(exec);
  if (argv === null || argv.length === 0) return 'foreign';
  return entryOwner(argv.join(' '), opts.markers ?? LAUNCHER_ONLY_MARKERS);
}

function failure(action: string, file: string, error: unknown): SystemOpResult {
  return { ok: false, reason: `${action} ${file}: ${fsErrorCode(error) ?? toError(error).message}` };
}

/**
 * Writes `text` to `file` unless another program's entry is there (`foreign`, never replaced) or an
 * installation's (`deferred`, a success); the own one is replaced.
 */
export async function writeDesktopEntry(
  file: string,
  text: string,
  opts: DesktopEntryOptions,
): Promise<SystemOpResult> {
  let current: EntryOwner | 'none';
  try {
    current = await holder(file, opts);
  } catch (error) {
    return failure('read', file, error);
  }
  if (current === 'foreign') return { ok: false, reason: FOREIGN_ENTRY };
  if (current === 'deferred') return { ok: true, deferred: true };
  try {
    await opts.fs.write(file, text);
    return { ok: true };
  } catch (error) {
    return failure('write', file, error);
  }
}

/** Deletes the own entry; a missing or foreign one is left alone (`ok`), a deferred one too. */
export async function removeDesktopEntry(file: string, opts: DesktopEntryOptions): Promise<SystemOpResult> {
  let current: EntryOwner | 'none';
  try {
    current = await holder(file, opts);
  } catch (error) {
    return failure('read', file, error);
  }
  if (current === 'deferred') return { ok: true, deferred: true };
  if (current !== 'own') return { ok: true };
  try {
    await opts.fs.remove(file);
    return { ok: true };
  } catch (error) {
    return failure('remove', file, error);
  }
}

// ---- the three entries ----

export interface XdgDeps extends DesktopEntryOptions {
  /** Runner of `xdg-mime` (system/run.ts, R6). */
  run: RunFileFn;
  /** `HOME`, `XDG_*`, `PATH` (system/run.ts, R6). */
  env: NodeJS.ProcessEnv;
}

/** Writes the autostart entry `file` for `command` (`… --autostart`). */
export function createAutostartEntry(
  file: string,
  command: StartCommand,
  opts: DesktopEntryOptions,
): Promise<SystemOpResult> {
  const text = desktopEntryText('autostart', command);
  if (text === null) return Promise.resolve({ ok: false, reason: 'unsafe start command' });
  return writeDesktopEntry(file, text, opts);
}

/** Removes the own autostart entry `file`. */
export function removeAutostartEntry(file: string, opts: DesktopEntryOptions): Promise<SystemOpResult> {
  return removeDesktopEntry(file, opts);
}

/** Writes the program entry for `command` with the installation's icon. */
export async function ensureProgramEntry(
  command: StartCommand,
  icon: string | null,
  opts: XdgDeps,
): Promise<SystemOpResult> {
  const file = programEntryPath(opts.env);
  if (file === null) return { ok: false, reason: HOME_MISSING };
  const text = desktopEntryText('program', command, icon);
  if (text === null) return { ok: false, reason: 'unsafe start command' };
  return writeDesktopEntry(file, text, opts);
}

/** Removes the own program entry (a missing HOME: nothing could have been written). */
export async function removeProgramEntry(opts: XdgDeps): Promise<SystemOpResult> {
  const file = programEntryPath(opts.env);
  return file === null ? { ok: false, reason: HOME_MISSING } : removeDesktopEntry(file, opts);
}

type MimeDefault = { kind: 'ok'; handler: string | null } | { kind: 'failed'; reason: string };

async function xdgMime(args: readonly string[], opts: XdgDeps) {
  return opts.run(systemTool('xdg-mime', opts.env, 'linux'), args, {
    env: guiEnvironment(opts.env, 'linux'),
    timeoutMs: XDG_MIME_TIMEOUT_MS,
    maxOutputBytes: 16 * 1024,
  });
}

function mimeFailure(result: { timedOut: boolean; exitCode: number | null; stdout: string; stderr: string }) {
  if (result.timedOut) return 'xdg-mime timed out';
  const output = (result.stderr.trim() || result.stdout.trim()).slice(0, 300);
  return `xdg-mime exit ${String(result.exitCode)}: ${output}`;
}

/** `xdg-mime query default x-scheme-handler/parallax`: the desktop file id, null if none. */
export async function schemeDefault(opts: XdgDeps): Promise<MimeDefault> {
  try {
    const result = await xdgMime(['query', 'default', URL_HANDLER_MIME], opts);
    if (result.timedOut || result.exitCode !== 0) return { kind: 'failed', reason: mimeFailure(result) };
    const handler = result.stdout.trim();
    return { kind: 'ok', handler: handler === '' ? null : handler };
  } catch (error) {
    return { kind: 'failed', reason: `xdg-mime could not be started: ${toError(error).message}` };
  }
}

/**
 * Registers the own handler (see the file comment): another program's default stays (`foreign`),
 * a deferred (installation's) handler file stays (`deferred`), else the file is written and – unless
 * it already is – made the default.
 */
export async function registerUrlHandler(command: StartCommand, opts: XdgDeps): Promise<SystemOpResult> {
  const file = urlHandlerEntryPath(opts.env);
  if (file === null) return { ok: false, reason: HOME_MISSING };
  const text = desktopEntryText('url-handler', { ...command, args: [...command.args, '--open'] });
  if (text === null) return { ok: false, reason: 'unsafe start command' };
  const current = await schemeDefault(opts);
  if (current.kind === 'failed') return { ok: false, reason: current.reason };
  if (current.handler !== null && current.handler !== URL_HANDLER_FILE) {
    return { ok: false, reason: FOREIGN_ENTRY };
  }
  const written = await writeDesktopEntry(file, text, opts);
  if (!written.ok || written.deferred === true || current.handler === URL_HANDLER_FILE) return written;
  try {
    const result = await xdgMime(['default', URL_HANDLER_FILE, URL_HANDLER_MIME], opts);
    if (result.timedOut || result.exitCode !== 0) return { ok: false, reason: mimeFailure(result) };
    return { ok: true };
  } catch (error) {
    return { ok: false, reason: `xdg-mime could not be started: ${toError(error).message}` };
  }
}

/** Removes the own handler file (missing HOME, missing or foreign file: nothing to do). */
export async function unregisterUrlHandler(opts: XdgDeps): Promise<SystemOpResult> {
  const file = urlHandlerEntryPath(opts.env);
  return file === null ? { ok: true } : removeDesktopEntry(file, opts);
}
