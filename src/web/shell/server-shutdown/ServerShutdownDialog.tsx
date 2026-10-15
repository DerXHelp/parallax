import { useEffect, useMemo, useState, useSyncExternalStore } from 'react';
import type { ErrorPayload } from '@shared/errors';
import { useI18n } from '@web/i18n';
import { useNow } from '@web/state/clock';
import { errorPayloadOf } from '@web/state/connection';
import { sendCommand, useConnectionStatus, useSummaries } from '@web/state/hooks';
import { Alert } from '@web/ui/alert';
import { Button } from '@web/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@web/ui/dialog';
import { StatusIcon } from '@web/ui/status-icon';
import { useShutdownT } from './i18n';
import { shutdownImpact, type AffectedSession } from './impact';

/**
 * "Stop server" (Plan "Server-Betrieb", A.10, WP-21): an explicit confirmation that names the
 * working and waiting sessions (from the summaries, WP-02 §7.5), then `server.shutdown`. The server
 * acknowledges first and closes every window's connection with 4503 – the HostGate then shows
 * "Parallax server stopped". Opened from the settings menu (`openServerShutdown`).
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

function SessionList({ label, sessions }: { label: string; sessions: readonly AffectedSession[] }) {
  if (sessions.length === 0) return null;
  return (
    <section className="grid gap-1">
      <h3 className="text-xs font-medium">{label}</h3>
      <ul className="bg-muted/40 grid max-h-40 gap-0.5 overflow-y-auto rounded-md px-2 py-1.5 text-xs">
        {sessions.map((session) => (
          <li key={session.sessionKey} className="flex min-w-0 items-center gap-2">
            <StatusIcon kind={session.kind} className="shrink-0" />
            <span className="min-w-0 truncate">{session.title}</span>
          </li>
        ))}
      </ul>
    </section>
  );
}

function ShutdownConfirmation() {
  const { t, tError } = useI18n();
  const s = useShutdownT();
  const entries = useSummaries();
  const now = useNow(5_000);
  const impact = useMemo(() => shutdownImpact(entries, new Date(now)), [entries, now]);
  const connected = useConnectionStatus() === 'open';
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<ErrorPayload | null>(null);
  const nothing = impact.working.length === 0 && impact.waiting.length === 0 && impact.idle === 0;

  const confirm = () => {
    setPending(true);
    setError(null);
    sendCommand(null, { name: 'server.shutdown' }).then(
      () => {
        setOpen(false);
      },
      (caught: unknown) => {
        setPending(false);
        setError(errorPayloadOf(caught));
      },
    );
  };

  return (
    <DialogContent className="sm:max-w-md">
      <DialogHeader>
        <DialogTitle>{s('title')}</DialogTitle>
        <DialogDescription>{s('description')}</DialogDescription>
      </DialogHeader>
      {nothing ? <p className="text-muted-foreground text-xs">{s('nothingRunning')}</p> : null}
      <SessionList label={s('working', { count: impact.working.length })} sessions={impact.working} />
      <SessionList label={s('waiting', { count: impact.waiting.length })} sessions={impact.waiting} />
      {impact.waiting.length > 0 ? <p className="text-muted-foreground text-xs">{s('waitingHint')}</p> : null}
      {impact.idle > 0 ? (
        <p className="text-muted-foreground text-xs">{s('idle', { count: impact.idle })}</p>
      ) : null}
      {connected ? null : <Alert tone="warning" title={s('notConnected')} />}
      {error === null ? null : (
        <Alert tone="error" title={s('failed')}>
          {tError(error)}
        </Alert>
      )}
      <DialogFooter>
        <Button
          variant="ghost"
          onClick={() => {
            setOpen(false);
          }}
        >
          {t('common.cancel')}
        </Button>
        <Button variant="destructive" disabled={pending || !connected} onClick={confirm}>
          {pending ? s('stopping') : s('confirm')}
        </Button>
      </DialogFooter>
    </DialogContent>
  );
}

/** Mounted once next to the settings menu; the content (and its summary subscription) only while open. */
export function ServerShutdownDialog() {
  const isOpen = useSyncExternalStore(subscribe, getOpen, getOpen);
  // The shell unmounts when the host goes away (e.g. "server stopped"): never reopen on remount.
  useEffect(() => closeServerShutdown, []);
  return (
    <Dialog open={isOpen} onOpenChange={setOpen}>
      {isOpen ? <ShutdownConfirmation /> : null}
    </Dialog>
  );
}
