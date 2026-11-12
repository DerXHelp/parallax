/**
 * WP-65 §1.6b: host command `link.open { url }` – an http(s) link (checked in `@shared`, again here)
 * opens in the user's DEFAULT browser instead of Parallax's Chrome app profile (nobody is signed in
 * there). The default browser comes from the registry: HKCU `…\UrlAssociations\https\UserChoice`
 * (`ProgId`, `http` as fallback) → `<ProgId>\shell\open\command` (HKCU, then HKLM Classes) →
 * command line parsed, only an absolute `.exe`; started through `spawnGui` (lib/process.ts, ADR-144:
 * PE subsystem GUI checked, blocklist, detached) with the URL in place of `%1`. Never `cmd /c start`.
 * Failures → OPEN_FAILED {reason} (the web then opens the link itself, with a hint).
 *
 * `createRecordingLinkOpener` starts NOTHING and logs `link.open (fake): <url>` – compose wires it with
 * the FakeBackend (dev, E2E), like the recording file opener (files/open.ts).
 */
import path from 'node:path';
import type { Logger } from 'pino';
import { makeError } from '@shared/errors';
import { isHttpUrl } from '@shared/model';
import { logger as rootLogger } from '../lib/logger';
import { spawnGui, type GuiSpawnFn } from '../lib/process';
import {
  expandRegValue,
  parseRegValues,
  regKeyQuery,
  regQuery,
  type RegKeyQuery,
  type RegQuery,
} from '../lib/registry';
import { CommandError, type HostCommandHandler } from '../sync/ports';

export interface LinkOpener {
  /** Throws CommandError(OPEN_FAILED). */
  open(url: string): Promise<void>;
}

const USER_CHOICE = (scheme: 'https' | 'http'): string =>
  `HKCU\\Software\\Microsoft\\Windows\\Shell\\Associations\\UrlAssociations\\${scheme}\\UserChoice`;
const COMMAND_KEYS = (progId: string): string[] => [
  `HKCU\\Software\\Classes\\${progId}\\shell\\open\\command`,
  `HKLM\\Software\\Classes\\${progId}\\shell\\open\\command`,
];
/** ProgIds are plain names (`ChromeHTML`, `MSEdgeHTM`, `FirefoxURL-308046B0AF4A39CB`). */
const PROG_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;

function openFailed(reason: string): CommandError {
  return new CommandError(makeError('OPEN_FAILED', { reason }));
}

/**
 * Windows command line → tokens (quotes group, backslashes stay; enough for `shell\open\command`
 * values such as `"C:\…\chrome.exe" --single-argument %1` or `C:\…\firefox.exe -osint -url "%1"`).
 */
export function splitCommandLine(line: string): string[] {
  const tokens: string[] = [];
  let current = '';
  let quoted = false;
  let started = false;
  for (const ch of line.trim()) {
    if (ch === '"') {
      quoted = !quoted;
      started = true;
    } else if (/\s/.test(ch) && !quoted) {
      if (started) tokens.push(current);
      current = '';
      started = false;
    } else {
      current += ch;
      started = true;
    }
  }
  if (started) tokens.push(current);
  return tokens;
}

/** `%1` / `%L` placeholders take the URL; other `%` placeholders are dropped; none → URL appended. */
export function browserLaunch(command: string, url: string): { file: string; args: string[] } | null {
  const [file, ...rest] = splitCommandLine(command);
  if (file === undefined || !path.win32.isAbsolute(file) || !/\.exe$/i.test(file) || file.startsWith('\\\\')) {
    return null;
  }
  let placed = false;
  const args: string[] = [];
  for (const token of rest) {
    if (/^%[1l]$/i.test(token)) {
      args.push(url);
      placed = true;
    } else if (!token.includes('%')) {
      args.push(token);
    }
  }
  if (!placed) args.push(url);
  return { file, args };
}

