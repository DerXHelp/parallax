/**
 * `SystemIntegration` (port system/ports.ts; ADR-109, ADR-110): reconciles the autostart shortcut
 * (`settings.autostart.enabled`) and the protocol handler (`settings.notifications.openOnClick`)
 * with the settings – at server start and after every `settings.update` (WP-34/WP-40 call
 * `apply`). Steps run one after another (never two applies at once), never throw; failures become
 * host warnings `AUTOSTART_FAILED` / `PROTOCOL_HANDLER_FAILED` (`hostWarningSchema`, ids
 * `system:autostart` / `system:protocol`) and `onChange` fires when warnings or the registration
 * changed. A state that was reached is not re-applied (no PowerShell per unrelated setting) – also
 * not across server starts (ADR-229, system/memo.ts): with the fingerprint of the last reached state
 * unchanged, a start runs neither PowerShell nor reg.exe.
 *
 * `available: false` (tests, dev, fake, another data directory – `systemIntegrationAvailable` in
 * config.ts) → `apply` does nothing, `toastLaunchUri` is null, no process is started. When the
 * server does not run on the default data directory (only with `--system-integration=on`), the
 * registered commands carry `--home=<home>`. A test run never reaches the real runner or
 * environment (system/run.ts, R6).
 *
 * WP-86: with `installRoot` (a server of an installation) the commands start `<root>\start.mjs`
 * (`installedLauncherCommand`), old clone entries are bent over, and the first apply ensures the
 * start menu shortcut (no setting; failures only logged – there is no error code for it). Without
 * `installRoot` (clone/development) an installation's entries are left alone – no warning, only
 * an info log (system/markers.ts).
 *
 * Linux (WP-106, WP-100 §5.8): the same reconciliation over the freedesktop entries (system/xdg.ts) –
 * autostart `~/.config/autostart/parallax.desktop`, protocol handler `parallax-url-handler.desktop` +
 * `xdg-mime default`, program entry `~/.local/share/applications/parallax.desktop` for an
 * installation. Both platforms implement `IntegrationOps`; other platforms get none (a warning
 * `unsupported platform` when something is switched on).
 */
import type { Logger } from 'pino';
import type { EntryId } from '@shared/common';
import { makeError, type ErrorCode } from '@shared/errors';
import { sessionProtocolUri } from '@shared/http';
import type { HostWarning, Settings } from '@shared/model';
import { pathFlavorOf, pathRules } from '@shared/paths';
import { defaultHome } from '../config';
import { toError } from '../lib/async';
import { logger as rootLogger } from '../lib/logger';
import type { RunFileFn } from '../lib/process';
import { regAddValue, regDeleteKey } from '../lib/registry';
import {
  autostartLinkExists,
  autostartLinkPath,
  createAutostartShortcut,
  installedLauncherCommand,
  launcherCommand,
  removeAutostartShortcut,
  startMenuLinkPath,
  type StartCommand,
} from './autostart';
import { ensureStartMenuEntry } from './installation';
import { entryMarkers, installIconPath, type EntryMarkers } from './markers';
import { fileState, fingerprint, systemMemo, type SystemMemo, type SystemMemoData } from './memo';
import type { SystemIntegration } from './ports';
import {
  protocolCommand,
  regKeyReader,
  registerProtocolHandler,
  unregisterProtocolHandler,
  type ProtocolRegistryDeps,
} from './protocol';
import { systemEnv, systemRunner, type SystemOpResult } from './run';
import {
  HOME_MISSING,
  autostartEntryPath,
  createAutostartEntry,
  ensureProgramEntry,
  nodeDesktopFs,
  programEntryPath,
  registerUrlHandler,
  removeAutostartEntry,
  unregisterUrlHandler,
  type DesktopFs,
} from './xdg';

export const AUTOSTART_WARNING_ID = 'system:autostart';
export const PROTOCOL_WARNING_ID = 'system:protocol';
/** Reason of a switched-on integration on a platform without one (neither Windows nor Linux). */
export const UNSUPPORTED_PLATFORM = 'unsupported platform';

/**
 * The entries of one platform (WP-106): Windows shortcuts + registry, Linux `.desktop` files +
 * `xdg-mime`. No call throws (failures are results).
 */
