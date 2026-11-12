import { useEffect, useState } from 'react';
import type { ErrorPayload } from '@shared/errors';
import { useI18n } from '@web/i18n';
import { useReturnFocus } from '@web/lib/return-focus';
import { sessionTitle } from '@web/lib/session-title';
import { errorPayloadOf } from '@web/state/connection';
import { useSummary } from '@web/state/hooks';
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
import { Spinner } from '@web/ui/spinner';
import { sessionFocusTarget } from './focus';
import { removeSession } from './remove-session';
import { hasProcess } from './session-actions';

/**
 * "Remove from Parallax…" (WP-63 §1.3): confirmation that the session only leaves Parallax – its
 * files stay and `claude --resume` keeps working. A running process is closed first (the server
 * does it like `session.close`); while the session works, the dialog says that the turn ends and
 * open decisions are dropped. A refusal shows inside the dialog (ADR-126). A session that is gone
 * meanwhile (removed in another window) closes the dialog.
 */
export function RemoveSessionDialog({ sessionKey, onClose }: { sessionKey: string; onClose: () => void }) {
  const { t, tError } = useI18n();
  const current = useSummary(sessionKey);
  // The last known summary: the dialog stays as it was while its own removal completes.
  const [last, setLast] = useState(current);
  if (current !== null && current !== last) setLast(current);
  const summary = current ?? last;
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<ErrorPayload | null>(null);
  const returnFocus = useReturnFocus(true, () => sessionFocusTarget(sessionKey, 'sidebar'));
  const gone = current === null;

  useEffect(() => {
    if (gone && !pending) onClose();
  }, [gone, pending, onClose]);

  if (summary === null) return null;
  const working = summary.status.runState === 'working' || summary.status.runState === 'starting';
  const running = hasProcess(summary);

  const confirm = () => {
    setPending(true);
    setError(null);
    removeSession(sessionKey).then(
      () => {
        setPending(false);
        onClose();
      },
      (caught: unknown) => {
        setPending(false);
        setError(errorPayloadOf(caught));
      },
    );
  };

  return (
    <Dialog
      open
      onOpenChange={(next) => {
        if (!next && !pending) onClose();
      }}
    >
      <DialogContent data-slot="remove-session-dialog" className="sm:max-w-md" onCloseAutoFocus={returnFocus}>
        <DialogHeader>
          <DialogTitle>{t('navigation.remove.title')}</DialogTitle>
          <DialogDescription>
            {t('navigation.remove.description', { title: sessionTitle(summary) })}
          </DialogDescription>
        </DialogHeader>
        {working ? (
          <Alert tone="warning" data-slot="remove-working">
            {t('navigation.remove.working')}
          </Alert>
        ) : running ? (
          <p className="text-muted-foreground text-xs">{t('navigation.remove.running')}</p>
        ) : null}
        {error === null ? null : (
          <Alert tone="error" role="alert" data-slot="remove-error">
            {tError(error)}
          </Alert>
        )}
        <DialogFooter>
          <Button variant="ghost" disabled={pending} onClick={onClose}>
            {t('navigation.remove.cancel')}
          </Button>
          <Button variant="destructive" disabled={pending} data-action="confirm-remove" onClick={confirm}>
            {pending ? <Spinner className="size-3" label={t('navigation.remove.removing')} /> : null}
            {pending ? t('navigation.remove.removing') : t('navigation.remove.confirm')}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
