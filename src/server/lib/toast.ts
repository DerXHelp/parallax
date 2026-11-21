/**
 * Native Windows toasts (Plan A.9: "ohne offenes Fenster einen nativen Windows-Toast über einen
 * PowerShell-Helfer (`Windows.UI.Notifications`, ohne Installation)"; WP22-03/-15): Windows
 * PowerShell 5.1 with the WinRT types, no module, no install, no admin rights.
 *
 * - Sender: the app id `TOAST_APP_ID` with the display name `PRODUCT_NAME`, registered per user
 *   under `HKCU\Software\Classes\AppUserModelId\<id>` (`DisplayName` only – the documented way for
 *   unpackaged apps; without it Windows keeps the toast in the history but never shows it). No
 *   COM activator: a click dismisses the toast – unless `launchUri` is given (Phase 2, ADR-109):
 *   then the toast carries `activationType="protocol"` + `launch="parallax://session/<id>"` and a
 *   click starts the opt-in protocol handler (system/protocol.ts). Only URIs accepted by
 *   `parseHostSessionProtocolUri` are used (re-generated from the parsed ids), anything else is
 *   ignored – WP-81: also `parallax://session/<hostId>/<entryId>` (the toast of a controlling
 *   computer for a session of another computer).
 *   `silent` adds `<audio silent="true"/>` (sound off for the event, ADR-109).
 * - Data never goes into the script text: title, body, tag and launch URI travel in environment
 *   variables of the PowerShell process, the XML skeleton (`toastTemplateXml`, built only from
 *   booleans) is filled with DOM calls (`CreateTextNode`, `SetAttribute`) – no shell, no script or
 *   XML injection. The constant script goes as `-EncodedCommand` (no quoting issues).
 * - `tag` (≤ 64 chars) + group `parallax`: a newer toast of the same session replaces the older
 *   one; `removeToast(tag)` takes it out of the Action Center (decision answered elsewhere).
 * - Constrained Language Mode / AppLocker block the WinRT types → `failed` (the caller falls back
 *   to the in-app hint; check on a managed work machine).
 * - CR-05: `failed.permanent` tells a deterministic failure (no Windows, PowerShell cannot be
 *   started, a language mode other than FullLanguage, the registry or the WinRT types cannot be
 *   used – exit 4 of the script) from one that may pass (timeout under load, `Show` or
 *   `History.Remove` failed – exit 3, anything unexpected). Only a permanent one may switch the
 *   channel off (sessions/nativeToasts.ts).
 *
 * Linux (WP-106, WP-100 §5.7): the desktop's notification server (org.freedesktop.Notifications)
 * through `notify-send` (absolute `/usr/bin/notify-send`, argument array, no shell; title and body
 * after `--`): `--app-name=Parallax --print-id`, the hint `desktop-entry:parallax`, `suppress-sound`
 * when silent; a newer toast of the same `tag` replaces the older one (`--replace-id=<id>` of the
 * remembered notification). With a `launchUri` the toast gets the default action (`--action=
 * default=<actionLabel> --wait`): that `notify-send` stays as a waiter (at most `TOAST_WAIT_MAX_MS`,
 * ended when the toast is replaced or removed) and a click opens the URI with `xdg-open` – the
 * registered `parallax:` handler opens the session like on Windows. Without `notify-send` (or an
 * old one without these options) the toast goes through `gdbus` (`Notify`, no click).
 * `removeToast(tag)` closes it (`CloseNotification`). Permanent: no graphical session or session
 * bus, neither program there, no notification server on the bus; anything else may pass.
 */
import { hostSessionProtocolUri, parseHostSessionProtocolUri } from '@shared/http';
import { PRODUCT_ID, PRODUCT_NAME } from '@shared/product';
import { toError } from './async';
import { encodePowerShell, powerShellPath } from './powershell';
import {
  errnoCode,
  guiEnvironment,
  runFile,
  spawnHidden,
  systemTool,
  type RunFileFn,
  type SpawnHiddenOptions,
} from './process';

