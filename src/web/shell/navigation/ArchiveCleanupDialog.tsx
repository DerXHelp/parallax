import { useId, useMemo, useState } from 'react';
import { useI18n } from '@web/i18n';
import { useReturnFocus } from '@web/lib/return-focus';
import { archivedOrder } from '@web/lib/session-order';
import { sessionTitle } from '@web/lib/session-title';
import { useNow } from '@web/state/clock';
import { useSummaries, type SummaryEntry } from '@web/state/hooks';
import { Alert } from '@web/ui/alert';
import { Button } from '@web/ui/button';
import { Checkbox } from '@web/ui/checkbox';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@web/ui/dialog';
import { Spinner } from '@web/ui/spinner';
import { PathTail } from './PathTail';
import { removeSessions, type RemoveFailure } from './remove-session';

/** Quick selection "older than 30 days" (WP-63 §1.3). */
export const CLEANUP_OLDER_THAN_DAYS = 30;
const DAY_MS = 86_400_000;

/** The archived sessions whose last activity lies more than `days` before `now` (epoch ms). */
export function olderThan(entries: readonly SummaryEntry[], now: number, days: number): string[] {
  const limit = now - days * DAY_MS;
  return entries
    .filter((entry) => Date.parse(entry.summary.lastActivityAt) < limit)
    .map((entry) => entry.sessionKey);
}

/**
 * "Clean up archive…" (WP-63 §1.3): the archived sessions with checkbox, name, folder and last
 * activity, quick selection "older than 30 days", "Remove (n)" = one `session.remove` after the
 * other. Removed sessions leave the list (their summaries go away); failures stay selected and are
 * listed in the dialog (`Alert role="alert"`). Files stay on disk.
 */
export function ArchiveCleanupDialog({ onClose }: { onClose: () => void }) {
  const { t, tError, format } = useI18n();
  const entries = useSummaries();
  const now = useNow(60_000);
  const archived = useMemo(
    () => archivedOrder(entries, new Date(now)).map((ordered) => ordered.entry),
    [entries, now],
  );
  const [selected, setSelected] = useState<ReadonlySet<string>>(() => new Set());
  const [pending, setPending] = useState(false);
  const [failures, setFailures] = useState<readonly RemoveFailure[]>([]);
  const returnFocus = useReturnFocus(true, () =>
    document.querySelector<HTMLElement>('[data-slot="archive-toggle"]'),
  );
  const listId = useId();

  // Only sessions still in the archive count (another window may have removed or restored some).
  const present = useMemo(() => new Set(archived.map((entry) => entry.sessionKey)), [archived]);
  const chosen = [...selected].filter((key) => present.has(key));
  const titles = useMemo(
    () => new Map(entries.map((entry) => [entry.sessionKey, sessionTitle(entry.summary)])),
    [entries],
  );

  const toggle = (sessionKey: string, on: boolean) => {
    setSelected((current) => {
      const next = new Set(current);
      if (on) next.add(sessionKey);
      else next.delete(sessionKey);
      return next;
    });
  };

  const remove = () => {
    if (chosen.length === 0) return;
    setPending(true);
    setFailures([]);
    void removeSessions(chosen).then((failed) => {
      setPending(false);
      if (failed.length === 0) {
        onClose();
        return;
      }
      setFailures(failed);
      setSelected(new Set(failed.map((failure) => failure.sessionKey)));
    });
  };

  const allSelected = archived.length > 0 && chosen.length === archived.length;

  return (
    <Dialog
      open
      onOpenChange={(next) => {
        if (!next && !pending) onClose();
      }}
    >
      <DialogContent
        data-slot="archive-cleanup-dialog"
        className="sm:max-w-xl"
        onCloseAutoFocus={returnFocus}
      >
        <DialogHeader>
          <DialogTitle>{t('navigation.cleanup.title')}</DialogTitle>
          <DialogDescription>{t('navigation.cleanup.description')}</DialogDescription>
        </DialogHeader>
        {failures.length === 0 ? null : (
          <Alert
            tone="error"
            role="alert"
            data-slot="cleanup-error"
            title={t('navigation.cleanup.failed', { count: failures.length })}
          >
            <ul className="grid gap-0.5">
              {failures.map((failure) => (
                <li key={failure.sessionKey}>
                  {t('navigation.cleanup.failure', {
                    title: titles.get(failure.sessionKey) ?? failure.sessionKey,
                    error: tError(failure.error),
                  })}
                </li>
              ))}
            </ul>
          </Alert>
        )}
        {archived.length === 0 ? (
          <p className="text-muted-foreground text-xs">{t('navigation.cleanup.empty')}</p>
        ) : (
          <>
            <div className="flex flex-wrap items-center gap-2">
              <label className="flex items-center gap-2 text-xs">
                <Checkbox
                  checked={allSelected ? true : chosen.length > 0 ? 'indeterminate' : false}
                  disabled={pending}
                  aria-controls={listId}
                  onCheckedChange={(checked) => {
                    setSelected(checked === true ? new Set(present) : new Set());
                  }}
                />
                {t('navigation.cleanup.selectAll')}
              </label>
              <span className="flex-1" />
              <Button
                size="sm"
                variant="outline"
                disabled={pending}
                data-action="select-older"
                onClick={() => {
                  setSelected(new Set(olderThan(archived, now, CLEANUP_OLDER_THAN_DAYS)));
                }}
              >
                {t('navigation.cleanup.olderThan', { days: CLEANUP_OLDER_THAN_DAYS })}
              </Button>
            </div>
            <ul
              id={listId}
              aria-label={t('navigation.cleanup.list')}
              data-slot="cleanup-list"
              className="grid max-h-80 gap-px overflow-y-auto rounded-md border p-1"
            >
              {archived.map((entry) => {
                const title = sessionTitle(entry.summary);
                return (
                  <li key={entry.sessionKey} data-cleanup-row={entry.sessionKey}>
                    <label className="hover:bg-accent/60 grid cursor-pointer grid-cols-[auto_minmax(0,1fr)_auto] items-center gap-x-2 rounded-sm px-2 py-1 text-xs">
                      <Checkbox
                        checked={selected.has(entry.sessionKey)}
                        disabled={pending}
                        onCheckedChange={(checked) => {
                          toggle(entry.sessionKey, checked === true);
                        }}
                      />
                      <span className="grid min-w-0">
                        <span className="truncate font-medium">{title}</span>
                        <span className="text-muted-foreground flex min-w-0 font-mono text-2xs">
                          <span className="sr-only">{t('navigation.cleanup.folder')}</span>
                          <PathTail path={entry.summary.cwd} />
                        </span>
                      </span>
                      <span className="text-muted-foreground shrink-0 text-2xs tabular-nums">
                        {t('navigation.cleanup.lastActive', {
                          time: format.relative(entry.summary.lastActivityAt, now),
                        })}
                      </span>
                    </label>
                  </li>
                );
              })}
            </ul>
          </>
        )}
        <DialogFooter>
          <Button variant="ghost" disabled={pending} onClick={onClose}>
            {t('navigation.cleanup.cancel')}
          </Button>
          <Button
            variant="destructive"
            disabled={pending || chosen.length === 0}
            data-action="cleanup-remove"
            onClick={remove}
          >
            {pending ? <Spinner className="size-3" label={t('navigation.cleanup.removing')} /> : null}
            {pending
              ? t('navigation.cleanup.removing')
              : t('navigation.cleanup.remove', { count: chosen.length })}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
