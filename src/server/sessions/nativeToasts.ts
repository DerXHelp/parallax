/**
 * Native toasts of the session engine (WP22-03/-15, Plan A.9): the channel when no window is open
 * or the chosen window cannot show Web Notifications (presence `systemNotifications: false`, e.g.
 * the permission prompt that the Edge app window never shows). The texts are the server's own (it
 * has no i18n): English/German after `settings.language`, mirroring `shell.notifications.kinds`
 * of the web. Calls run one after the other (one PowerShell at a time, a short queue). CR-05
 * (ADR-091): only a DETERMINISTIC failure (`permanent`: CLM/AppLocker, WinRT missing, no
 * PowerShell) switches the channel off for this server run – the host state then reports
 * `nativeNotifications: false` and the windows keep their in-app hints. Other failures (a timeout
 * under load, a failed `Show`/`History.Remove`) are counted; from the third one in a row the channel
 * pauses with a growing backoff (1 min, doubled, ≤ 15 min) and then tries again; a success resets
 * both. A click on the toast only dismisses it (Phase 1).
 */
import type { Logger } from 'pino';
import type { EntryId, Language } from '@shared/common';
import type { NotificationKind } from '@shared/status';
import { removeToast, showToast, type ToastRequest, type ToastResult } from '../lib/toast';

export interface NativeToasts {
  /** The channel can be used (enabled and not failed). */
  available(): boolean;
  show(entryId: EntryId, kind: NotificationKind, title: string): void;
  /** Takes the entry's toast out of the Action Center (only if one was shown). */
  clear(entryId: EntryId): void;
  /** Resolves when the queue is empty (tests, shutdown). */
  idle(): Promise<void>;
}

export const TOAST_TEXTS: Readonly<
  Record<Language, { kinds: Readonly<Record<NotificationKind, string>>; body: string }>
> = {
  en: {
    kinds: {
      permission: '{title} – needs permission',
      question: '{title} – has a question',
      plan: '{title} – plan ready for review',
      done: '{title} – done',
      error: '{title} – error',
      rate_limit: '{title} – rate limit reached',
    },
    body: 'Open Parallax to see the session.',
  },
  de: {
    kinds: {
      permission: '{title} – braucht eine Freigabe',
      question: '{title} – hat eine Frage',
      plan: '{title} – Plan prüfen',
      done: '{title} – fertig',
      error: '{title} – Fehler',
      rate_limit: '{title} – Rate-Limit erreicht',
    },
    body: 'Öffne Parallax, um die Session zu sehen.',
  },
};

/** Text of one toast (`{title}` replaced literally – CR-03: no `$&`/`$'` patterns of `replace`). */
export function toastText(language: Language, kind: NotificationKind, title: string): ToastRequest['title'] {
  return TOAST_TEXTS[language].kinds[kind].replace('{title}', () => title);
}

/** CR-05: transient failures in a row before the channel pauses. */
export const TOAST_FAILURE_THRESHOLD = 3;
/** First pause after `TOAST_FAILURE_THRESHOLD` failures in a row; doubled per further failure. */
export const TOAST_BACKOFF_MS = 60_000;
export const TOAST_BACKOFF_MAX_MS = 15 * 60_000;

export interface NativeToastOptions {
  /** config.toasts === 'native' (Windows, not under tests). */
  enabled: boolean;
  language: () => Language;
  log: Pick<Logger, 'info' | 'warn' | 'debug'>;
  /** Called once when the channel fails deterministically and is switched off (→ publish the host state). */
  onUnavailable?: () => void;
  /** Test seams (default lib/toast.ts, Date.now). */
  show?: (request: ToastRequest) => Promise<ToastResult>;
  remove?: (tag: string) => Promise<ToastResult>;
  now?: () => number;
  /** Pending calls at most; more are dropped (a burst of notifications must not queue PowerShells). */
  maxQueue?: number;
}

export const DISABLED_NATIVE_TOASTS: NativeToasts = {
  available: () => false,
  show: () => undefined,
  clear: () => undefined,
  idle: () => Promise.resolve(),
};

export function createNativeToasts(options: NativeToastOptions): NativeToasts {
  if (!options.enabled) return DISABLED_NATIVE_TOASTS;
  const show = options.show ?? ((request: ToastRequest) => showToast(request));
  const remove = options.remove ?? ((tag: string) => removeToast(tag));
  const maxQueue = options.maxQueue ?? 8;
  const now = options.now ?? (() => Date.now());
  let failed = false;
  /** CR-05: transient failures in a row, and the end of the current pause (0 = none). */
  let failures = 0;
  let pausedUntil = 0;
  let pending = 0;
  let chain: Promise<void> = Promise.resolve();
  /** Entries with a toast in the Action Center (only those are removed again). */
  const shown = new Set<EntryId>();

  const paused = (label: string): boolean => {
    if (now() >= pausedUntil) return false;
    options.log.debug(
      { label, pausedUntil: new Date(pausedUntil).toISOString() },
      'native toast skipped (paused)',
    );
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
      options.log.warn(
        { label, reason: result.reason },
        'native Windows toast failed – notifications stay in-app for this server run',
      );
      options.onUnavailable?.();
      return;
    }
    failures += 1;
    const pauseMs =
      failures < TOAST_FAILURE_THRESHOLD
        ? 0
        : Math.min(TOAST_BACKOFF_MS * 2 ** (failures - TOAST_FAILURE_THRESHOLD), TOAST_BACKOFF_MAX_MS);
    pausedUntil = pauseMs === 0 ? 0 : now() + pauseMs;
    options.log.warn(
      { label, reason: result.reason, failures, pauseMs },
      'native Windows toast failed – the channel stays on',
    );
  };

  const enqueue = (label: string, work: () => Promise<ToastResult>): void => {
    if (failed || paused(label)) return;
    if (pending >= maxQueue) {
      options.log.debug({ label }, 'native toast dropped (queue full)');
      return;
    }
    pending += 1;
    chain = chain
      .then(async () => {
        if (failed || paused(label)) return;
        onResult(label, await work());
      })
      .catch((error: unknown) => {
        options.log.warn({ err: error, label }, 'native toast failed');
      })
      .finally(() => {
        pending -= 1;
      });
  };

  return {
    available: () => !failed,
    show(entryId, kind, title) {
      const text = toastText(options.language(), kind, title);
      options.log.info({ entryId, kind }, 'native toast');
      shown.add(entryId);
      enqueue('show', () => show({ title: text, body: TOAST_TEXTS[options.language()].body, tag: entryId }));
    },
    clear(entryId) {
      if (!shown.delete(entryId)) return;
      enqueue('remove', () => remove(entryId));
    },
    idle: () => chain,
  };
}
