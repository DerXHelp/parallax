import { useCallback, useMemo, useState, type ReactNode } from 'react';
import type { BlobRef } from '@shared/model';
import { useT } from '@web/i18n';
import { Lightbox, type LightboxNavigation } from '@web/ui/lightbox';
import { ImageViewerContext, type OpenImage } from '../context';
import { useBlobImage, useLightboxLabels } from './ImageThumb';

interface Viewing {
  /** The images to step through (one without a gallery). */
  images: readonly BlobRef[];
  index: number;
  /** `images[index]`. */
  image: BlobRef;
  trigger: HTMLElement;
  open: boolean;
  /** Counts the openings: every one starts a fresh lightbox (zoom "fit", size of the new image). */
  serial: number;
}

function ViewerLightbox({
  viewing,
  onStep,
  onClose,
  fallbackFocus,
}: {
  viewing: Viewing;
  onStep: (index: number) => void;
  onClose: () => void;
  fallbackFocus: () => HTMLElement | null;
}) {
  const t = useT();
  const { images, index } = viewing;
  const { lightbox } = useBlobImage(viewing.image);
  const labels = useLightboxLabels(lightbox.alt);
  const navigation = useMemo<LightboxNavigation | undefined>(
    () =>
      images.length < 2
        ? undefined
        : {
            index,
            count: images.length,
            onPrevious: () => {
              onStep(Math.max(0, index - 1));
            },
            onNext: () => {
              onStep(Math.min(images.length - 1, index + 1));
            },
            previous: t('transcript.image.previous'),
            next: t('transcript.image.next'),
            position: t('transcript.image.position', { index: index + 1, count: images.length }),
          },
    [images.length, index, onStep, t],
  );
  return (
    <Lightbox
      image={lightbox}
      labels={labels}
      navigation={navigation}
      open={viewing.open}
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
      onCloseAutoFocus={(event) => {
        // Back to the thumbnail – unless its row was unmounted meanwhile (then the list itself).
        const target = viewing.trigger.isConnected ? viewing.trigger : fallbackFocus();
        if (target === null) return;
        event.preventDefault();
        target.focus();
      }}
    />
  );
}

/**
 * The single lightbox of a TranscriptView (WP-37 §8): thumbnails open it through
 * `ImageViewerContext`. It is rendered next to the virtualized list, not inside a row, so it stays
 * open while new output scrolls the thumbnail's row away (virtua unmounts rows off screen).
 * WP-63: a thumbnail of a gallery opens it with previous/next over the gallery's images.
 */
export function ImageViewer({
  children,
  fallbackFocus,
}: {
  children: ReactNode;
  /** Focus target after closing when the thumbnail is gone (the transcript region). */
  fallbackFocus: () => HTMLElement | null;
}) {
  const [viewing, setViewing] = useState<Viewing | null>(null);
  const openImage = useCallback<OpenImage>((image, trigger, gallery) => {
    // The same picture may come twice (blobs are content-addressed): the thumbnail's own entry first.
    let position = gallery?.indexOf(image) ?? -1;
    if (position < 0) position = gallery?.findIndex((candidate) => candidate.blobId === image.blobId) ?? -1;
    const images = gallery !== undefined && position >= 0 ? gallery : [image];
    setViewing((current) => ({
      images,
      index: Math.max(0, position),
      image,
      trigger,
      open: true,
      serial: (current?.serial ?? 0) + 1,
    }));
  }, []);
  const step = useCallback((index: number) => {
    setViewing((current) => {
      const image = current?.images[index];
      return current === null || image === undefined ? current : { ...current, index, image };
    });
  }, []);
  const close = useCallback(() => {
    setViewing((current) => (current === null ? null : { ...current, open: false }));
  }, []);
  return (
    <ImageViewerContext value={openImage}>
      {children}
      {viewing === null ? null : (
        <ViewerLightbox
          key={viewing.serial}
          viewing={viewing}
          onStep={step}
          onClose={close}
          fallbackFocus={fallbackFocus}
        />
      )}
    </ImageViewerContext>
  );
}
