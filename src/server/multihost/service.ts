/**
 * `MultiHostService` – the role of this computer in "Several computers" (docs/wp/WP-75.md §4.1,
 * WP-76 §C.2, ADR-224): `off`, `share` (remote access, `remote/`) or `control` (host list, WP-79).
 *
 * `multiHost.configure` (only the given fields change):
 * - REMOTE_ROLE_CONFLICT {role} when the target role is `share` or `control` and the OTHER side still
 *   has couplings (`role` = that side). This covers share ↔ control directly and via `off` – a
 *   computer never holds couplings of both kinds (ADR-224, fail closed).
 * - The new side is activated first (switching to `share` runs its checks; REMOTE_KEYSTORE_UNAVAILABLE,
 *   REMOTE_ACCESS_FAILED), then the file is written. Any failure restores the previous side and
 *   config. Port and address changes of `share` restart the listener.
 * - Leaving a role (`off`, other role) closes everything of the old side; couplings stay.
 *
 * `start()` reads the file and activates the stored role (a failure is logged and shown by the side,
 * never fatal); `stop()` deactivates it. Calls are serialized.
 */
import type { Logger } from 'pino';
import { makeError } from '@shared/errors';
import { multiHostConfigSchema, type MultiHostConfig, type MultiHostRole } from '@shared/model';
import type { HostCommand } from '@shared/protocol';
import { logger as rootLogger } from '../lib/logger';
import type { StoreWarningSink } from '../store/jsonStore';
import { CommandError, type HostCommandHandler } from '../sync/ports';
import type { MultiHostService, RoleSide } from './ports';
import { MULTI_HOST_FILE, createMultiHostStore, type MultiHostStore } from './store';

/** A role side as this service uses it: `prepare` (read couplings before activation) and `onChange` are optional. */
export interface ManagedRoleSide extends RoleSide {
  /** Reads what `couplings()` needs (e.g. `remote/peer.json`) – called once by `start()`. */
  prepare?(): Promise<void>;
  onChange?(listener: () => void): () => void;
}

export interface MultiHostServiceOptions {
  home: string;
  share: ManagedRoleSide & { readonly role: 'share' };
  /** The controlling side (WP-79); without it `control` is refused (NOT_IMPLEMENTED). */
  control?: ManagedRoleSide & { readonly role: 'control' };
  store?: MultiHostStore;
  warnings?: StoreWarningSink;
  logger?: Logger;
}

function toCommandError(error: unknown): CommandError {
  return error instanceof CommandError ? error : new CommandError(makeError('INTERNAL_ERROR'));
}

export function createMultiHostService(options: MultiHostServiceOptions): MultiHostService {
  const log = (options.logger ?? rootLogger).child({ module: 'multiHost' });
  const store =
    options.store ??
    createMultiHostStore({
      home: options.home,
      ...(options.warnings === undefined ? {} : { warnings: options.warnings }),
      ...(options.logger === undefined ? {} : { logger: options.logger }),
    });
  const { share, control } = options;
  let config: MultiHostConfig = multiHostConfigSchema.parse({});
  const listeners = new Set<() => void>();

  const emit = (): void => {
    for (const listener of [...listeners]) {
      try {
        listener();
      } catch (error) {
        log.error({ err: error }, 'multi-host listener failed');
      }
    }
  };
  share.onChange?.(emit);
  control?.onChange?.(emit);

  let chain: Promise<unknown> = Promise.resolve();
  const serial = <T>(fn: () => Promise<T>): Promise<T> => {
    const run = chain.then(fn, fn);
    chain = run.catch(() => undefined);
    return run;
  };

  const sideOf = (role: MultiHostRole): ManagedRoleSide | null => {
    if (role === 'share') return share;
    if (role === 'control') return control ?? null;
    return null;
  };

  /** Brings the sides from `from` to `to` (deactivate the old one, activate the new one). */
  const switchSides = async (from: MultiHostConfig, to: MultiHostConfig): Promise<void> => {
    const oldSide = sideOf(from.role);
    const newSide = sideOf(to.role);
    if (oldSide !== null && oldSide !== newSide) await oldSide.deactivate();
    if (newSide !== null) await newSide.activate(to);
  };

  /** Best effort back to `previous` after a failed switch (errors are logged; the side shows its own). */
  const restore = async (failed: MultiHostConfig, previous: MultiHostConfig): Promise<void> => {
    const failedSide = sideOf(failed.role);
    const previousSide = sideOf(previous.role);
    try {
      if (failedSide !== null && failedSide !== previousSide) await failedSide.deactivate();
      if (previousSide !== null) await previousSide.activate(previous);
    } catch (error) {
      log.warn({ err: error, role: previous.role }, 'previous role could not be restored');
    }
  };

  const configure = (
    cmd: Extract<HostCommand, { name: 'multiHost.configure' }>,
  ): Promise<{ config: MultiHostConfig }> =>
    serial(async () => {
      const previous = config;
      const next = multiHostConfigSchema.parse({
        role: cmd.role ?? previous.role,
        port: cmd.port ?? previous.port,
        bindAddress: cmd.bindAddress ?? previous.bindAddress,
      });
      if (next.role === 'control' && control === undefined) {
        throw new CommandError(makeError('NOT_IMPLEMENTED', { feature: 'control' }));
      }
      // Exclusive roles: the other side must not hold couplings (ADR-224).
      if (next.role !== 'off') {
        const otherRole = next.role === 'share' ? 'control' : 'share';
        const other = sideOf(otherRole);
        if (other !== null && other.couplings() > 0) {
          throw new CommandError(makeError('REMOTE_ROLE_CONFLICT', { role: otherRole }));
        }
      }
      const blocked = store.blockedError();
      if (blocked !== null) throw new CommandError(blocked);
      try {
        await switchSides(previous, next);
      } catch (error) {
        await restore(next, previous);
        throw toCommandError(error);
      }
      try {
        await store.save(next);
      } catch (error) {
        log.error({ err: error }, 'multi-host.json not written');
        await restore(next, previous);
        throw new CommandError(makeError('STORE_WRITE_FAILED', { file: MULTI_HOST_FILE }));
      }
      config = next;
      log.info(
        { role: next.role, port: next.port, bindAddress: next.bindAddress },
        'multi-host role configured',
      );
      emit();
      return { config: next };
    });

  const commands: HostCommandHandler = {
    names: ['multiHost.configure'],
    handle: async (cmd) => {
      if (cmd.name !== 'multiHost.configure') {
        throw new CommandError(makeError('NOT_IMPLEMENTED', { command: cmd.name }));
      }
      return configure(cmd);
    },
  };

  return {
    config: () => config,
    commands,
    start: () =>
      serial(async () => {
        await Promise.all(
          [share, control].map(async (side) => {
            try {
              await side?.prepare?.();
            } catch (error) {
              log.error({ err: error, role: side?.role }, 'role side could not be prepared');
            }
          }),
        );
        config = await store.load();
        const side = sideOf(config.role);
        if (config.role !== 'off' && side === null)
          log.warn({ role: config.role }, 'stored role is not available');
        if (side !== null) {
          try {
            await side.activate(config);
          } catch (error) {
            log.error({ err: error, role: config.role }, 'stored role could not be activated');
          }
        }
        emit();
      }),
    stop: () =>
      serial(async () => {
        const side = sideOf(config.role);
        if (side === null) return;
        try {
          await side.deactivate();
        } catch (error) {
          log.warn({ err: error, role: config.role }, 'role side did not stop cleanly');
        }
      }),
    onChange(listener) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
  };
}
