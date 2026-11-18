/**
 * The watcher's toasts on the controlling computer (WP-81, ADR-211, docs/wp/WP-75.md §4.6): a sharing
 * computer sends `notify{delivery:'system'}` to the watcher where it would otherwise show a native
 * toast nobody sees (the user was last here). This module listens to `HostsService.onRelay` and shows
 * that toast with the native Windows helper (lib/toast.ts):
 *
 * - texts in the language of THIS computer (`toastText` of the engine's toasts, plus a body that
 *   names the other computer);
 * - THIS computer's filters: "Do not disturb" and `events[kind].toast` → no toast, `events[kind].sound`
 *   off → silent. The "done" threshold was applied by the sharing computer;
 * - a click opens the session (`parallax://session/<hostId>/<entryId>`) only where the engine's
 *   toasts are clickable: the system integration says so for one entry (`toastLaunchUri` non-null =
 *   `openOnClick` on and the protocol handler registered, productive server only, ADR-109);
 * - the tag is unique per computer and session (`relayToastTag`, never an entry id of this
 *   computer); `clear` takes the toast out of the Action Center; a computer that leaves the list
 *   (removed, role left → `list()` empty) takes all its toasts with it.
 *
 * A sharing computer is not trusted to be gentle (security review WP-81): one toast per computer
 * and session at a time (same tag → Windows replaces it, never a stack), at most
 * `RELAY_TOAST_RATE.max` toasts per computer within `RELAY_TOAST_RATE.windowMs` (more are dropped,
 * logged throttled), the title cut to `LIMITS.titleChars`; texts only as text nodes of the toast
 * helper (lib/toast.ts: environment variables, DOM, no script or XML from data).
 *
 * Calls run one after the other in an own short queue (a second PowerShell at most next to the
 * engine's toasts). A permanent failure (CR-05) switches it off for this server run, so does a
 * permanent failure of the engine's channel (`available`); transient failures pause it like the
 * engine's toasts. Never logged: titles and computer names.
 */
import { createHash } from 'node:crypto';
import type { Logger } from 'pino';
import { LIMITS, type EntryId, type HostId, type Language } from '@shared/common';
import { hostSessionProtocolUri } from '@shared/http';
import type { Settings } from '@shared/model';
import type { Notification } from '@shared/protocol';
import { logger as rootLogger, shouldLogRepeated } from '../lib/logger';
import { removeToast, showToast, type ToastRequest, type ToastResult } from '../lib/toast';
import {
  TOAST_BACKOFF_MAX_MS,
  TOAST_BACKOFF_MS,
  TOAST_FAILURE_THRESHOLD,
  toastText,
} from '../sessions/nativeToasts';
import type { SystemIntegration } from '../system/ports';
import type { HostsService } from './ports';

/** Second line of a watcher toast (`{host}` = the name of the other computer in the host list). */
export const RELAY_TOAST_BODY: Readonly<Record<Language, string>> = {
  en: 'On {host}. Open Parallax to see the session.',
  de: 'Auf {host}. Öffne Parallax, um die Session zu sehen.',
};

/**
 * Toast tag of one session of another computer: `rl_` + 32 hex of SHA-256(`<hostId>:<entryId>`) –
 * unique per computer and session, ≤ 64 characters (`hostId:entryId` may be longer) and never equal
 * to an entry id (the tags of this computer's own toasts).
 */
export function relayToastTag(hostId: HostId, entryId: EntryId): string {
  return `rl_${createHash('sha256').update(`${hostId}:${entryId}`).digest('hex').slice(0, 32)}`;
}

/** Toasts per computer within the window at most (security review WP-81); more are dropped. */
export const RELAY_TOAST_RATE: Readonly<{ max: number; windowMs: number }> = Object.freeze({
  max: 10,
  windowMs: 60_000,
});

/** Why a watcher notification shows no toast (debug log). */
export type RelayToastFilter = 'delivery' | 'do_not_disturb' | 'toast_off' | 'unavailable' | 'unknown_host';

export interface RelayToastsOptions {
  hosts: Pick<HostsService, 'onRelay' | 'onChange' | 'list'>;
  /** The settings of this computer at the time of the toast. */
  settings: () => Settings;
  /** `config.toasts === 'native'` (Windows, not under tests/E2E). */
  enabled: boolean;
  /** The engine's channel (`NativeToasts.available`): its permanent failure holds here too. */
  available?: () => boolean;
  /** Click target (ADR-109); absent/null → a click only dismisses. */
  system?: Pick<SystemIntegration, 'toastLaunchUri'> | null;
  logger?: Logger;
  /** Test seams (default lib/toast.ts, Date.now). */
  show?: (request: ToastRequest) => Promise<ToastResult>;
  remove?: (tag: string) => Promise<ToastResult>;
  now?: () => number;
  /** Pending calls at most; more are dropped (default 16 – all toasts of a removed computer fit). */
  maxQueue?: number;
  /** Rate limit per computer (default `RELAY_TOAST_RATE`). */
  rate?: { max: number; windowMs: number };
}

export interface RelayToasts {
  /** Stops listening (server shutdown); toasts already shown stay in the Action Center. */
  close(): void;
  /** Resolves when the queue is empty (tests, shutdown). */
  idle(): Promise<void>;
}

