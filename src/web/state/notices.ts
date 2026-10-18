import { useStore } from 'zustand';
import type { ErrorPayload } from '@shared/errors';
import type { TranslationKey, TranslationParams } from '@web/i18n';
import {
  clientStore,
  type ClientNotice,
  type ClientStore,
  type NoticeAction,
  type NoticeContent,
  type NoticeTone,
} from './store';

/**
 * Local in-app hints of this window (R1W-07, ADR-033): "copied", "prompt not sent",
 * DECISION_ALREADY_RESOLVED from another window, a setting that could not be saved … Features
 * never build their own toast regions; they call `showNotice` and the shell shows the hint in the
 * NotificationCenter region (bottom right, above modal dialogs; `role="status"`, errors
 * `role="alert"`). Texts are translation keys or error payloads and are translated when rendered
 * (language switch). Inline errors next to the triggering control stay fine for form validation;
 * a failed action of an open dialog shows inside that dialog (ADR-126). A notice may carry one
 * button (`action`, e.g. "Enable sounds").
 */

export type { ClientNotice, NoticeAction, NoticeContent, NoticeTone } from './store';

export interface NoticeOptions {
  /** Default: 'error' for `{ error }`, else 'info'. */
  tone?: NoticeTone;
  /** Session of the hint: the region offers "Show session". */
  sessionKey?: string | null;
  /** Auto-dismiss (default NOTICE_DURATION_MS, errors ERROR_NOTICE_DURATION_MS); null = until dismissed. */
  durationMs?: number | null;
  /** A notice with the same id is replaced (no stacking of repeated failures). */
  id?: string;
  /** A button of the notice (ADR-126); the notice closes after it ran. */
  action?: NoticeAction;
  store?: ClientStore;
}

export const NOTICE_DURATION_MS = 6000;
export const ERROR_NOTICE_DURATION_MS = 10_000;
/** Older notices are dropped beyond this number. */
export const MAX_NOTICES = 5;

const timers = new Map<string, ReturnType<typeof setTimeout>>();
let counter = 0;

function clearTimer(id: string): void {
  const timer = timers.get(id);
  if (timer !== undefined) clearTimeout(timer);
  timers.delete(id);
}

/** Shows a hint; returns its id (for `dismissNotice`). */
export function showNotice(content: NoticeContent, options: NoticeOptions = {}): string {
  const store = options.store ?? clientStore;
  const id = options.id ?? `notice-${String(++counter)}`;
  const isError = 'error' in content;
  const durationMs =
    options.durationMs === undefined
      ? isError
        ? ERROR_NOTICE_DURATION_MS
        : NOTICE_DURATION_MS
      : options.durationMs;
  const notice: ClientNotice = {
    id,
    tone: options.tone ?? (isError ? 'error' : 'info'),
    content,
    sessionKey: options.sessionKey ?? null,
    durationMs,
    ...(options.action === undefined ? {} : { action: options.action }),
  };
  store.setState((state) => ({
    notices: [...state.notices.filter((n) => n.id !== id), notice].slice(-MAX_NOTICES),
  }));
  clearTimer(id);
  if (durationMs !== null) {
    timers.set(
      id,
      setTimeout(() => {
        timers.delete(id);
        dismissNotice(id, store);
      }, durationMs),
    );
  }
  return id;
}

/** Shorthand: a translated text. */
export function showTextNotice(
  text: TranslationKey,
  params?: TranslationParams,
  options: NoticeOptions = {},
): string {
  return showNotice(params === undefined ? { text } : { text, params }, options);
}

/** Shorthand: an error payload (e.g. `errorPayloadOf(caught)` after a failed command). */
export function showErrorNotice(error: ErrorPayload, options: NoticeOptions = {}): string {
  return showNotice({ error }, options);
}

export function dismissNotice(id: string, store: ClientStore = clientStore): void {
  clearTimer(id);
  if (!store.getState().notices.some((n) => n.id === id)) return;
  store.setState((state) => ({ notices: state.notices.filter((n) => n.id !== id) }));
}

/** Current notices of this window, oldest first. */
export function useNotices(): readonly ClientNotice[] {
  return useStore(clientStore, (state) => state.notices);
}
