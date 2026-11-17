import { memo, useState } from 'react';
import type { ChangelogQuery } from '@shared/http';
import type { UpdateState } from '@shared/model';
import { useI18n } from '@web/i18n';
import type { NoSlotProps } from '@web/shell/slots';
import { errorPayloadOf } from '@web/state/connection';
import { sendCommand, useHostState } from '@web/state/hooks';
import { showErrorNotice, showTextNotice } from '@web/state/notices';
import { Banner } from '@web/ui/alert';
import { Button } from '@web/ui/button';
import { CopyButton } from '@web/ui/copy-button';
import { WhatsNewDialog } from './components/WhatsNewDialog';
import { updateErrorDetail } from './lib/error-detail';
import { isVersionBack, whatsNewSince } from './lib/update-state';

type Dismissable = 'justUpdated' | 'failedUpdate';

function dismiss(what: Dismissable): void {
  sendCommand(null, { name: 'update.dismiss', what }).catch((caught: unknown) => {
    showErrorNotice(errorPayloadOf(caught));
  });
}

function notifyCopied(ok: boolean): void {
  if (ok) {
    showTextNotice('updates.banner.copied', undefined, {
      tone: 'success',
      id: 'update-log-copy',
      durationMs: 2000,
    });
  } else {
    showTextNotice('updates.banner.copyFailed', undefined, { tone: 'error', id: 'update-log-copy' });
  }
}

/** The last switch failed and the orchestrator went back: error, its reason, the log to copy. */
function FailedBanner({ failed }: { failed: NonNullable<UpdateState['failedUpdate']> }) {
  const { t, tError } = useI18n();
  const detail = updateErrorDetail(failed.error, t);
  return (
    <Banner
      tone="error"
      data-slot="update-failed"
      actions={
        <Button
          size="sm"
          variant="ghost"
          data-action="dismiss-update-failed"
          onClick={() => {
            dismiss('failedUpdate');
          }}
        >
          {t('common.dismiss')}
        </Button>
      }
    >
      <span className="grid gap-0.5 py-0.5">
        <span className="font-medium">
          {t('updates.banner.failed', { version: failed.version, restoredTo: failed.restoredTo })}
        </span>
        <span className="text-muted-foreground">{tError(failed.error)}</span>
        {detail === null ? null : (
          <span data-slot="update-error-detail" className="text-muted-foreground">
            {detail}
          </span>
        )}
        {failed.log === null ? null : (
          <span data-slot="update-log" className="text-muted-foreground flex min-w-0 items-center gap-1.5">
            <span className="shrink-0">{t('updates.banner.log')}</span>
            <span className="min-w-0 font-mono break-all select-text">{failed.log}</span>
            <CopyButton
              text={failed.log}
              label={t('updates.banner.copyLog')}
              onCopied={notifyCopied}
              className="shrink-0"
            />
          </span>
        )}
      </span>
    </Banner>
  );
}

/** After a version change: "Updated to <v>" (or "Switched to <v>" going back) with "What's new". */
function UpdatedBanner({ change }: { change: NonNullable<UpdateState['justUpdated']> }) {
  const { t } = useI18n();
  const [whatsNew, setWhatsNew] = useState<ChangelogQuery | null>(null);
  const back = isVersionBack(change);
  const since = whatsNewSince(change);
  return (
    <>
      <Banner
        tone="success"
        data-slot="update-done"
        data-direction={back ? 'back' : 'forward'}
        actions={
          <>
            <Button
              size="sm"
              variant="ghost"
              data-action="update-whats-new"
              onClick={() => {
                setWhatsNew(since === undefined ? { for: 'installed' } : { for: 'installed', since });
              }}
            >
              {t('updates.settings.whatsNew')}
            </Button>
            <Button
              size="sm"
              variant="ghost"
              data-action="dismiss-update-done"
              onClick={() => {
                dismiss('justUpdated');
              }}
            >
              {t('common.dismiss')}
            </Button>
          </>
        }
      >
        <span className="font-medium">
          {back && change.from !== null
            ? t('updates.banner.changed', { to: change.to, from: change.from })
            : t('updates.banner.updated', { to: change.to })}
        </span>
      </Banner>
      {whatsNew === null ? null : (
        <WhatsNewDialog
          query={whatsNew}
          version={change.to}
          onClose={() => {
            setWhatsNew(null);
          }}
        />
      )}
    </>
  );
}

/**
 * Slot `UpdateBanner` (inside ShellBanners, WP-87 §2.3): `failedUpdate` as an error strip
 * (`role="alert"`) – "Update to <v> failed, back on <v>", the translated error with its reason, the
 * log path with a copy button – and `justUpdated` as a success strip with "What's new". "Dismiss"
 * clears the field on the server (`update.dismiss`) for every window.
 */
export const UpdateBanner = memo(function UpdateBanner(_props: NoSlotProps) {
  const update = useHostState()?.update ?? null;
  if (update === null) return null;
  return (
    <>
      {update.failedUpdate === null ? null : <FailedBanner failed={update.failedUpdate} />}
      {update.justUpdated === null ? null : <UpdatedBanner change={update.justUpdated} />}
    </>
  );
});

export default UpdateBanner;
