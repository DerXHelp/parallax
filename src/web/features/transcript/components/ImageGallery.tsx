import { useMemo } from 'react';
import type { BlobRef, TranscriptItem } from '@shared/model';
import { useT } from '@web/i18n';
import { cn } from '@web/lib/cn';
import { useItems } from '@web/state/hooks';
import { previewImages } from '../lib/text';
import { ImageThumb } from './ImageThumb';

const NO_IMAGES: readonly BlobRef[] = Object.freeze([]);

/** The pictures of the results of these items (tool calls), in order (WP-63 §1.5). */
export function galleryImages(items: readonly (TranscriptItem | null)[]): readonly BlobRef[] {
  const images: BlobRef[] = [];
  for (const item of items) if (item?.kind === 'tool_call') images.push(...previewImages(item));
  return images.length === 0 ? NO_IMAGES : images;
}

/**
 * Thumbnail grid (WP-63 §1.5): wrapping, one height for all; a click opens the transcript's
 * lightbox with previous/next over every image of the gallery.
 */
export function ImageGallery({ images, className }: { images: readonly BlobRef[]; className?: string }) {
  const t = useT();
  if (images.length === 0) return null;
  return (
    <ul
      data-slot="image-gallery"
      aria-label={t('transcript.group.gallery', { count: images.length })}
      className={cn('flex flex-wrap items-start gap-1.5', className)}
    >
      {images.map((image, index) => (
        <li key={`${image.blobId}:${String(index)}`} className="flex">
          <ImageThumb image={image} gallery={images} className="h-20 w-auto max-w-56 object-cover" />
        </li>
      ))}
    </ul>
  );
}

/** The gallery of the tool calls `ids` of a session (re-renders only when one of them changes). */
export function ToolImagesGallery({
  sessionKey,
  ids,
  className,
}: {
  sessionKey: string;
  ids: readonly string[];
  className?: string;
}) {
  const items = useItems(sessionKey, ids);
  const images = useMemo(() => galleryImages(items), [items]);
  return <ImageGallery images={images} className={className} />;
}