/**
 * The default value of a `reg query <key> /ve` output AS WRITTEN – unlike `parseRegDefaultValue`
 * (made for paths) the quotes stay: `"C:\…\firefox.exe" -osint -url "%1"` starts and ends with one.
 */
function commandValue(output: string, env: Readonly<Record<string, string | undefined>>): string | null {
  for (const line of output.split(/\r?\n/)) {
    const match = /\s(REG_SZ|REG_EXPAND_SZ)\s+(.+?)\s*$/.exec(line);
    if (match === null) continue;
    const value = match[1] === 'REG_EXPAND_SZ' ? expandRegValue(match[2] ?? '', env) : (match[2] ?? '');
    return value.trim() === '' ? null : value.trim();
  }
  return null;
}

export interface DefaultBrowserDeps {
  regQuery?: RegQuery;
  regKeyQuery?: RegKeyQuery;
  env?: NodeJS.ProcessEnv;
}

/** The default browser's `shell\open\command` line, or null (no choice, unknown ProgId, no command). */
export async function defaultBrowserCommand(deps: DefaultBrowserDeps = {}): Promise<string | null> {
  const queryKey = deps.regKeyQuery ?? regKeyQuery();
  const queryDefault = deps.regQuery ?? regQuery();
  const env = deps.env ?? process.env;
  for (const scheme of ['https', 'http'] as const) {
    const output = await queryKey(USER_CHOICE(scheme), 64);
    if (output === null) continue;
    const progId = parseRegValues(output).find((v) => v.name.toLowerCase() === 'progid')?.data.trim() ?? '';
    if (!PROG_ID.test(progId)) continue;
    for (const key of COMMAND_KEYS(progId)) {
      const value = await queryDefault(key, 64);
      const command = value === null ? null : commandValue(value, env);
      if (command !== null) return command;
    }
  }
  return null;
}

export interface SystemLinkOpenerDeps extends DefaultBrowserDeps {
  spawn?: GuiSpawnFn;
  readHead?: (file: string, length: number) => Promise<Uint8Array>;
  platform?: NodeJS.Platform;
  logger?: Logger | undefined;
}

export function createSystemLinkOpener(deps: SystemLinkOpenerDeps = {}): LinkOpener {
  const log = (deps.logger ?? rootLogger).child({ module: 'link' });
  return {
    async open(url) {
      if ((deps.platform ?? process.platform) !== 'win32') throw openFailed('platform');
      const command = await defaultBrowserCommand(deps);
      if (command === null) throw openFailed('no_default_browser');
      const launch = browserLaunch(command, url);
      if (launch === null) {
        log.warn({ command: command.slice(0, 300) }, 'default browser command is no absolute .exe');
        throw openFailed('browser_command');
      }
      await spawnGui(launch.file, launch.args, {
        cwd: path.win32.dirname(launch.file),
        ...(deps.env === undefined ? {} : { env: deps.env }),
        ...(deps.spawn === undefined ? {} : { spawn: deps.spawn }),
        ...(deps.readHead === undefined ? {} : { readHead: deps.readHead }),
        ...(deps.platform === undefined ? {} : { platform: deps.platform }),
      });
    },
  };
}

/** Starts nothing: logs and records the links (FakeBackend, tests). */
export function createRecordingLinkOpener(o: { logger?: Logger | undefined } = {}): LinkOpener & { readonly opened: string[] } {
  const log = (o.logger ?? rootLogger).child({ module: 'link' });
  const opened: string[] = [];
  return {
    opened,
    open(url) {
      opened.push(url);
      log.info(`link.open (fake): ${url}`);
      return Promise.resolve();
    },
  };
}

/** The host command handler (ADR-101). */
export function createLinkCommands(opener: LinkOpener): HostCommandHandler {
  return {
    names: ['link.open'],
    async handle(cmd) {
      if (cmd.name !== 'link.open') throw new CommandError(makeError('NOT_IMPLEMENTED', { command: cmd.name }));
      if (!isHttpUrl(cmd.url)) throw openFailed('url');
      await opener.open(cmd.url);
      return {};
    },
  };
}
