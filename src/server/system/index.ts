/**
 * `SystemIntegration` (port system/ports.ts; ADR-109, ADR-110): reconciles the autostart shortcut
 * (`settings.autostart.enabled`) and the protocol handler (`settings.notifications.openOnClick`)
 * with the settings – at server start and after every `settings.update` (WP-34/WP-40 call
 * `apply`). Steps run one after another (never two applies at once), never throw; failures become
 * host warnings `AUTOSTART_FAILED` / `PROTOCOL_HANDLER_FAILED` (`hostWarningSchema`, ids
 * `system:autostart` / `system:protocol`) and `onChange` fires when warnings or the registration
 * changed. A state that was reached is not re-applied (no PowerShell per unrelated setting).
 *
 * `available: false` (tests, dev, fake, another data directory – `systemIntegrationAvailable` in
 * config.ts) → `apply` does nothing, `toastLaunchUri` is null, no process is started. When the
 * server does not run on the default data directory (only with `--system-integration=on`), the
 * registered commands carry `--home=<home>`. A test run never reaches the real runner or
 * environment (system/run.ts, R6).
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
import { regAddValue, regDeleteKey, regQuery } from '../lib/registry';
import {
  autostartLinkExists,
  autostartLinkPath,
  createAutostartShortcut,
  launcherCommand,
  removeAutostartShortcut,
  type StartCommand,
} from './autostart';
import type { SystemIntegration } from './ports';
import {
  protocolCommand,
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
  /** PARALLAX_HOME of this server (→ `--home=` unless it is the default data directory). */
  home: string;
  /** Default `runFile` – never in a test run (system/run.ts). */
  run?: RunFileFn;
  platform?: NodeJS.Platform;
  /** APPDATA, LOCALAPPDATA, SystemRoot (default `process.env` – never in a test run). */
  env?: NodeJS.ProcessEnv;
  now?: () => Date;
  logger?: Logger;
  /** Seam for the start command (default `launcherCommand` with `realpath(process.execPath)`). */
  command?: (extra: readonly string[], home: string | null) => Promise<StartCommand>;
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
  const command =
    opts.command ??
    ((extra: readonly string[], home: string | null) => launcherCommand(opts.repoRoot, extra, { home }));
  const registry: ProtocolRegistryDeps = {
    query: regQuery(run),
    add: regAddValue(run),
    remove: regDeleteKey(run),
    env,
  };

  const warnings = new Map<WarningId, HostWarning>();
  const listeners = new Set<() => void>();
  let autostartReached: Reached = null;
  let protocolReached: Reached = null;
  let registered = false;
  let openOnClick = false;
  let queue: Promise<void> = Promise.resolve();

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

  const outcome = (result: SystemOpResult): string | null => (result.ok ? null : result.reason);

  const startCommand = async (extra: readonly string[]): Promise<StartCommand | string> => {
    try {
      return await command(extra, homeArg);
    } catch (error) {
      return `node.exe not resolvable: ${toError(error).message}`;
    }
  };

  const reconcileAutostart = async (enabled: boolean): Promise<void> => {
    const desired = enabled ? 'on' : 'off';
    if (autostartReached === desired) return;
    autostartReached = null;
    const link = autostartLinkPath(env);
    let reason: string | null;
    if (!enabled) {
      reason =
        link === null || !(await autostartLinkExists(link))
          ? null
          : outcome(await removeAutostartShortcut(link, { run, env }));
    } else if (platform !== 'win32') {
      reason = 'not Windows';
    } else if (link === null) {
      reason = 'APPDATA is not set';
    } else {
      const cmd = await startCommand(['--autostart']);
      reason =
        typeof cmd === 'string' ? cmd : outcome(await createAutostartShortcut(link, cmd, { run, env }));
    }
    setWarning(AUTOSTART_WARNING_ID, 'AUTOSTART_FAILED', reason);
    if (reason === null) {
      autostartReached = desired;
      log.info({ autostart: desired, link }, 'autostart reconciled');
    }
  };

  const reconcileProtocol = async (enabled: boolean): Promise<void> => {
    openOnClick = enabled;
    const desired = enabled ? 'on' : 'off';
    if (protocolReached === desired) return;
    protocolReached = null;
    let reason: string | null;
    if (!enabled) {
      // Toasts stop using the handler at once, also if the removal fails.
      registered = false;
      reason = platform === 'win32' ? outcome(await unregisterProtocolHandler(registry)) : null;
    } else if (platform !== 'win32') {
      reason = 'not Windows';
    } else {
      const cmd = await startCommand([]);
      reason =
        typeof cmd === 'string'
          ? cmd
          : outcome(await registerProtocolHandler(protocolCommand(cmd), registry));
      registered = reason === null;
    }
    setWarning(PROTOCOL_WARNING_ID, 'PROTOCOL_HANDLER_FAILED', reason);
    if (reason === null) {
      protocolReached = desired;
      log.info({ protocolHandler: desired }, 'protocol handler reconciled');
    }
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
