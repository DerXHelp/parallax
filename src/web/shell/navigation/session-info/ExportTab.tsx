import { CopyIcon, DownloadIcon } from 'lucide-react';
import { useState } from 'react';
import { copyText } from '@web/lib/clipboard';
import { downloadText } from '@web/lib/download';
import { Alert } from '@web/ui/alert';
import { Button } from '@web/ui/button';
import { useInfoT } from './i18n';
import { SectionFrame } from './SectionFrame';
import { useSessionInfo } from './use-session-info';

/** Characters of the preview (the export itself can hold up to 2 000 000; copy/save take all of it). */
export const EXPORT_PREVIEW_CHARS = 20_000;

type Notice =
  { kind: 'copied' } | { kind: 'copyFailed' } | { kind: 'saved'; name: string } | { kind: 'saveFailed' };

/**
 * Export tab (WP-67): the conversation as plain text (`/export`) – a preview, "Copy" and "Save as
 * file" (browser download with the CLI's file name). The server sends the text, nothing is written
 * on its disk.
 */
export function ExportTab({ sessionKey }: { sessionKey: string }) {
  const it = useInfoT();
  const query = useSessionInfo(sessionKey, 'export');
  const [notice, setNotice] = useState<Notice | null>(null);

  return (
    <SectionFrame query={query}>
      {(data) => {
        if (data.text === '') return <p className="text-muted-foreground text-xs">{it('export.empty')}</p>;
        const cut = data.text.length > EXPORT_PREVIEW_CHARS;
        return (
          <div className="grid gap-3">
            <div className="flex flex-wrap items-center gap-2">
              <Button
                size="sm"
                variant="outline"
                data-action="export-copy"
                onClick={() => {
                  void copyText(data.text).then((ok) => {
                    setNotice(ok ? { kind: 'copied' } : { kind: 'copyFailed' });
                  });
                }}
              >
                <CopyIcon aria-hidden />
                {it('export.copy')}
              </Button>
              <Button
                size="sm"
                variant="outline"
                data-action="export-save"
                onClick={() => {
                  const ok = downloadText(data.text, data.filename);
                  setNotice(ok ? { kind: 'saved', name: data.filename } : { kind: 'saveFailed' });
                }}
              >
                <DownloadIcon aria-hidden />
                {it('export.save')}
              </Button>
              <span className="text-muted-foreground min-w-0 truncate font-mono text-2xs">
                {data.filename}
              </span>
            </div>
            {notice === null ? null : notice.kind === 'copied' || notice.kind === 'saved' ? (
              <p role="status" className="text-success text-xs" data-slot="export-notice">
                {notice.kind === 'copied' ? it('export.copied') : it('export.saved', { name: notice.name })}
              </p>
            ) : (
              <Alert tone="error" data-slot="export-notice">
                {it(notice.kind === 'copyFailed' ? 'export.copyFailed' : 'export.saveFailed')}
              </Alert>
            )}
            {data.truncated ? (
              <Alert tone="warning">
                {it('export.truncated', { total: data.totalChars, kept: data.text.length })}
              </Alert>
            ) : null}
            <pre
              className="bg-muted/40 max-h-96 overflow-auto rounded-md border px-3 py-2 font-mono text-2xs whitespace-pre-wrap break-words"
              data-slot="export-preview"
              tabIndex={0}
            >
              {cut ? data.text.slice(0, EXPORT_PREVIEW_CHARS) : data.text}
            </pre>
            {cut ? (
              <p className="text-muted-foreground text-2xs">
                {it('export.previewCut', { shown: EXPORT_PREVIEW_CHARS, total: data.text.length })}
              </p>
            ) : null}
          </div>
        );
      }}
    </SectionFrame>
  );
}