export interface IntegrationOps {
  /** Reason when the autostart location is unknown (`APPDATA is not set`, `HOME is not set`). */
  readonly noLocation: string;
  autostartPath(): string | null;
  autostartExists(link: string): Promise<boolean>;
  createAutostart(link: string, command: StartCommand): Promise<SystemOpResult>;
  removeAutostart(link: string): Promise<SystemOpResult>;
  registerProtocol(command: StartCommand): Promise<SystemOpResult>;
  unregisterProtocol(): Promise<SystemOpResult>;
  /** Start menu shortcut / program entry of an installation. */
  programEntryPath(): string | null;
  ensureProgramEntry(installRoot: string, command: StartCommand): Promise<SystemOpResult>;
  /** Size and time of an entry file for the ADR-229 memo. */
  fileState(file: string): Promise<string>;
}

export interface IntegrationOpsDeps {
  run: RunFileFn;
  env: NodeJS.ProcessEnv;
  markers: EntryMarkers;
  /** Linux: file access of the `.desktop` entries (default the real file system). */
  fs?: DesktopFs;
}

/** Windows (WP-33, WP-86): `.lnk` shortcuts per PowerShell, the handler per reg.exe. */
export function windowsIntegrationOps(deps: IntegrationOpsDeps): IntegrationOps {
  const { run, env, markers } = deps;
  const registry: ProtocolRegistryDeps = {
    read: regKeyReader(run),
    add: regAddValue(run),
    remove: regDeleteKey(run),
    env,
    markers,
  };
  return {
    noLocation: 'APPDATA is not set',
    autostartPath: () => autostartLinkPath(env),
    autostartExists: autostartLinkExists,
    createAutostart: (link, command) => createAutostartShortcut(link, command, { run, env, markers }),
    removeAutostart: (link) => removeAutostartShortcut(link, { run, env, markers }),
    registerProtocol: (command) => registerProtocolHandler(protocolCommand(command), registry),
    unregisterProtocol: () => unregisterProtocolHandler(registry),
    programEntryPath: () => startMenuLinkPath(env),
    ensureProgramEntry: (installRoot, command) =>
      ensureStartMenuEntry({ installRoot, run, env, command, markers, platform: 'win32' }),
    fileState,
  };
}

/** Linux (WP-106): `.desktop` files and `xdg-mime` (system/xdg.ts). */
export function linuxIntegrationOps(deps: IntegrationOpsDeps): IntegrationOps {
  const fs = deps.fs ?? nodeDesktopFs;
  const xdg = { run: deps.run, env: deps.env, markers: deps.markers, fs };
  const exists = async (file: string): Promise<boolean> => {
    try {
      return (await fs.readText(file)) !== null;
    } catch {
      // Unreadable: the removal tries it and reports the failure.
      return true;
    }
  };
  return {
    noLocation: HOME_MISSING,
    autostartPath: () => autostartEntryPath(deps.env),
    autostartExists: exists,
    createAutostart: (file, command) => createAutostartEntry(file, command, xdg),
    removeAutostart: (file) => removeAutostartEntry(file, xdg),
    registerProtocol: (command) => registerUrlHandler(command, xdg),
    unregisterProtocol: () => unregisterUrlHandler(xdg),
    programEntryPath: () => programEntryPath(deps.env),
    ensureProgramEntry: (installRoot, command) =>
      ensureProgramEntry(command, installIconPath(installRoot), xdg),
    fileState: (file) => fs.state(file),
  };
}

/** The entries of `platform`, or null where Parallax has none. */
export function integrationOpsFor(
  platform: NodeJS.Platform,
  deps: IntegrationOpsDeps,
): IntegrationOps | null {
  if (platform === 'win32') return windowsIntegrationOps(deps);
  if (platform === 'linux') return linuxIntegrationOps(deps);
  return null;
}

export interface SystemIntegrationOptions {
  /** HostState.systemIntegration (`systemIntegrationAvailable(config)`). */
  available: boolean;
  /** Repo root (launcher, tsx, tsconfig). */
  repoRoot: string;
  /**
   * Root folder of an installation (`--install-root`, WP-86): entries start `<root>\start.mjs`
   * and the start menu shortcut is kept. Default null = clone/development (`launcherCommand`).
   */
  installRoot?: string | null;
  /** PARALLAX_HOME of this server (→ `--home=` unless it is the default data directory). */
  home: string;
  /** Default `runFile` – never in a test run (system/run.ts). */
  run?: RunFileFn;
  platform?: NodeJS.Platform;
  /** APPDATA, LOCALAPPDATA, SystemRoot (default `process.env` – never in a test run). */
  env?: NodeJS.ProcessEnv;
  now?: () => Date;
  logger?: Logger;
  /**
   * Seam for the start command (default `launcherCommand`, with `installRoot`
   * `installedLauncherCommand` – both with `realpath(process.execPath)`).
   */
  command?: (extra: readonly string[], home: string | null) => Promise<StartCommand>;
  /** What the last start reached (default `<home>/system-integration.json`; memory in a test run). */
  memo?: SystemMemo;
  /** Linux: file access of the `.desktop` entries (default the real file system; tests: memory). */
  desktopFs?: DesktopFs;
}

