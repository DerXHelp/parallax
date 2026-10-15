import { useEffect, useRef, useSyncExternalStore } from 'react';
import { useT } from '@web/i18n';
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@web/ui/dialog';
import { NewSessionForm } from './NewSessionForm';

/**
 * "New session" as a dialog, opened from the sidebar (`openNewSession`); the empty state shows
 * the same form inline. A real dialog (user action, Esc/close return the focus to the button);
 * after "Create session" the focus goes into the new session's message field instead.
 */

let open = false;
const listeners = new Set<() => void>();

function setOpen(next: boolean): void {
  if (open === next) return;
  open = next;
  for (const listener of [...listeners]) listener();
}

export function openNewSession(): void {
  setOpen(true);
}

export function closeNewSession(): void {
  setOpen(false);
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

function getOpen(): boolean {
  return open;
}

/** Mounted once in the AppShell. */
export function NewSessionDialog() {
  const t = useT();
  const isOpen = useSyncExternalStore(subscribe, getOpen, getOpen);
  const created = useRef(false);
  // The shell unmounts when the host goes away: never reopen on remount.
  useEffect(() => closeNewSession, []);
  return (
    <Dialog open={isOpen} onOpenChange={setOpen}>
      {isOpen ? (
        <DialogContent
          data-slot="new-session-dialog"
          className="sm:max-w-md"
          onOpenAutoFocus={() => {
            created.current = false;
          }}
          onCloseAutoFocus={(event) => {
            // The new session's message field takes the focus (NewSessionForm), not the opener.
            if (created.current) event.preventDefault();
          }}
        >
          <DialogHeader>
            <DialogTitle>{t('shell.newSession.title')}</DialogTitle>
            <DialogDescription>{t('shell.newSession.description')}</DialogDescription>
          </DialogHeader>
          <NewSessionForm
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
