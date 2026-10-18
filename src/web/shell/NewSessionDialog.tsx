import { useEffect, useRef, useSyncExternalStore, type SyntheticEvent } from 'react';
import type { ProfileId } from '@shared/common';
import { useT } from '@web/i18n';
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@web/ui/dialog';
import { NewSessionForm } from './NewSessionForm';
import { requestShell, useShellRequestHandler } from './requests';

/**
 * "New session" as a dialog (WP-36): the handler of the shell request `newSession`
 * (requests.ts) – the sidebar button, "New session in this project…" (pre-filled folder), the
 * playground. The empty state shows the same form inline. A real dialog (user action, Esc/close
 * return the focus); after "Create session" the focus goes into the new session's message field.
 */

/** Pre-filled values of one opening ("New session in this project…"). */
export interface NewSessionPrefill {
  cwd?: string;
  profileId?: ProfileId;
}

interface DialogState {
  open: boolean;
  prefill: NewSessionPrefill;
  /** New per opening: the form starts fresh with the prefill. */
  opening: number;
  /**
   * The element that had the focus when the dialog opened (e.g. the sidebar button): it gets the
   * focus back when the dialog closes without a new session (V3-04 – no DialogTrigger here, Radix
   * would leave the focus on `<body>`).
   */
  returnFocus: HTMLElement | null;
}

let state: DialogState = { open: false, prefill: {}, opening: 0, returnFocus: null };
const listeners = new Set<() => void>();

function emit(next: DialogState): void {
  state = next;
  for (const listener of [...listeners]) listener();
}

function focusedElement(): HTMLElement | null {
  return document.activeElement instanceof HTMLElement && document.activeElement !== document.body
    ? document.activeElement
    : null;
}

function show(prefill: NewSessionPrefill): void {
  emit({
    open: true,
    prefill,
    opening: state.opening + 1,
    returnFocus: state.open ? state.returnFocus : focusedElement(),
  });
}

function isEvent(value: NewSessionPrefill | SyntheticEvent | Event): value is SyntheticEvent | Event {
  return value instanceof Event || 'nativeEvent' in value;
}

/** Only the known fields with the right types (callers may pass a click event, see below). */
function cleanPrefill(value: NewSessionPrefill | SyntheticEvent | Event | undefined): NewSessionPrefill {
  if (value === undefined || isEvent(value)) return {};
  const prefill: NewSessionPrefill = {};
  if (typeof value.cwd === 'string' && value.cwd !== '') prefill.cwd = value.cwd;
  if (value.profileId !== undefined) prefill.profileId = value.profileId;
  return prefill;
}

/**
 * Opens "New session" through the request channel (`requestShell({kind: 'newSession', …})`).
 * Also usable directly as a click handler (`onClick={openNewSession}`): an event means "no
 * prefill". Without a mounted dialog the module state opens it once it mounts.
 */
export function openNewSession(prefill?: NewSessionPrefill | SyntheticEvent | Event): void {
  const clean = cleanPrefill(prefill);
  if (!requestShell({ kind: 'newSession', ...clean })) show(clean);
}

export function closeNewSession(): void {
  if (state.open) emit({ ...state, open: false });
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

function getState(): DialogState {
  return state;
}

/** Mounted once in the AppShell. */
export function NewSessionDialog() {
  const t = useT();
  const { open, prefill, opening, returnFocus } = useSyncExternalStore(subscribe, getState, getState);
  const created = useRef(false);
  useShellRequestHandler('newSession', (request) => {
    show(cleanPrefill({ cwd: request.cwd, profileId: request.profileId }));
    return true;
  });
  // The shell unmounts when the host goes away: never reopen on remount.
  useEffect(() => closeNewSession, []);
  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (next) show(prefill);
        else closeNewSession();
      }}
    >
      {open ? (
        <DialogContent
          data-slot="new-session-dialog"
          className="sm:max-w-lg"
          onOpenAutoFocus={() => {
            created.current = false;
          }}
          onCloseAutoFocus={(event) => {
            // The new session's message field takes the focus (NewSessionForm), not the opener.
            if (created.current) {
              event.preventDefault();
              return;
            }
            // Esc, X, click outside: back to where the dialog was opened from (V3-04).
            if (returnFocus?.isConnected !== true) return;
            event.preventDefault();
            returnFocus.focus();
          }}
        >
          <DialogHeader>
            <DialogTitle>{t('newSession.title')}</DialogTitle>
            <DialogDescription>{t('newSession.description')}</DialogDescription>
          </DialogHeader>
          <NewSessionForm
            key={opening}
            initialCwd={prefill.cwd ?? ''}
            initialProfileId={prefill.profileId}
            onCreated={() => {
              created.current = true;
              closeNewSession();
            }}
          />
        </DialogContent>
      ) : null}
    </Dialog>
  );
}
