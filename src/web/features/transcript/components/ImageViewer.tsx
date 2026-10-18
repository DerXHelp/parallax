import { useCallback, useState, type ReactNode } from 'react';
import type { BlobRef } from '@shared/model';
import { Lightbox } from '@web/ui/lightbox';
import { ImageViewerContext, type OpenImage } from '../context';
import { useBlobImage, useLightboxLabels } from './ImageThumb';

interface Viewing {
  image: BlobRef;
  trigger: HTMLElement;
  open: boolean;
  /** Counts the openings: every one starts a fresh lightbox (zoom "fit", size of the new image). */
  serial: number;
}

function ViewerLightbox({
  viewing,
  onClose,
  fallbackFocus,
}: {
  viewing: Viewing;
  onClose: () => void;
  fallbackFocus: () => HTMLElement | null;
}) {
  const { lightbox } = useBlobImage(viewing.image);
  const labels = useLightboxLabels(lightbox.alt);
  return (
    <Lightbox
      image={lightbox}
      labels={labels}
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
  const openImage = useCallback<OpenImage>((image, trigger) => {
    setViewing((current) => ({ image, trigger, open: true, serial: (current?.serial ?? 0) + 1 }));
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
          onClose={close}
          fallbackFocus={fallbackFocus}
        />
      )}
    </ImageViewerContext>
  );
}
