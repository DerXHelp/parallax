/**
 * The launcher's command line flow (main.ts runs it with the real dependencies): arguments →
 * `loadConfig` → `runLauncher` → console messages and the exit code. Separate from main.ts so the
 * flow is unit-tested (main.ts only wires `process`).
 *
 * Exit codes: 0 = done, 2 = bad option or link (nothing started), 3 = data of a newer Parallax,
 * else 1. Phase 2: `--open <uri>` is checked with `parseHostSessionProtocolUri` BEFORE anything
 * starts (ADR-109, R5) – `parallax://session/<id>` (this computer) or, WP-81 (ADR-211), the toast of
 * a controlling computer `parallax://session/<hostId>/<id>`; the window then selects
 * `<hostId>:<id>`. `--autostart` opens a window only if `settings.autostart.openWindow` (settings
 * read-only, ADR-110).
 *
 * WP-87b: `--apply-update` branches off before `launch` into the orchestrator
 * (`runApplyUpdate`, applyUpdate.ts). Its stdout belongs to the handshake with the server
 * (update/handoff.ts): a bad option there answers `PARALLAX-APPLY-FAILED spawn`, notes go to the
 * update log.
 *
 * WP-107: `--server` (foreground, no Chrome, `--print-url` for an SSH tunnel; exit code = the
 * server's), `parallax service …` (systemd user service, systemdService.ts) and `parallax remote …`
 * (`POST /api/launcher/remote` of the running server; the pairing code only on this console).
 */
import type { EntryId, HostId } from '@shared/common';
import type { ErrorPayload } from '@shared/errors';
import {
  serverOrigin,
  parseHostSessionProtocolUri,
  type LauncherRemoteRequest,
  type LauncherRemoteResponse,
} from '@shared/http';
import { DEFAULT_AUTOSTART } from '@shared/model';
import { ConfigError, loadConfig, readSettingsFile, type ServerConfig, type SettingsPeek } from '../config';
import { APPLY_UPDATE_FLAG, handshakeLine, readyTimeoutMs } from '../update/handoff';
import type { ApplyUpdateRequest } from './applyUpdate';
import {
  LAUNCHER_USAGE,
  OPEN_LINK_FORMS,
  parseLauncherArgs,
  portRequested,
  serverArgsFor,
  type ApplyUpdateArgs,
  type LauncherArgs,
  type LauncherCommand,
  type ServiceAction,
} from './args';
import type { LauncherRemoteResult } from './client';
import { LauncherError, type LauncherOptions, type LauncherResult } from './launcher';

/** WP-107 `--server`: the start (like a window start, without one) and a report once it runs. */
export interface ServeRequest {
  options: LauncherOptions;
  onStarted(result: LauncherResult): void;
}

/** `existing`: a server of this home runs already (none started); `ended`: the server's exit code. */
export type ServeOutcome = { kind: 'existing'; port: number; pid: number } | { kind: 'ended'; code: number };

/** WP-107 `parallax remote …`: the answer of the running server, or none runs. */
export type RemoteCallResult = LauncherRemoteResult | { kind: 'not_running' };

/** WP-107 `parallax service …`. */
export interface ServiceRequest {
  action: ServiceAction;
  /** Flags after `--server` in the unit (`--home=…`, `--port=…`, `--key-store=file`, `--backend=fake`). */
  serverArgs: string[];
  installRoot: string | null;
}

export interface LauncherCliDeps {
  env: NodeJS.ProcessEnv;
  /** Base of a relative `--home` (default `process.cwd()`). */
  cwd?: string;
  /** One line to stdout / stderr. */
  out(line: string): void;
  fail(line: string): void;
  /** `runLauncher` with the real dependencies of `options.home`. */
  launch(options: LauncherOptions): Promise<LauncherResult>;
  /** WP-87b: `runApplyUpdate` with the real dependencies (main.ts); resolves with the exit code. */
  applyUpdate(request: ApplyUpdateRequest): Promise<number>;
  /** Default `readSettingsFile` (read-only). */
  readSettings?(home: string): SettingsPeek;
  /** WP-107 `--server` (main.ts); absent = not offered. */
  serve?(request: ServeRequest): Promise<ServeOutcome>;
  /** WP-107 `parallax remote …` against the running server of `home`. */
  remote?(home: string, request: LauncherRemoteRequest): Promise<RemoteCallResult>;
  /** WP-107 `parallax service …`; resolves with the exit code. */
  service?(request: ServiceRequest): Promise<number>;
}