export { encodePowerShell };

/** AppUserModelID of the Parallax toasts (HKCU registration, see the file comment). */
export const TOAST_APP_ID = 'Parallax.App';
/** Group of every Parallax toast (History.Remove needs tag + group). */
export const TOAST_GROUP = 'parallax';
/** PowerShell start + WinRT load: ~1 s idle, much more under load. */
export const TOAST_TIMEOUT_MS = 30_000;
const MAX_TEXT_CHARS = 300;
const MAX_TAG_CHARS = 64;

export interface ToastRequest {
  title: string;
  body: string;
  /** E.g. the entry id; a toast with the same tag replaces the older one. */
  tag: string;
  /**
   * Phase 2 (ADR-109): `parallax://session/<entryId>` – a click opens the session through the
   * protocol handler; WP-81 also `parallax://session/<hostId>/<entryId>`. Ignored unless
   * `parseHostSessionProtocolUri` accepts it; null/absent = no launch.
   */
  launchUri?: string | null;
  /** Phase 2 (ADR-109): no sound (`<audio silent="true"/>`). */
  silent?: boolean;
  /** WP-106 (Linux): label of the click action with a `launchUri` (default `Open`). */
  actionLabel?: string;
}

/** `permanent`: deterministic, the next call fails the same way (CR-05, see the file comment). */
export type ToastResult =
  { kind: 'shown' | 'removed' } | { kind: 'failed'; reason: string; permanent: boolean };

/** Exit code of the script when the setup fails (language mode, registry, WinRT types): permanent. */
export const TOAST_EXIT_UNAVAILABLE = 4;
/** Exit code of the script when the action itself (`Show`, `History.Remove`) fails: may pass. */
export const TOAST_EXIT_ACTION_FAILED = 3;
/** Spawn errors of a busy machine (handles, memory) – PowerShell itself is there. */
const TRANSIENT_SPAWN_ERRORS: ReadonlySet<string> = new Set([
  'EMFILE',
  'ENFILE',
  'EAGAIN',
  'ENOMEM',
  'EBUSY',
]);

export interface ToastOptions {
  run?: RunFileFn;
  platform?: NodeJS.Platform;
  timeoutMs?: number;
  env?: NodeJS.ProcessEnv;
  /** WP-106: the Linux notifier (default one per process, `linuxNotifier()`). */
  notifier?: LinuxNotifier;
}

/**
 * The constant script: reads everything from `$env:PARALLAX_TOAST_*`. Exit 4 = the setup failed
 * (deterministic: language mode, registry, WinRT types), exit 3 = the action failed (may pass).
 */
