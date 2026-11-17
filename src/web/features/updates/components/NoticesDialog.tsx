import type { NoticeFile } from '@shared/http';
import { useI18n } from '@web/i18n';
import { Button } from '@web/ui/button';
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@web/ui/dialog';
import { ScrollArea } from '@web/ui/scroll-area';
import { Spinner } from '@web/ui/spinner';
import { fetchNotices, noticesUrl } from '../lib/api';
import { useRequest } from '../state/use-request';
import { UpdateErrorAlert } from './UpdateErrorAlert';

const TEXTS = {
  license: { title: 'updates.notices.license', description: 'updates.notices.licenseDescription' },
  'third-party': {
    title: 'updates.notices.thirdParty',
    description: 'updates.notices.thirdPartyDescription',
  },
} as const satisfies Record<NoticeFile, { title: string; description: string }>;

/**
 * License or third-party notices of the running version (`GET /api/notices`): plain text in a
 * scroll area – the notices file is large, no Markdown. Errors show in the dialog itself.
 */
export function NoticesDialog({ file, onClose }: { file: NoticeFile; onClose: () => void }) {
  const { t } = useI18n();
  const { loading, data, error, retry } = useRequest(noticesUrl(file), (signal) =>
    fetchNotices(file, signal),
  );
  const texts = TEXTS[file];
  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
    >
      <DialogContent data-slot="notices" data-file={file} className="sm:max-w-3xl">
        <DialogHeader>
          <DialogTitle>{t(texts.title)}</DialogTitle>
          <DialogDescription>{t(texts.description)}</DialogDescription>
        </DialogHeader>
        {loading ? (
          <p className="text-muted-foreground flex items-center gap-2 text-xs">
            <Spinner label={t('updates.notices.loading')} />
            <span aria-hidden>{t('updates.notices.loading')}</span>
          </p>
        ) : null}
        {error === null ? null : (
          <UpdateErrorAlert
            title={t('updates.notices.failed')}
            error={error}
            actions={
              <Button size="sm" variant="outline" onClick={retry}>
                {t('common.retry')}
              </Button>
            }
          />
        )}
        {data === null ? null : (
          <ScrollArea className="bg-muted/30 h-[60vh] rounded-md border">
            {/* Focusable, so the arrow keys scroll the text. */}
            <pre
              tabIndex={0}
              aria-label={t(texts.title)}
              className="focus-visible:ring-ring p-3 font-mono text-2xs break-words whitespace-pre-wrap outline-none select-text focus-visible:ring-2"
            >
              {data.text}
            </pre>
          </ScrollArea>
        )}
      </DialogContent>
    </Dialog>
  );
}

export default NoticesDialog;
