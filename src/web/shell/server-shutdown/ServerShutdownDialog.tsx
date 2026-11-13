import { lazy, Suspense, useEffect, useSyncExternalStore } from 'react';
import { Dialog } from '@web/ui/dialog';

/**
 * "Stop server" (Plan "Server-Betrieb", A.10, WP-21): an explicit confirmation that names the
 * working and waiting sessions (from the summaries, WP-02 §7.5), then `server.shutdown`. The server
 * acknowledges first and closes every window's connection with 4503 – the HostGate then shows
 * "Parallax server stopped". Opened from the settings menu (`openServerShutdown`). WP-70: the
 * confirmation itself is a lazy chunk (`ShutdownConfirmation.tsx`, start-chunk budget).
 */

let open = false;
const listeners = new Set<() => void>();

function setOpen(next: boolean): void {
  if (open === next) return;
  open = next;
  for (const listener of [...listeners]) listener();
}

/** Opens the confirmation (settings menu item). */
export function openServerShutdown(): void {
  setOpen(true);
}

export function closeServerShutdown(): void {
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

const ShutdownConfirmation = lazy(() =>
  import('./ShutdownConfirmation').then((module) => ({ default: module.ShutdownConfirmation })),
);

/** Mounted once next to the settings menu; the content (and its summary subscription) only while open. */
export function ServerShutdownDialog() {
  const isOpen = useSyncExternalStore(subscribe, getOpen, getOpen);
  // The shell unmounts when the host goes away (e.g. "server stopped"): never reopen on remount.
  useEffect(() => closeServerShutdown, []);
  return (
    <Dialog open={isOpen} onOpenChange={setOpen}>
      {isOpen ? (
        <Suspense fallback={null}>
          <ShutdownConfirmation />
        </Suspense>
      ) : null}
    </Dialog>
  );
}