type WarningId = typeof AUTOSTART_WARNING_ID | typeof PROTOCOL_WARNING_ID;
type Reached = 'on' | 'off' | null;

export function createSystemIntegration(opts: SystemIntegrationOptions): SystemIntegration {
  const log = (opts.logger ?? rootLogger).child({ module: 'system' });
  const available = opts.available;
  const run = systemRunner(opts.run);
  const env = systemEnv(opts.env);
  const platform = opts.platform ?? process.platform;
  const now = opts.now ?? (() => new Date());
  const rules = pathRules(pathFlavorOf(platform));
  const homeArg = rules.equal(opts.home, defaultHome(env, platform)) ? null : opts.home;
  const installRoot = opts.installRoot ?? null;
  const markers = entryMarkers(installRoot, rules.flavor);
  const command =
    opts.command ??
    ((extra: readonly string[], home: string | null) =>
      installRoot === null
        ? launcherCommand(opts.repoRoot, extra, { home })
        : installedLauncherCommand(installRoot, extra, { home }));
  const ops = integrationOpsFor(platform, {
    run,
    env,
    markers,
    ...(opts.desktopFs === undefined ? {} : { fs: opts.desktopFs }),
  });

  const warnings = new Map<WarningId, HostWarning>();
  const listeners = new Set<() => void>();
  let autostartReached: Reached = null;
  let protocolReached: Reached = null;
  let registered = false;
  let openOnClick = false;
  /** The start menu shortcut is ensured once per server start (only with `installRoot`). */
  let startMenuChecked = false;
  let queue: Promise<void> = Promise.resolve();
  const memoStore = systemMemo(opts.memo, opts.home, log);
  let memo: SystemMemoData | null = null;
  const loadMemo = async (): Promise<SystemMemoData> => {
    memo ??= await memoStore.read();
    return memo;
  };
  const remember = async (patch: Partial<SystemMemoData>): Promise<void> => {
    memo = { ...(await loadMemo()), ...patch };
    await memoStore.write(memo);
  };

  const setWarning = (id: WarningId, code: ErrorCode, reason: string | null): void => {
    if (reason === null) {
      warnings.delete(id);
      return;
    }
    const existing = warnings.get(id);
    if (existing?.error.code === code && existing.error.params.reason === reason) return;
    warnings.set(id, { id, error: makeError(code, { reason }), at: now().toISOString() });
    log.warn({ id, reason }, 'system integration failed');
  };

  /** Failure reason, or null; a deferred entry (an installation's, seen from a clone) is logged. */
  const outcome = (result: SystemOpResult, entry: string): string | null => {
    if (!result.ok) return result.reason;
    if (result.deferred === true) log.info({ entry }, 'entry belongs to an installation - left alone');
    return null;
  };

  const startCommand = async (
    extra: readonly string[],
    home: string | null = homeArg,
  ): Promise<StartCommand | string> => {
    try {
      return await command(extra, home);
    } catch (error) {
      return `node.exe not resolvable: ${toError(error).message}`;
    }
  };

  const reconcileAutostart = async (enabled: boolean): Promise<void> => {
    const desired = enabled ? 'on' : 'off';
    if (autostartReached === desired) return;
    autostartReached = null;
    const link = ops === null ? null : ops.autostartPath();
    const cmd = enabled && ops !== null && link !== null ? await startCommand(['--autostart']) : null;
    // ADR-229: the same wanted state, command and shortcut as last time → nothing to do.
    const state = async (): Promise<string | null> =>
      ops === null || link === null || typeof cmd === 'string'
        ? null
        : fingerprint({ desired, cmd, link, file: await ops.fileState(link) });
    const before = await state();
    if (before !== null && before === (await loadMemo()).autostart) {
      setWarning(AUTOSTART_WARNING_ID, 'AUTOSTART_FAILED', null);
      autostartReached = desired;
      return;
    }
    let reason: string | null;
    if (!enabled) {
      reason =
        ops === null || link === null || !(await ops.autostartExists(link))
          ? null
          : outcome(await ops.removeAutostart(link), 'autostart');
    } else if (ops === null) {
      reason = UNSUPPORTED_PLATFORM;
    } else if (link === null) {
      reason = ops.noLocation;
    } else if (typeof cmd === 'string' || cmd === null) {
      reason = cmd ?? 'no start command';
    } else {
      reason = outcome(await ops.createAutostart(link, cmd), 'autostart');
    }
    setWarning(AUTOSTART_WARNING_ID, 'AUTOSTART_FAILED', reason);
    if (reason === null) {
      autostartReached = desired;
      await remember({ autostart: await state() });
      log.info({ autostart: desired, link }, 'autostart reconciled');
    }
  };

  const reconcileProtocol = async (enabled: boolean): Promise<void> => {
    openOnClick = enabled;
    const desired = enabled ? 'on' : 'off';
    if (protocolReached === desired) return;
    protocolReached = null;
    const cmd = enabled && ops !== null ? await startCommand([]) : null;
    // ADR-229: the registry is not read at every start – the same wanted state and command as last
    // time count as reached (an entry changed by hand is repaired with the next setting change).
    const state = typeof cmd === 'string' ? null : fingerprint({ desired, cmd, platform });
    const known = await loadMemo();
    if (state !== null && state === known.protocol) {
      registered = enabled && known.registered;
      setWarning(PROTOCOL_WARNING_ID, 'PROTOCOL_HANDLER_FAILED', null);
      protocolReached = desired;
      return;
    }
    let reason: string | null;
    if (!enabled) {
      // Toasts stop using the handler at once, also if the removal fails.
      registered = false;
      reason = ops === null ? null : outcome(await ops.unregisterProtocol(), 'protocol');
    } else if (ops === null) {
      reason = UNSUPPORTED_PLATFORM;
    } else {
      const result: SystemOpResult =
        typeof cmd === 'string' || cmd === null
          ? { ok: false, reason: cmd ?? 'no start command' }
          : await ops.registerProtocol(cmd);
      reason = outcome(result, 'protocol');
      // An installation's handler (deferred) is not this server's: toasts get no launch URI.
      registered = result.ok && result.deferred !== true;
    }
    setWarning(PROTOCOL_WARNING_ID, 'PROTOCOL_HANDLER_FAILED', reason);
    if (reason === null) {
      protocolReached = desired;
      await remember({ protocol: state, registered });
      log.info({ protocolHandler: desired }, 'protocol handler reconciled');
    }
  };

  /**
   * WP-86: the start menu shortcut of an installation, once per server start and independent of
   * the settings (a node update repairs itself); always on the default data directory (no
   * `--home`, like the installer's). Failures are only logged – no host warning, no error code.
   */
  const ensureStartMenu = async (): Promise<void> => {
    if (installRoot === null || startMenuChecked || ops === null) return;
    startMenuChecked = true;
    const cmd = await startCommand([], null);
    const link = ops.programEntryPath();
    // ADR-229: the shortcut of the last start, unchanged (same command, same file) → not rewritten.
    const state = async (): Promise<string | null> =>
      typeof cmd === 'string' || link === null
        ? null
        : fingerprint({ installRoot, cmd, link, file: await ops.fileState(link) });
    const before = await state();
    if (before !== null && before === (await loadMemo()).startMenu) return;
    const result: SystemOpResult =
      typeof cmd === 'string'
        ? { ok: false, reason: cmd }
        : link === null
          ? { ok: false, reason: ops.noLocation }
          : await ops.ensureProgramEntry(installRoot, cmd);
    if (result.ok) {
      await remember({ startMenu: await state() });
      log.info({ installRoot }, 'start menu shortcut ensured');
    } else log.warn({ installRoot, reason: result.reason }, 'start menu shortcut failed');
  };

  const snapshot = (): string => JSON.stringify({ registered, warnings: [...warnings.values()] });

  const emit = (): void => {
    for (const listener of [...listeners]) {
      try {
        listener();
      } catch (error) {
        log.error({ err: error }, 'system integration listener failed');
      }
    }
  };

  const reconcile = async (settings: Settings): Promise<void> => {
    const before = snapshot();
    try {
      await reconcileAutostart(settings.autostart.enabled);
      await reconcileProtocol(settings.notifications.openOnClick);
      await ensureStartMenu();
    } catch (error) {
      log.error({ err: error }, 'system integration: unexpected failure');
    }
    if (snapshot() !== before) emit();
  };

  return {
    available,
    apply: (settings) => {
      if (!available) return Promise.resolve();
      const job = queue.then(() => reconcile(settings));
      queue = job;
      return job;
    },
    toastLaunchUri: (entryId: EntryId) =>
      available && openOnClick && registered ? sessionProtocolUri(entryId) : null,
    warnings: () => [...warnings.values()],
    onChange: (listener) => {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
  };
}
