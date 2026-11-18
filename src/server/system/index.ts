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
 */
import type { Logger } from 'pino';
import type { EntryId } from '@shared/common';
import { makeError, type ErrorCode } from '@shared/errors';
import { sessionProtocolUri } from '@shared/http';
import type { HostWarning, Settings } from '@shared/model';
import { windowsPathsEqual } from '@shared/paths';
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
import { entryMarkers } from './markers';
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

export const AUTOSTART_WARNING_ID = 'system:autostart';
export const PROTOCOL_WARNING_ID = 'system:protocol';

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
  const homeArg = windowsPathsEqual(opts.home, defaultHome(env)) ? null : opts.home;
  const installRoot = opts.installRoot ?? null;
  const markers = entryMarkers(installRoot);
  const command =
    opts.command ??
    ((extra: readonly string[], home: string | null) =>
      installRoot === null
        ? launcherCommand(opts.repoRoot, extra, { home })
        : installedLauncherCommand(installRoot, extra, { home }));
  const registry: ProtocolRegistryDeps = {
    read: regKeyReader(run),
    add: regAddValue(run),
    remove: regDeleteKey(run),
    env,
    markers,
  };

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
    const link = autostartLinkPath(env);
    const cmd = enabled && platform === 'win32' && link !== null ? await startCommand(['--autostart']) : null;
    // ADR-229: the same wanted state, command and shortcut as last time → nothing to do.
    const state = async (): Promise<string | null> =>
      link === null || typeof cmd === 'string'
        ? null
        : fingerprint({ desired, cmd, link, file: await fileState(link) });
    const before = await state();
    if (before !== null && before === (await loadMemo()).autostart) {
      setWarning(AUTOSTART_WARNING_ID, 'AUTOSTART_FAILED', null);
      autostartReached = desired;
      return;
    }
    let reason: string | null;
    if (!enabled) {
      reason =
        link === null || !(await autostartLinkExists(link))
          ? null
          : outcome(await removeAutostartShortcut(link, { run, env, markers }), 'autostart');
    } else if (platform !== 'win32') {
      reason = 'not Windows';
    } else if (link === null) {
      reason = 'APPDATA is not set';
    } else if (typeof cmd === 'string' || cmd === null) {
      reason = cmd ?? 'no start command';
    } else {
      reason = outcome(await createAutostartShortcut(link, cmd, { run, env, markers }), 'autostart');
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
    const cmd = enabled && platform === 'win32' ? await startCommand([]) : null;
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
      reason = platform === 'win32' ? outcome(await unregisterProtocolHandler(registry), 'protocol') : null;
    } else if (platform !== 'win32') {
      reason = 'not Windows';
    } else {
      const result: SystemOpResult =
        typeof cmd === 'string' || cmd === null
          ? { ok: false, reason: cmd ?? 'no start command' }
          : await registerProtocolHandler(protocolCommand(cmd), registry);
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
    if (installRoot === null || startMenuChecked || platform !== 'win32') return;
    startMenuChecked = true;
    const cmd = await startCommand([], null);
    const link = startMenuLinkPath(env);
    // ADR-229: the shortcut of the last start, unchanged (same command, same file) → not rewritten.
    const state = async (): Promise<string | null> =>
      typeof cmd === 'string' || link === null
        ? null
        : fingerprint({ installRoot, cmd, link, file: await fileState(link) });
    const before = await state();
    if (before !== null && before === (await loadMemo()).startMenu) return;
    const result: SystemOpResult =
      typeof cmd === 'string'
        ? { ok: false, reason: cmd }
        : await ensureStartMenuEntry({ installRoot, run, env, command: cmd, markers });
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
