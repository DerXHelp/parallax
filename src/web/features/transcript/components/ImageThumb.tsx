import { useContext, useMemo } from 'react';
import type { BlobRef } from '@shared/model';
import { useI18n } from '@web/i18n';
import { cn } from '@web/lib/cn';
import { Lightbox, type LightboxImage, type LightboxLabels } from '@web/ui/lightbox';
import { ImageViewerContext } from '../context';
import { blobSource, downloadNameOf } from '../state/blob-source';

/** Texts of the lightbox (transcript namespace; the primitive itself has no texts). */
export function useLightboxLabels(title: string): LightboxLabels {
  const { t, format } = useI18n();
  return useMemo(
    () => ({
      title,
      zoomIn: t('transcript.image.zoomIn'),
      zoomOut: t('transcript.image.zoomOut'),
      fit: t('transcript.image.fit'),
      actualSize: t('transcript.image.actualSize'),
      save: t('transcript.image.save'),
      close: t('transcript.image.close'),
      zoom: (percent: number) => format.percent(percent),
    }),
    [t, format, title],
  );
}

/** Name, alt text, source and download name of a blob image (thumbnail and lightbox alike). */
export function useBlobImage(image: BlobRef): { name: string; lightbox: LightboxImage } {
  const { t } = useI18n();
  const name = image.name ?? t('transcript.user.unnamed');
  return {
    name,
    lightbox: {
      src: blobSource(image.blobId),
      alt: t('transcript.user.image', { name }),
      downloadName: downloadNameOf(image),
      width: image.width,
      height: image.height,
    },
  };
}

/**
 * A blob image of the transcript (tool results, attachments of user messages) as a button: a
 * click (or Enter/Space) opens the lightbox with zoom and "Save as" (WP-37 §8) – the TranscriptView's
 * own one (`ImageViewerContext`), outside a TranscriptView one of its own.
 */
export function ImageThumb({ image, className }: { image: BlobRef; className?: string }) {
  const { t } = useI18n();
  const openImage = useContext(ImageViewerContext);
  const { name, lightbox } = useBlobImage(image);
  const labels = useLightboxLabels(lightbox.alt);
  // Lazy loading only with a known size (V3-12: a lazy image without dimensions shifts the layout
  // when it arrives). Tool-result blobs have none; the virtualized list mounts rows near view only.
  const sized = image.width !== null && image.height !== null;
  const button = (
    <button
      type="button"
      data-slot="image-thumb"
      aria-label={t('transcript.image.open', { name })}
      className="focus-visible:ring-ring flex max-w-full cursor-zoom-in rounded-md outline-none focus-visible:ring-2"
      onClick={
        openImage === null
          ? undefined
          : (event) => {
              openImage(image, event.currentTarget);
            }
      }
    >
      <img
        src={lightbox.src}
        alt={lightbox.alt}
        width={image.width ?? undefined}
        height={image.height ?? undefined}
        loading={sized ? 'lazy' : undefined}
        className={cn('rounded-md border', className)}
      />
    </button>
  );
  if (openImage !== null) return button;
  return (
    <Lightbox image={lightbox} labels={labels}>
      {button}
    </Lightbox>
  );
}
