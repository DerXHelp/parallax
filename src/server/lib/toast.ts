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
 *   `parseSessionProtocolUri` are used (re-generated from the parsed id), anything else is ignored.
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
 */
import { parseSessionProtocolUri, sessionProtocolUri } from '@shared/http';
import { PRODUCT_NAME } from '@shared/product';
import { toError } from './async';
import { encodePowerShell, powerShellPath } from './powershell';
import { errnoCode, runFile, type RunFileFn } from './process';

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
   * protocol handler. Ignored unless `parseSessionProtocolUri` accepts it; null/absent = no launch.
   */
  launchUri?: string | null;
  /** Phase 2 (ADR-109): no sound (`<audio silent="true"/>`). */
  silent?: boolean;
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

/** The canonical launch URI, or null if `uri` is absent or not a session URI (ADR-109). */
function toastLaunchUri(uri: string | null | undefined): string | null {
  if (uri === undefined || uri === null) return null;
  const entryId = parseSessionProtocolUri(uri);
  return entryId === null ? null : sessionProtocolUri(entryId);
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
    return { kind: 'failed', reason: 'not Windows', permanent: true };
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