export const TOAST_SCRIPT = [
  "$ErrorActionPreference = 'Stop'",
  "$step = 'setup'",
  'try {',
  "  if ($ExecutionContext.SessionState.LanguageMode -ne 'FullLanguage') {",
  "    Write-Output ('error[setup]: language mode ' + $ExecutionContext.SessionState.LanguageMode)",
  `    exit ${String(TOAST_EXIT_UNAVAILABLE)}`,
  '  }',
  '  $appId = $env:PARALLAX_TOAST_APP_ID',
  "  $key = 'HKCU:\\Software\\Classes\\AppUserModelId\\' + $appId",
  '  if (-not (Test-Path -LiteralPath $key)) { New-Item -Path $key -Force | Out-Null }',
  '  $name = (Get-ItemProperty -LiteralPath $key -ErrorAction SilentlyContinue).DisplayName',
  '  if ($name -ne $env:PARALLAX_TOAST_APP_NAME) {',
  '    Set-ItemProperty -LiteralPath $key -Name DisplayName -Value $env:PARALLAX_TOAST_APP_NAME',
  '  }',
  '  [void][Windows.UI.Notifications.ToastNotificationManager, Windows.UI.Notifications, ContentType = WindowsRuntime]',
  '  [void][Windows.Data.Xml.Dom.XmlDocument, Windows.Data.Xml.Dom, ContentType = WindowsRuntime]',
  '  $step = $env:PARALLAX_TOAST_ACTION',
  "  if ($env:PARALLAX_TOAST_ACTION -eq 'remove') {",
  '    [Windows.UI.Notifications.ToastNotificationManager]::History.Remove($env:PARALLAX_TOAST_TAG, $env:PARALLAX_TOAST_GROUP, $appId)',
  "    Write-Output 'removed'",
  '    exit 0',
  '  }',
  '  $xml = New-Object Windows.Data.Xml.Dom.XmlDocument',
  '  $xml.LoadXml($env:PARALLAX_TOAST_XML)',
  "  $texts = $xml.GetElementsByTagName('text')",
  '  [void]$texts.Item(0).AppendChild($xml.CreateTextNode($env:PARALLAX_TOAST_TITLE))',
  '  [void]$texts.Item(1).AppendChild($xml.CreateTextNode($env:PARALLAX_TOAST_BODY))',
  "  if ($env:PARALLAX_TOAST_LAUNCH) { $xml.DocumentElement.SetAttribute('launch', $env:PARALLAX_TOAST_LAUNCH) }",
  '  $toast = New-Object Windows.UI.Notifications.ToastNotification $xml',
  '  $toast.Tag = $env:PARALLAX_TOAST_TAG',
  '  $toast.Group = $env:PARALLAX_TOAST_GROUP',
  '  [Windows.UI.Notifications.ToastNotificationManager]::CreateToastNotifier($appId).Show($toast)',
  "  Write-Output 'shown'",
  '} catch {',
  "  Write-Output ('error[' + $step + ']: ' + $_.Exception.Message)",
  `  if ($step -eq 'setup') { exit ${String(TOAST_EXIT_UNAVAILABLE)} }`,
  `  exit ${String(TOAST_EXIT_ACTION_FAILED)}`,
  '}',
].join('\n');

/**
 * XML skeleton of a toast, built only from booleans (no user data): two empty `<text>` nodes the
 * script fills by DOM; `launch` adds `activationType="protocol"` and an empty `launch` attribute
 * the script sets by DOM; `silent` adds `<audio silent="true"/>`.
 */
export function toastTemplateXml(options: { launch: boolean; silent: boolean }): string {
  const attributes = options.launch ? ' activationType="protocol" launch=""' : '';
  const audio = options.silent ? '<audio silent="true"/>' : '';
  return (
    `<toast${attributes}><visual><binding template="ToastGeneric"><text></text><text></text></binding>` +
    `</visual>${audio}</toast>`
  );
}

/** The canonical launch URI, or null if `uri` is absent or not a session URI (ADR-109, WP-81). */
function toastLaunchUri(uri: string | null | undefined): string | null {
  if (uri === undefined || uri === null) return null;
  const target = parseHostSessionProtocolUri(uri);
  return target === null ? null : hostSessionProtocolUri(target.hostId, target.entryId);
}

/** Control characters (except tab/newline) out, length capped; XML escaping is done by the DOM. */
function cleanText(text: string, max: number): string {
  let out = '';
  for (const ch of text) {
    const code = ch.codePointAt(0) ?? 0;
    out += code < 0x20 && code !== 0x09 && code !== 0x0a ? ' ' : ch;
  }
  return out.slice(0, max);
}