/** At most this many characters of a refused link are echoed (it comes from any web page). */
const LINK_ECHO_CHARS = 120;

export async function runLauncherCli(argv: readonly string[], deps: LauncherCliDeps): Promise<number> {
  const args = parseLauncherArgs(argv);
  if (args.help) {
    deps.out(LAUNCHER_USAGE);
    return 0;
  }
  if (args.problem !== null) {
    // The server waits for a handshake line: answer at once instead of letting it wait.
    if (argv.some((arg) => arg === APPLY_UPDATE_FLAG || arg.startsWith(`${APPLY_UPDATE_FLAG}=`))) {
      deps.out(handshakeLine({ kind: 'failed', reason: 'spawn' }));
    }
    deps.fail(`Invalid option: ${args.problem}\n\n${LAUNCHER_USAGE}`);
    return 2;
  }
  if (args.applyUpdate !== null && args.installRoot !== null) {
    return applyUpdateCli(args.applyUpdate, args.installRoot, args.serverArgv, deps);
  }
  let entryId: EntryId | null = null;
  let hostId: HostId | null = null;
  if (args.open !== null) {
    const target = parseHostSessionProtocolUri(args.open);
    if (target === null) {
      deps.fail(
        `Invalid Parallax link "${args.open.slice(0, LINK_ECHO_CHARS)}" - expected ${OPEN_LINK_FORMS}. ` +
          'Nothing was started.',
      );
      return 2;
    }
    ({ entryId, hostId } = target);
  }
  const loaded = loadCliConfig(args, deps);
  if (typeof loaded === 'number') return loaded;
  const config = loaded;
  if (args.command !== null) return commandCli(args.command, args, config, deps);
  const peek = (deps.readSettings ?? readSettingsFile)(config.home);
  for (const note of new Set([...config.notes, ...(peek.note === null ? [] : [peek.note])])) {
    deps.out(`Note: ${note}`);
  }
  const openWindow = args.autostart
    ? (peek.settings?.autostart.openWindow ?? DEFAULT_AUTOSTART.openWindow)
    : true;
  const options: LauncherOptions = {
    home: config.home,
    port: config.port,
    // WP-86: the server registers start.mjs of this installation (autostart, protocol, Start menu).
    serverArgs: [
      ...serverArgsFor(config),
      ...(args.installRoot === null ? [] : [`--install-root=${args.installRoot}`]),
    ],
    build: args.build,
    printUrl: args.printUrl,
    installRoot: args.installRoot,
    backend: config.backend,
    // V2-13: a port from the settings is a request too (the hint says when it takes effect).
    portExplicit: portRequested(args.serverArgv, deps.env) || (peek.settings?.port ?? null) !== null,
    entryId,
    hostId,
    openWindow,
  };
  if (args.server) return serverModeCli(options, config, deps);
  try {
    const result = await deps.launch(options);
    deps.out(resultMessage(result, config, args.printUrl));
    return 0;
  } catch (error) {
    if (error instanceof LauncherError) {
      deps.fail(error.message);
      return error.exitCode;
    }
    deps.fail(
      `Unexpected launcher error: ${error instanceof Error ? (error.stack ?? error.message) : String(error)}`,
    );
    return 1;
  }
}

/** loadConfig for the launcher (bad option → exit 2 with the usage). */
function loadCliConfig(args: LauncherArgs, deps: LauncherCliDeps): ServerConfig | number {
  let config: ServerConfig;
  try {
    config = loadConfig({
      argv: args.serverArgv,
      env: deps.env,
      ...(deps.cwd === undefined ? {} : { cwd: deps.cwd }),
    });
  } catch (error) {
    if (!(error instanceof ConfigError)) throw error;
    deps.fail(`Invalid option: ${error.message}\n\n${LAUNCHER_USAGE}`);
    return 2;
  }
  if (config.dev) {
    deps.fail('--dev is for "pnpm dev" (Vite + dev server); the launcher starts the built app.');
    return 2;
  }
  return config;
}