export function createRelayToasts(options: RelayToastsOptions): RelayToasts {
  const log = (options.logger ?? rootLogger).child({ module: 'relayToasts' });
  const show = options.show ?? ((request: ToastRequest) => showToast(request));
  const remove = options.remove ?? ((tag: string) => removeToast(tag));
  const now = options.now ?? (() => Date.now());
  const maxQueue = options.maxQueue ?? 16;
  let closed = false;
  let failed = false;
  let failures = 0;
  let pausedUntil = 0;
  let pending = 0;
  let chain: Promise<void> = Promise.resolve();
  /** Tags of toasts in the Action Center → their computer (only those are removed again). */
  const shown = new Map<string, HostId>();
  const rate = options.rate ?? RELAY_TOAST_RATE;
  /** Times of the recent toasts per computer (within `rate.windowMs`). */
  const recent = new Map<HostId, number[]>();
  /** Toasts dropped by the rate limit per computer (throttled log). */
  const dropped = new Map<HostId, number>();

  /** Counts one toast for `hostId`; false = over the limit (dropped). */
  const admit = (hostId: HostId): boolean => {
    const t = now();
    const times = (recent.get(hostId) ?? []).filter((at) => t - at < rate.windowMs);
    if (times.length >= rate.max) {
      recent.set(hostId, times);
      const count = (dropped.get(hostId) ?? 0) + 1;
      dropped.set(hostId, count);
      if (shouldLogRepeated(count)) {
        log.warn(
          { hostId, dropped: count, max: rate.max, windowMs: rate.windowMs },
          'relay toasts throttled',
        );
      }
      return false;
    }
    times.push(t);
    recent.set(hostId, times);
    return true;
  };

  const usable = (): boolean => options.enabled && !failed && (options.available?.() ?? true);

  const paused = (label: string): boolean => {
    if (now() >= pausedUntil) return false;
    log.debug({ label, pausedUntil: new Date(pausedUntil).toISOString() }, 'relay toast skipped (paused)');
    return true;
  };

  const onResult = (label: string, result: ToastResult): void => {
    if (result.kind !== 'failed') {
      failures = 0;
      pausedUntil = 0;
      return;
    }
    if (result.permanent) {
      failed = true;
      log.warn({ label, reason: result.reason }, 'relay toast failed – off for this server run');
      return;
    }
    failures += 1;
    const pauseMs =
      failures < TOAST_FAILURE_THRESHOLD
        ? 0
        : Math.min(TOAST_BACKOFF_MS * 2 ** (failures - TOAST_FAILURE_THRESHOLD), TOAST_BACKOFF_MAX_MS);
    pausedUntil = pauseMs === 0 ? 0 : now() + pauseMs;
    log.warn({ label, reason: result.reason, failures, pauseMs }, 'relay toast failed');
  };

  const enqueue = (label: 'show' | 'remove', work: () => Promise<ToastResult>): void => {
    if (!usable() || paused(label)) return;
    if (pending >= maxQueue) {
      log.debug({ label }, 'relay toast dropped (queue full)');
      return;
    }
    pending += 1;
    chain = chain
      .then(async () => {
        if (!usable() || paused(label)) return;
        onResult(label, await work());
      })
      .catch((error: unknown) => {
        log.warn({ err: error, label }, 'relay toast failed');
      })
      .finally(() => {
        pending -= 1;
      });
  };

  const removeTag = (tag: string): void => {
    if (!shown.delete(tag)) return;
    enqueue('remove', () => remove(tag));
  };

  const filterOf = (notification: Notification, settings: Settings): RelayToastFilter | null => {
    const rules = settings.notifications;
    if (notification.delivery !== 'system') return 'delivery';
    if (rules.doNotDisturb) return 'do_not_disturb';
    if (!rules.events[notification.kind].toast) return 'toast_off';
    if (!usable()) return 'unavailable';
    return null;
  };

  const notify = (hostId: HostId, notification: Notification): void => {
    if (closed) return;
    const { entryId, kind } = notification;
    const settings = options.settings();
    const host = options.hosts.list().find((candidate) => candidate.hostId === hostId);
    const filter = host === undefined ? 'unknown_host' : filterOf(notification, settings);
    if (host === undefined || filter !== null) {
      log.debug({ hostId, entryId, kind, filter }, 'relay toast filtered');
      return;
    }
    if (!admit(hostId)) return;
    const language = settings.language;
    const launchUri =
      (options.system?.toastLaunchUri(entryId) ?? null) === null
        ? null
        : hostSessionProtocolUri(hostId, entryId);
    const silent = !settings.notifications.events[kind].sound;
    const title = (notification.title.trim() === '' ? host.name : notification.title).slice(
      0,
      LIMITS.titleChars,
    );
    const tag = relayToastTag(hostId, entryId);
    log.info({ hostId, entryId, kind, click: launchUri !== null, silent }, 'relay toast');
    shown.set(tag, hostId);
    const request: ToastRequest = {
      title: toastText(language, kind, title),
      body: RELAY_TOAST_BODY[language].replace('{host}', () => host.name),
      tag,
      launchUri,
      silent,
    };
    enqueue('show', () => show(request));
  };

  /** Computers that left the list (removed, role left): their toasts go too. */
  const prune = (): void => {
    if (closed) return;
    const present = new Set(options.hosts.list().map((host) => host.hostId));
    for (const [tag, hostId] of [...shown]) {
      if (!present.has(hostId)) removeTag(tag);
    }
    for (const hostId of [...recent.keys()]) {
      if (present.has(hostId)) continue;
      recent.delete(hostId);
      dropped.delete(hostId);
    }
  };

  const stopRelay = options.hosts.onRelay({
    notify,
    clear: (hostId, entryId) => {
      if (!closed) removeTag(relayToastTag(hostId, entryId));
    },
  });
  const stopChange = options.hosts.onChange(prune);

  return {
    close() {
      if (closed) return;
      closed = true;
      stopRelay();
      stopChange();
    },
    idle: () => chain,
  };
}