async function runToast(
  vars: Record<string, string>,
  expected: 'shown' | 'removed',
  options: ToastOptions,
): Promise<ToastResult> {
  if ((options.platform ?? process.platform) !== 'win32')
    return { kind: 'failed', reason: 'unsupported platform', permanent: true };
  const run = options.run ?? runFile;
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(options.env ?? process.env)) {
    if (value !== undefined && !key.toUpperCase().startsWith('PARALLAX_TOAST_')) env[key] = value;
  }
  Object.assign(env, { PARALLAX_TOAST_APP_ID: TOAST_APP_ID, PARALLAX_TOAST_APP_NAME: PRODUCT_NAME }, vars);
  try {
    const result = await run(
      powerShellPath(options.env ?? process.env),
      ['-NoLogo', '-NoProfile', '-NonInteractive', '-EncodedCommand', encodePowerShell(TOAST_SCRIPT)],
      { env, timeoutMs: options.timeoutMs ?? TOAST_TIMEOUT_MS, maxOutputBytes: 16 * 1024 },
    );
    if (result.timedOut) return { kind: 'failed', reason: 'timeout', permanent: false };
    const output = result.stdout.trim();
    if (result.exitCode === 0 && output.endsWith(expected)) return { kind: expected };
    return {
      kind: 'failed',
      reason: `exit ${String(result.exitCode)}: ${(output || result.stderr.trim()).slice(0, 300)}`,
      // Only the script's own setup verdict is deterministic; anything else may pass (CR-05).
      permanent: result.exitCode === TOAST_EXIT_UNAVAILABLE,
    };
  } catch (error) {
    return {
      kind: 'failed',
      reason: `powershell could not be started: ${toError(error).message}`,
      permanent: !TRANSIENT_SPAWN_ERRORS.has(errnoCode(error) ?? ''),
    };
  }
}

/** Shows a toast (see the file comment). Never throws. */
export function showToast(request: ToastRequest, options: ToastOptions = {}): Promise<ToastResult> {
  if ((options.platform ?? process.platform) === 'linux') {
    return (options.notifier ?? linuxNotifier()).show(request);
  }
  const launch = toastLaunchUri(request.launchUri);
  return runToast(
    {
      PARALLAX_TOAST_ACTION: 'show',
      PARALLAX_TOAST_TITLE: cleanText(request.title, MAX_TEXT_CHARS),
      PARALLAX_TOAST_BODY: cleanText(request.body, MAX_TEXT_CHARS),
      PARALLAX_TOAST_TAG: cleanText(request.tag, MAX_TAG_CHARS),
      PARALLAX_TOAST_GROUP: TOAST_GROUP,
      PARALLAX_TOAST_XML: toastTemplateXml({ launch: launch !== null, silent: request.silent === true }),
      ...(launch === null ? {} : { PARALLAX_TOAST_LAUNCH: launch }),
    },
    'shown',
    options,
  );
}

/** Removes the toast with this tag from the Action Center (no-op if there is none). Never throws. */
export function removeToast(tag: string, options: ToastOptions = {}): Promise<ToastResult> {
  if ((options.platform ?? process.platform) === 'linux') {
    return (options.notifier ?? linuxNotifier()).remove(tag);
  }
  return runToast(
    {
      PARALLAX_TOAST_ACTION: 'remove',
      PARALLAX_TOAST_TAG: cleanText(tag, MAX_TAG_CHARS),
      PARALLAX_TOAST_GROUP: TOAST_GROUP,
    },
    'removed',
    options,
  );
}

// ---- Linux (WP-106, see the file comment) ----

/** `notify-send` without a waiter and every `gdbus` call. */
export const NOTIFY_TIMEOUT_MS = 10_000;
/** Longest life of a waiting `notify-send` (a toast that stays in the desktop's list). */
export const TOAST_WAIT_MAX_MS = 30 * 60_000;
export const DEFAULT_ACTION_LABEL = 'Open';
const NOTIFICATIONS_DEST = 'org.freedesktop.Notifications';
const NOTIFICATIONS_PATH = '/org/freedesktop/Notifications';
/** No notification server on the session bus (gdbus error text): nothing will ever show a toast. */
const NO_NOTIFICATION_SERVER = /ServiceUnknown|not provided by any \.service files|was not provided/i;