/** The launcher's last resort for an unexpected error (stack to stderr, exit 1). */
function unexpected(error: unknown, deps: LauncherCliDeps): number {
  if (error instanceof LauncherError) {
    deps.fail(error.message);
    return error.exitCode;
  }
  deps.fail(
    `Unexpected launcher error: ${error instanceof Error ? (error.stack ?? error.message) : String(error)}`,
  );
  return 1;
}

/**
 * WP-107 `--server`: the server in the foreground without Chrome; with `--print-url` the sign-in
 * address. A server of this home that runs already is an error (a service must not end "fine").
 */
async function serverModeCli(
  options: LauncherOptions,
  config: ServerConfig,
  deps: LauncherCliDeps,
): Promise<number> {
  if (deps.serve === undefined) {
    deps.fail('--server is not available in this launcher.');
    return 2;
  }
  try {
    const outcome = await deps.serve({
      // The address only with --print-url; never Chrome (printUrl suppresses the window).
      options: { ...options, printUrl: true, openWindow: options.printUrl, entryId: null, hostId: null },
      onStarted: (result) => {
        deps.out(
          `Parallax server runs on ${serverOrigin(result.port)} (PID ${String(result.pid)}, data: ${config.home}) - ` +
            'stop it with Ctrl+C.',
        );
      },
    });
    if (outcome.kind === 'existing') {
      deps.fail(
        `Parallax already runs on ${serverOrigin(outcome.port)} (PID ${String(outcome.pid)}) for ${config.home} - ` +
          '--server starts no second server. Stop the other one first.',
      );
      return 1;
    }
    return outcome.code;
  } catch (error) {
    return unexpected(error, deps);
  }
}

/** WP-107: `service …` / `remote …`. */
async function commandCli(
  command: LauncherCommand,
  args: LauncherArgs,
  config: ServerConfig,
  deps: LauncherCliDeps,
): Promise<number> {
  if (command.kind === 'service') {
    if (deps.service === undefined) {
      deps.fail('"parallax service" is not available in this launcher.');
      return 2;
    }
    try {
      return await deps.service({
        action: command.action,
        serverArgs: [
          `--home=${config.home}`,
          ...(portRequested(args.serverArgv, deps.env) ? [`--port=${String(config.port)}`] : []),
          ...(config.backend === 'fake' ? ['--backend=fake'] : []),
          ...(config.keyStore === 'file' ? ['--key-store=file'] : []),
        ],
        installRoot: args.installRoot,
      });
    } catch (error) {
      return unexpected(error, deps);
    }
  }
  if (deps.remote === undefined) {
    deps.fail('"parallax remote" is not available in this launcher.');
    return 2;
  }
  let result: RemoteCallResult;
  try {
    result = await deps.remote(config.home, command.request);
  } catch (error) {
    return unexpected(error, deps);
  }
  switch (result.kind) {
    case 'not_running':
      deps.fail(
        `Parallax does not run for ${config.home} - start it first ("parallax --server" or the service), ` +
          'then try again.',
      );
      return 1;
    case 'token_invalid':
      deps.fail('The running server rejected the launcher token (the lock file belongs to another server).');
      return 1;
    case 'failed':
      deps.fail(`No answer from the running server (${result.reason}).`);
      return 1;
    case 'refused':
      deps.fail(remoteRefusal(result.error));
      return 1;
    case 'ok':
      for (const line of remoteLines(command.request, result.response)) deps.out(line);
      return 0;
  }
}

/** A refused `parallax remote …` in words (the codes of the settings page). */
export function remoteRefusal(error: ErrorPayload): string {
  const reason = typeof error.params.reason === 'string' ? error.params.reason : null;
  switch (error.code) {
    case 'REMOTE_KEYSTORE_UNAVAILABLE':
      return (
        'No key store is usable on this computer: unlock a keyring, use systemd-creds (systemd 256 or newer) ' +
        'or start Parallax with --key-store=file.'
      );
    case 'REMOTE_ROLE_CONFLICT':
      return 'This computer controls other computers - remove them before it shares itself.';
    case 'VALIDATION_FAILED':
      return reason === 'not_paired'
        ? 'No computer is coupled.'
        : reason === 'role'
          ? 'Sharing is off - "parallax remote enable" first.'
          : `Refused (${error.code}${reason === null ? '' : `: ${reason}`}).`;
    default:
      return `Refused (${error.code}${reason === null ? '' : `: ${reason}`}).`;
  }
}

