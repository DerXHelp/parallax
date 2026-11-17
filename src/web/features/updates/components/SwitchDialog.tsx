import { useId, useMemo, useState } from 'react';
import { LOCAL_HOST_ID } from '@shared/common';
import type { ErrorPayload } from '@shared/errors';
import type { AppVersion } from '@shared/model';
import { useI18n } from '@web/i18n';
import { shutdownImpact, type AffectedSession } from '@web/shell/server-shutdown/impact';
import { useNow } from '@web/state/clock';
import { errorPayloadOf } from '@web/state/connection';
import { sendCommand, useConnectionStatus, useSummaries } from '@web/state/hooks';
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
import { Label } from '@web/ui/label';
import { StatusIcon } from '@web/ui/status-icon';
import { UpdateErrorAlert } from './UpdateErrorAlert';

/** What the confirmation switches to: the prepared update or the previous version. */
export interface SwitchTarget {
  kind: 'apply' | 'rollback';
  version: AppVersion;
  /** Other store schemas: only with the backup of `backupAt`; data since then are lost. */
  needsRestore: boolean;
  backupAt: string | null;
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

/**
 * "Restart now" / "Back to <version>" (WP-87 §2.3): a restart stops every session of this server,
 * so the confirmation names the working and waiting ones (`shutdownImpact`, like "Stop server").
 * With `needsRestore` it warns that the changes since the backup are lost and asks for the tick
 * (`acceptDataLoss`); without a backup it cannot go on. The ack closes the dialog – the server then
 * restarts (close 4504, the shell shows "restarting"); a refusal shows here.
 */
export function SwitchDialog({ target, onClose }: { target: SwitchTarget; onClose: () => void }) {
  const { t, format } = useI18n();
  const entries = useSummaries();
  const now = useNow(5_000);
  const impact = useMemo(
    () =>
      shutdownImpact(
        entries.filter((entry) => entry.hostId === LOCAL_HOST_ID),
        new Date(now),
      ),
    [entries, now],
  );
  const connected = useConnectionStatus() === 'open';
  const [accepted, setAccepted] = useState(false);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<ErrorPayload | null>(null);
  const acceptId = useId();
  const blocked = target.needsRestore && target.backupAt === null;
  const nothing = impact.working.length === 0 && impact.waiting.length === 0 && impact.idle === 0;
  const canConfirm = connected && !pending && !blocked && (!target.needsRestore || accepted);

  const confirm = () => {
    setPending(true);
    setError(null);
    const acceptDataLoss = target.needsRestore && accepted;
    const sent =
      target.kind === 'apply'
        ? sendCommand(null, { name: 'update.apply', version: target.version, acceptDataLoss })
        : sendCommand(null, { name: 'update.rollback', version: target.version, acceptDataLoss });
    sent.then(onClose, (caught: unknown) => {
      setPending(false);
      setError(errorPayloadOf(caught));
    });
  };

  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open && !pending) onClose();
      }}
    >
      <DialogContent data-slot="update-switch" data-kind={target.kind} className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>
            {target.kind === 'apply'
              ? t('updates.confirm.applyTitle')
              : t('updates.confirm.rollbackTitle', { version: target.version })}
          </DialogTitle>
          <DialogDescription>
            {t('updates.confirm.description', { version: target.version })}
          </DialogDescription>
        </DialogHeader>
        {target.needsRestore ? (
          target.backupAt === null ? (
            <Alert tone="error" data-slot="update-no-backup" title={t('updates.confirm.noBackup')} />
          ) : (
            <Alert
              tone="warning"
              data-slot="update-data-loss"
              title={t('updates.confirm.dataLossTitle', { date: format.dateTime(target.backupAt) })}
            >
              <span className="block">
                {t('updates.confirm.dataLossDescription', { version: target.version })}
              </span>
              <span className="mt-2 flex items-center gap-2">
                <Checkbox
                  id={acceptId}
                  checked={accepted}
                  disabled={pending}
                  onCheckedChange={(checked) => {
                    setAccepted(checked === true);
                  }}
                />
                <Label htmlFor={acceptId} className="text-foreground">
                  {t('updates.confirm.dataLossAccept')}
                </Label>
              </span>
            </Alert>
          )
        ) : null}
        {nothing ? (
          <p className="text-muted-foreground text-xs">{t('updates.confirm.nothingRunning')}</p>
        ) : null}
        <SessionList
          label={t('updates.confirm.working', { count: impact.working.length })}
          sessions={impact.working}
        />
        <SessionList
          label={t('updates.confirm.waiting', { count: impact.waiting.length })}
          sessions={impact.waiting}
        />
        {impact.waiting.length > 0 ? (
          <p className="text-muted-foreground text-xs">{t('updates.confirm.waitingHint')}</p>
        ) : null}
        {impact.idle > 0 ? (
          <p className="text-muted-foreground text-xs">{t('updates.confirm.idle', { count: impact.idle })}</p>
        ) : null}
        {connected ? null : <Alert tone="warning" title={t('updates.confirm.notConnected')} />}
        {error === null ? null : <UpdateErrorAlert title={t('updates.confirm.failed')} error={error} />}
        <DialogFooter>
          <Button variant="ghost" disabled={pending} onClick={onClose}>
            {t('common.cancel')}
          </Button>
          <Button
            variant={target.needsRestore ? 'destructive' : 'default'}
            data-action="update-switch-confirm"
            disabled={!canConfirm}
            onClick={confirm}
          >
            {pending
              ? t('updates.confirm.restarting')
              : target.kind === 'apply'
                ? t('updates.confirm.applyConfirm')
                : t('updates.confirm.rollbackConfirm')}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
