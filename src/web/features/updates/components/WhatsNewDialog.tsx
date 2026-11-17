import type { ChangelogQuery, ChangelogSection } from '@shared/http';
import { useI18n } from '@web/i18n';
import { useFeatureSlots } from '@web/shell/slots';
import { Button } from '@web/ui/button';
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@web/ui/dialog';
import { Spinner } from '@web/ui/spinner';
import { changelogUrl, fetchChangelog } from '../lib/api';
import { useRequest } from '../state/use-request';
import { UpdateErrorAlert } from './UpdateErrorAlert';

/** `YYYY-MM-DD` of a changelog section as a date of the UI language (UTC: no day shift). */
const SECTION_DATE: Intl.DateTimeFormatOptions = { dateStyle: 'medium', timeZone: 'UTC' };

function SectionView({ section }: { section: ChangelogSection }) {
  const { t, format } = useI18n();
  const { Markdown } = useFeatureSlots();
  let heading: string;
  if (section.version === null) heading = t('updates.whatsNew.unreleased');
  else if (section.date === null) heading = t('updates.whatsNew.section', { version: section.version });
  else {
    heading = t('updates.whatsNew.sectionDated', {
      version: section.version,
      date: format.date(section.date, SECTION_DATE),
    });
  }
  return (
    <section
      data-slot="whats-new-section"
      data-version={section.version ?? 'unreleased'}
      className="grid gap-1.5"
    >
      <h3 className="text-xs font-semibold">{heading}</h3>
      {section.body.trim() === '' ? (
        <p className="text-muted-foreground text-xs">{t('updates.whatsNew.empty')}</p>
      ) : (
        <div className="text-xs">
          <Markdown text={section.body} />
        </div>
      )}
    </section>
  );
}

/**
 * "What's new" (WP-87 §1.6): the sections of the signed CHANGELOG.md the server picks for `query`
 * (`GET /api/changelog`), each rendered through the `Markdown` slot (no raw HTML). `version` names
 * the version until the answer is there. Errors show in the dialog itself, with "Retry".
 */
export function WhatsNewDialog({
  query,
  version,
  onClose,
}: {
  query: ChangelogQuery;
  version: string;
  onClose: () => void;
}) {
  const { t } = useI18n();
  const { loading, data, error, retry } = useRequest(changelogUrl(query), (signal) =>
    fetchChangelog(query, signal),
  );
  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
    >
      <DialogContent data-slot="whats-new" className="sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle>{t('updates.whatsNew.title')}</DialogTitle>
          <DialogDescription>
            {t('updates.whatsNew.description', { version: data?.version ?? version })}
          </DialogDescription>
        </DialogHeader>
        {loading ? (
          <p className="text-muted-foreground flex items-center gap-2 text-xs">
            <Spinner label={t('updates.whatsNew.loading')} />
            <span aria-hidden>{t('updates.whatsNew.loading')}</span>
          </p>
        ) : null}
        {error === null ? null : (
          <UpdateErrorAlert
            title={t('updates.whatsNew.failed')}
            error={error}
            actions={
              <Button size="sm" variant="outline" onClick={retry}>
                {t('common.retry')}
              </Button>
            }
          />
        )}
        {data === null ? null : data.sections.length === 0 ? (
          <p className="text-muted-foreground text-xs">{t('updates.whatsNew.empty')}</p>
        ) : (
          <div className="grid gap-4">
            {data.sections.map((section, index) => (
              <SectionView key={`${section.version ?? 'unreleased'}-${String(index)}`} section={section} />
            ))}
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}

export default WhatsNewDialog;