/** What `parallax remote …` prints for an answer (the pairing code only here). */
export function remoteLines(request: LauncherRemoteRequest, response: LauncherRemoteResponse): string[] {
  const lines: string[] = [];
  if (request.action === 'pair' && response.code !== null) {
    lines.push(`Pairing code: ${response.code}`);
    lines.push(
      `Valid until ${response.expiresAt ?? 'unknown'} - enter it on the controlling computer ` +
        '(Settings > Several computers > Add computer).',
    );
    lines.push(
      request.level === 'manage'
        ? 'Level: manage - it may also change settings, profiles and updates of this computer.'
        : 'Level: control - sessions, files and the terminal.',
    );
  }
  const state = response.remoteAccess;
  if (state === null) {
    lines.push('Sharing is off on this computer.');
    return lines;
  }
  lines.push(
    state.listening
      ? `Sharing is on - listening on port ${String(state.port ?? 0)}.`
      : `Sharing is on but not listening${state.error === null ? '' : ` (${state.error.code})`}.`,
  );
  lines.push(
    `Computer: ${state.hostName}; addresses: ${state.addresses.length === 0 ? 'none found' : state.addresses.join(', ')}.`,
  );
  lines.push(
    state.peer === null
      ? 'Not coupled.'
      : `Coupled with ${state.peer.name} (level ${state.peer.level}, since ${state.peer.pairedAt})` +
          `${state.peer.connected ? ', connected' : ''}.`,
  );
  if (state.pairingExpiresAt !== null && request.action !== 'pair') {
    lines.push(`A pairing window is open until ${state.pairingExpiresAt}.`);
  }
  for (const check of state.checks) {
    if (check.status !== 'ok') lines.push(`Check ${check.id}: ${check.status}.`);
  }
  if (state.unseenRejected > 0)
    lines.push(`Rejected attempts since last seen: ${String(state.unseenRejected)}.`);
  return lines;
}

/** `--apply-update`: the server configuration like a normal start, then the orchestrator. */
async function applyUpdateCli(
  apply: ApplyUpdateArgs,
  installRoot: string,
  serverArgv: readonly string[],
  deps: LauncherCliDeps,
): Promise<number> {
  const refuse = (message: string): number => {
    deps.out(handshakeLine({ kind: 'failed', reason: 'spawn' }));
    deps.fail(message);
    return 2;
  };
  let config: ServerConfig;
  try {
    config = loadConfig({
      argv: [...serverArgv],
      env: deps.env,
      ...(deps.cwd === undefined ? {} : { cwd: deps.cwd }),
    });
  } catch (error) {
    if (!(error instanceof ConfigError)) throw error;
    return refuse(`Invalid option: ${error.message}`);
  }
  if (config.dev) return refuse('--dev cannot be combined with --apply-update.');
  try {
    return await deps.applyUpdate({
      ...apply,
      installRoot,
      home: config.home,
      port: config.port,
      // Like a normal start of a package (WP-86): the new version gets the same flags.
      serverArgs: [...serverArgsFor(config), `--install-root=${installRoot}`],
      backend: config.backend,
      readyTimeoutMs: readyTimeoutMs(deps.env),
      toasts: config.toasts,
      notes: config.notes,
    });
  } catch (error) {
    // runApplyUpdate never throws; this is the last resort (stderr, not the handshake pipe).
    deps.fail(
      `Unexpected orchestrator error: ${error instanceof Error ? (error.stack ?? error.message) : String(error)}`,
    );
    return 1;
  }
}

function resultMessage(result: LauncherResult, config: ServerConfig, printUrl: boolean): string {
  const origin = serverOrigin(result.port);
  if (!result.window) {
    return result.mode === 'started'
      ? `Parallax runs on ${origin} (PID ${String(result.pid)}, data: ${config.home}) - no window (autostart).`
      : `Parallax already runs on ${origin} - no window (autostart).`;
  }
  return result.mode === 'started'
    ? `Parallax runs on ${origin} (PID ${String(result.pid)}, data: ${config.home}).`
    : `Parallax already runs on ${origin} - ${printUrl ? 'new sign-in code above' : 'opened another window'}.`;
}
