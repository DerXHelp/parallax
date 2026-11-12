import { AppWindowIcon, DownloadIcon } from 'lucide-react';
import { useT } from '@web/i18n';
import { Button, buttonVariants } from '@web/ui/button';

/**
 * PDF of the viewer (WP-54, lazy chunk, L10): Chrome's own PDF viewer in an `<iframe>` of
 * GET /api/file – deliberately without `sandbox` (a sandboxed frame blocks the PDF plugin); the
 * response CSP `FILE_PDF_CSP` protects instead. Below it the fallbacks "Download" and "Open with
 * default program" (local host only). `version` remounts the frame after a change on disk.
 */
export function PdfView({
  src,
  name,
  version,
  onOpenDefault,
}: {
  src: string;
  name: string;
  version: number;
  /** null: no default program (remote host). */
  onOpenDefault: (() => void) | null;
}) {
  const t = useT();
  return (
    <div data-slot="pdf-view" className="flex min-h-0 flex-1 flex-col">
      <iframe
        key={version}
        src={src}
        title={t('files.viewer.pdf', { name })}
        className="bg-muted/30 min-h-0 w-full flex-1 border-0"
      />
      <div className="text-muted-foreground flex shrink-0 flex-wrap items-center gap-2 border-t px-3 py-1.5 text-xs">
        <span className="min-w-0 flex-1">{t('files.viewer.pdfFallback')}</span>
        <a href={src} download={name} className={buttonVariants({ variant: 'outline', size: 'sm' })}>
          <DownloadIcon aria-hidden />
          {t('files.actions.download')}
        </a>
        {onOpenDefault === null ? null : (
          <Button variant="outline" size="sm" onClick={onOpenDefault}>
            <AppWindowIcon aria-hidden />
            {t('files.actions.default')}
          </Button>
        )}
      </div>
    </div>
  );
}

export default PdfView;