/** What the notifier needs of a waiting `notify-send` (a ChildProcess; fakes in tests). */
export interface ToastWaiter {
  /** `unref` (a pipe socket): the waiter never keeps the server alive. */
  readonly stdout: (NodeJS.ReadableStream & { unref?: () => void }) | null;
  once(event: 'spawn', listener: () => void): unknown;
  once(event: 'error', listener: (error: Error) => void): unknown;
  once(event: 'exit', listener: (code: number | null) => void): unknown;
  kill(signal?: NodeJS.Signals): boolean;
  unref(): void;
}

export type ToastSpawnFn = (
  file: string,
  args: readonly string[],
  options: SpawnHiddenOptions,
) => ToastWaiter;

export interface LinuxNotifierOptions {
  /** Graphical session, session bus, PATH (default `process.env`). */
  env?: NodeJS.ProcessEnv;
  /** `notify-send` without a click, `gdbus` (default `runFile`). */
  run?: RunFileFn;
  /** The waiting `notify-send` and the click's `xdg-open` (default `spawnHidden`). */
  spawn?: ToastSpawnFn;
  /** Absolute program of a tool name (default `systemTool(name, env, 'linux')`). */
  tool?: (name: string) => string;
  timeoutMs?: number;
  waitMaxMs?: number;
}

export interface LinuxNotifier {
  show(request: ToastRequest): Promise<ToastResult>;
  remove(tag: string): Promise<ToastResult>;
}

/** True with a graphical session (X11/Wayland) and a reachable session bus. */
export function hasNotificationSession(env: NodeJS.ProcessEnv): boolean {
  const set = (name: string): boolean => (env[name] ?? '').trim() !== '';
  return (
    (set('DISPLAY') || set('WAYLAND_DISPLAY')) && (set('DBUS_SESSION_BUS_ADDRESS') || set('XDG_RUNTIME_DIR'))
  );
}

