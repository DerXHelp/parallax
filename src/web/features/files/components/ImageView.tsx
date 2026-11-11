import { useState } from 'react';
import { useT } from '@web/i18n';
import { cn } from '@web/lib/cn';
import { Alert } from '@web/ui/alert';
import { Lightbox } from '@web/ui/lightbox';
import { ToggleGroup, ToggleGroupItem } from '@web/ui/toggle-group';

/**
 * Image of the viewer (WP-54): `<img src>` of GET /api/file (CSP img-src 'self'), fitted to the panel
 * or at 100 % (scrolls); a click opens the lightbox (zoom, save as). `version` remounts the image
 * after a change on disk (the response is `no-store`).
 */
export function ImageView({ src, name, version }: { src: string; name: string; version: number }) {
  const t = useT();
  const [mode, setMode] = useState<'fit' | 'actual'>('fit');
  const [failed, setFailed] = useState<number | null>(null);
  const labels = {
    title: name,
    zoomIn: t('files.viewer.lightbox.zoomIn'),
    zoomOut: t('files.viewer.lightbox.zoomOut'),
    fit: t('files.viewer.lightbox.fit'),
    actualSize: t('files.viewer.lightbox.actualSize'),
    save: t('files.viewer.lightbox.save'),
    close: t('files.viewer.lightbox.close'),
    zoom: (percent: number) => t('files.viewer.lightbox.zoom', { percent }),
  };

  return (
    <div data-slot="image-view" className="flex min-h-0 flex-1 flex-col">
      <div className="flex shrink-0 items-center justify-end border-b px-3 py-1">
        <ToggleGroup
          type="single"
          size="sm"
          variant="outline"
          value={mode}
          aria-label={t('files.viewer.view')}
          onValueChange={(value) => {
            if (value === 'fit' || value === 'actual') setMode(value);
          }}
        >
          {/* flex-none: labels of different length (the group shares its width equally otherwise). */}
          <ToggleGroupItem value="fit" className="flex-none px-2 text-xs">
            {t('files.viewer.fit')}
          </ToggleGroupItem>
          <ToggleGroupItem value="actual" className="flex-none px-2 text-xs">
            {t('files.viewer.actualSize')}
          </ToggleGroupItem>
        </ToggleGroup>
      </div>
      {failed === version ? (
        <div className="p-3">
          <Alert tone="error" title={t('files.viewer.imageFailed')} />
        </div>
      ) : (
        <div className={cn('bg-muted/30 min-h-0 flex-1 overflow-auto p-3', mode === 'fit' && 'flex')}>
          <Lightbox image={{ src, alt: name, downloadName: name }} labels={labels}>
            <button
              type="button"
              aria-label={t('files.viewer.enlarge', { name })}
              className={cn(
                'focus-visible:ring-ring cursor-zoom-in rounded-sm outline-none focus-visible:ring-2',
                mode === 'fit' ? 'flex h-full w-full items-center justify-center' : 'inline-block',
              )}
            >
              <img
                key={version}
                src={src}
                alt={name}
                data-mode={mode}
                onError={() => {
                  setFailed(version);
                }}
                className={cn(
                  'block [image-rendering:auto]',
                  mode === 'fit' ? 'max-h-full max-w-full object-contain' : 'max-w-none',
                )}
              />
            </button>
          </Lightbox>
        </div>
      )}
    </div>
  );
}