/** A GVariant string literal (gdbus arguments are GVariant text): `'…'` with escapes. */
export function gvariantString(text: string): string {
  const escaped = text.replace(/[\\'\n\t]/g, (char) =>
    char === '\n' ? '\\n' : char === '\t' ? '\\t' : `\\${char}`,
  );
  return `'${escaped}'`;
}

/** The notification id in `notify-send --print-id` output (first line) or a gdbus reply `(uint32 7,)`. */
export function parseNotificationId(output: string): number | null {
  const match = /^\s*(?:\(uint32\s+)?(\d+)/.exec(output);
  if (match === null) return null;
  const id = Number(match[1]);
  return Number.isSafeInteger(id) && id > 0 && id <= 0xffffffff ? id : null;
}

/** The arguments of `notify-send` (title and body after `--`, never parsed as options). */
export function notifySendArgs(
  request: { title: string; body: string; silent: boolean; replaceId: number | null },
  action: string | null,
): string[] {
  return [
    `--app-name=${PRODUCT_NAME}`,
    '--print-id',
    `--hint=string:desktop-entry:${PRODUCT_ID}`,
    ...(request.silent ? ['--hint=boolean:suppress-sound:true'] : []),
    ...(request.replaceId === null ? [] : [`--replace-id=${String(request.replaceId)}`]),
    ...(action === null ? [] : [`--action=default=${action}`, '--wait']),
    '--',
    request.title,
    request.body,
  ];
}

interface Shown {
  id: number | null;
  /** Ends the waiting `notify-send` (null without one). */
  stop: (() => void) | null;
}

export function createLinuxNotifier(opts: LinuxNotifierOptions = {}): LinuxNotifier {
  const env = (): NodeJS.ProcessEnv => opts.env ?? process.env;
  const run = opts.run ?? runFile;
  const spawn: ToastSpawnFn = opts.spawn ?? ((file, args, options) => spawnHidden(file, args, options));
  const tool = opts.tool ?? ((name: string) => systemTool(name, env(), 'linux'));
  const timeoutMs = opts.timeoutMs ?? NOTIFY_TIMEOUT_MS;
  const waitMaxMs = opts.waitMaxMs ?? TOAST_WAIT_MAX_MS;
  const shown = new Map<string, Shown>();

  const failed = (reason: string, permanent: boolean): ToastResult => ({ kind: 'failed', reason, permanent });
  const remember = (tag: string, entry: Shown): void => {
    shown.get(tag)?.stop?.();
    shown.set(tag, entry);
  };
  const runTool = (name: string, args: readonly string[]) =>
    run(tool(name), args, { env: guiEnvironment(env(), 'linux'), timeoutMs, maxOutputBytes: 16 * 1024 });

  /** `gdbus call … <method> <args>`; a reply, or the failure (permanent without a server or program). */
  const gdbus = async (
    method: string,
    args: readonly string[],
  ): Promise<{ ok: true; stdout: string } | { ok: false; reason: string; permanent: boolean }> => {
    try {
      const result = await runTool('gdbus', [
        'call',
        '--session',
        '--dest',
        NOTIFICATIONS_DEST,
        '--object-path',
        NOTIFICATIONS_PATH,
        '--method',
        `${NOTIFICATIONS_DEST}.${method}`,
        ...args,
      ]);
      if (result.timedOut) return { ok: false, reason: 'gdbus timeout', permanent: false };
      if (result.exitCode === 0) return { ok: true, stdout: result.stdout };
      const output = (result.stderr.trim() || result.stdout.trim()).slice(0, 300);
      return {
        ok: false,
        reason: `gdbus exit ${String(result.exitCode)}: ${output}`,
        permanent: NO_NOTIFICATION_SERVER.test(output),
      };
    } catch (error) {
      const code = errnoCode(error) ?? '';
      return {
        ok: false,
        reason: `gdbus could not be started: ${toError(error).message}`,
        permanent: !TRANSIENT_SPAWN_ERRORS.has(code),
      };
    }
  };

  /** The toast through `Notify` (no click). */
  const notifyOverBus = async (
    tag: string,
    toast: { title: string; body: string; silent: boolean; replaceId: number | null },
  ): Promise<ToastResult> => {
    const hints = [`'desktop-entry': <${gvariantString(PRODUCT_ID)}>`];
    if (toast.silent) hints.push("'suppress-sound': <true>");
    const reply = await gdbus('Notify', [
      gvariantString(PRODUCT_NAME),
      String(toast.replaceId ?? 0),
      "''",
      gvariantString(toast.title),
      gvariantString(toast.body),
      '[]',
      `{${hints.join(', ')}}`,
      '-1',
    ]);
    if (!reply.ok) return failed(reply.reason, reply.permanent);
    remember(tag, { id: parseNotificationId(reply.stdout), stop: null });
    return { kind: 'shown' };
  };

  /** `notify-send` without a click; null → use the bus (missing or too old). */
  const notifyOnce = async (tag: string, args: readonly string[]): Promise<ToastResult | null> => {
    try {
      const result = await runTool('notify-send', args);
      if (result.timedOut) return failed('notify-send timeout', false);
      if (result.exitCode !== 0) return null;
      remember(tag, { id: parseNotificationId(result.stdout), stop: null });
      return { kind: 'shown' };
    } catch (error) {
      const code = errnoCode(error) ?? '';
      return TRANSIENT_SPAWN_ERRORS.has(code)
        ? failed(`notify-send could not be started: ${code}`, false)
        : null;
    }
  };

  /** Opens the launch URI after a click (`xdg-open`, detached, never awaited). */
  const openUri = (uri: string): void => {
    try {
      const child = spawn(tool('xdg-open'), [uri], { env: guiEnvironment(env(), 'linux'), stdio: 'ignore' });
      child.once('error', () => undefined);
      child.unref();
    } catch {
      // Nothing to open with: the click only dismisses the toast.
    }
  };

  /**
   * `notify-send … --action=default=… --wait`, kept as a waiter: resolves with its id (shown), or
   * null when it ended without one (an old notify-send without these options → the caller falls back).
   */
  const notifyWaiting = (tag: string, args: readonly string[], uri: string): Promise<ToastResult | null> =>
    new Promise((resolve) => {
      let waiter: ToastWaiter;
      try {
        waiter = spawn(tool('notify-send'), args, {
          env: guiEnvironment(env(), 'linux'),
          stdio: ['ignore', 'pipe', 'pipe'],
        });
      } catch {
        resolve(null);
        return;
      }
      let settled = false;
      let ended = false;
      const settle = (result: ToastResult | null): void => {
        if (settled) return;
        settled = true;
        resolve(result);
      };
      const stop = (): void => {
        clearTimeout(maxAge);
        if (!ended) waiter.kill('SIGTERM');
      };
      const maxAge = setTimeout(stop, waitMaxMs);
      maxAge.unref();
      const startup = setTimeout(() => {
        // No id in time: the toast may still come; the waiter goes, the channel stays on.
        stop();
        settle(failed('notify-send timeout', false));
      }, timeoutMs);
      startup.unref();
      let buffer = '';
      let id: number | null = null;
      waiter.stdout?.setEncoding('utf8');
      waiter.stdout?.on('data', (chunk: string) => {
        buffer += chunk;
        let newline = buffer.indexOf('\n');
        while (newline >= 0) {
          const line = buffer.slice(0, newline).trim();
          buffer = buffer.slice(newline + 1);
          newline = buffer.indexOf('\n');
          if (id === null) {
            id = parseNotificationId(line);
            if (id !== null) {
              clearTimeout(startup);
              remember(tag, { id, stop });
              settle({ kind: 'shown' });
            }
          } else if (line === 'default') {
            openUri(uri);
          }
        }
      });
      waiter.once('error', () => {
        ended = true;
        clearTimeout(startup);
        clearTimeout(maxAge);
        settle(null);
      });
      waiter.once('exit', (code) => {
        ended = true;
        clearTimeout(startup);
        clearTimeout(maxAge);
        const current = shown.get(tag);
        if (current?.stop === stop) shown.set(tag, { id: current.id, stop: null });
        settle(
          id !== null ? { kind: 'shown' } : code === 0 ? failed('notify-send printed no id', false) : null,
        );
      });
      waiter.once('spawn', () => {
        waiter.unref();
        waiter.stdout?.unref?.();
      });
    });

  return {
    async show(request) {
      if (!hasNotificationSession(env())) return failed('no graphical session', true);
      const tag = cleanText(request.tag, MAX_TAG_CHARS);
      const toast = {
        title: cleanText(request.title, MAX_TEXT_CHARS),
        body: cleanText(request.body, MAX_TEXT_CHARS),
        silent: request.silent === true,
        replaceId: shown.get(tag)?.id ?? null,
      };
      // The older toast's waiter goes now (its click would open an outdated toast).
      shown.get(tag)?.stop?.();
      const uri = toastLaunchUri(request.launchUri);
      if (uri !== null) {
        const label = cleanText(request.actionLabel ?? DEFAULT_ACTION_LABEL, MAX_TEXT_CHARS);
        const waited = await notifyWaiting(tag, notifySendArgs(toast, label), uri);
        if (waited !== null) return waited;
      }
      const once = await notifyOnce(tag, notifySendArgs(toast, null));
      return once ?? notifyOverBus(tag, toast);
    },
    async remove(tag) {
      const key = cleanText(tag, MAX_TAG_CHARS);
      const entry = shown.get(key);
      if (entry === undefined) return { kind: 'removed' };
      shown.delete(key);
      entry.stop?.();
      if (entry.id === null || !hasNotificationSession(env())) return { kind: 'removed' };
      const reply = await gdbus('CloseNotification', [String(entry.id)]);
      return reply.ok ? { kind: 'removed' } : failed(reply.reason, reply.permanent);
    },
  };
}

let defaultNotifier: LinuxNotifier | null = null;

/** The notifier of this process (one map of shown toasts for every caller). */
export function linuxNotifier(): LinuxNotifier {
  defaultNotifier ??= createLinuxNotifier();
  return defaultNotifier;
}
