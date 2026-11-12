import {
  ChevronLeftIcon,
  ChevronRightIcon,
  DownloadIcon,
  ExpandIcon,
  ShrinkIcon,
  XIcon,
  ZoomInIcon,
  ZoomOutIcon,
} from 'lucide-react';
import { Dialog as DialogPrimitive } from 'radix-ui';
import { useEffect, useEffectEvent, useRef, useState, type KeyboardEvent, type ReactNode } from 'react';
import { cn } from '@web/lib/cn';
import { buttonVariants } from './button';
import { IconButton } from './icon-button';

/**
 * Image lightbox (Plan "Anhänge … Lightbox mit Zoom und Speichern unter", WP-37): a modal dialog
 * (focus trap, Esc closes, the focus returns to the trigger) with the image fitted to the window
 * or zoomed (buttons, mouse wheel, keys + − 0 1), and "Save as" as a download link
 * (`<a href download>`). All texts come from the caller (`t()` of the feature); the source is a
 * same-origin blob path or a `blob:`/`data:` URL (CSP `img-src`). With a trigger (`children`) it
 * opens itself; without one it is controlled (`open`) – e.g. one lightbox for a virtualized list.
 * WP-63: with `navigation` it steps through a gallery (buttons, ← → while the image is fitted);
 * a new image starts fitted again.
 */

export interface LightboxImage {
  src: string;
  alt: string;
  /** File name offered by "Save as". */
  downloadName: string;
  /** Natural size when known (blob refs), else read from the loaded image. */
  width?: number | null;
  height?: number | null;
}

export interface LightboxLabels {
  /** Dialog title (shown in the toolbar). */
  title: string;
  zoomIn: string;
  zoomOut: string;
  fit: string;
  actualSize: string;
  save: string;
  close: string;
  /** Zoom level text, e.g. "125 %". */
  zoom: (percent: number) => string;
}

/** Previous/next of a gallery (WP-63); texts from the caller. */
export interface LightboxNavigation {
  /** 0-based position of the shown image. */
  index: number;
  count: number;
  onPrevious: () => void;
  onNext: () => void;
  previous: string;
  next: string;
  /** "Image 2 of 7". */
  position: string;
}

/** Zoom steps: ×1.25 per step, between 10 % and 800 %. */
export const ZOOM_STEP = 1.25;
export const ZOOM_MIN = 0.1;
export const ZOOM_MAX = 8;

/** Padding of the image area (`p-4` on both sides). */
const VIEWPORT_PADDING = 32;

function clampZoom(value: number): number {
  return Math.min(ZOOM_MAX, Math.max(ZOOM_MIN, value));
}

interface Size {
  width: number;
  height: number;
}

/** Scale that fits `natural` into `box` (never enlarged); 1 when a size is unknown. */
export function fitScale(natural: Size | null, box: Size | null): number {
  if (natural === null || box === null || natural.width <= 0 || natural.height <= 0) return 1;
  if (box.width <= 0 || box.height <= 0) return 1;
  return Math.min(1, box.width / natural.width, box.height / natural.height);
}

export interface LightboxProps {
  image: LightboxImage;
  labels: LightboxLabels;
  /**
   * The trigger (rendered `asChild`, e.g. a button around the thumbnail); the focus returns to it.
   * Without one the lightbox is controlled (`open`) and `onCloseAutoFocus` places the focus.
   */
  children?: ReactNode;
  open?: boolean;
  onOpenChange?: (open: boolean) => void;
  /** After closing (Radix): `preventDefault()` and focus an element of your own. */
  onCloseAutoFocus?: (event: Event) => void;
  /** WP-63: step through a gallery. */
  navigation?: LightboxNavigation;
}

export function Lightbox({
  image,
  labels,
  children,
  open,
  onOpenChange,
  onCloseAutoFocus,
  navigation,
}: LightboxProps) {
  return (
    <DialogPrimitive.Root open={open} onOpenChange={onOpenChange}>
      {children === undefined ? null : <DialogPrimitive.Trigger asChild>{children}</DialogPrimitive.Trigger>}
      <DialogPrimitive.Portal>
        {/* Denser than the dialog overlay, so the image stands alone (a token colour, not black). */}
        <DialogPrimitive.Overlay
          data-slot="lightbox-overlay"
          className="bg-background/90 backdrop-blur-sm data-[state=open]:animate-in data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=open]:fade-in-0 fixed inset-0 z-50"
        />
        <LightboxContent
          image={image}
          labels={labels}
          onCloseAutoFocus={onCloseAutoFocus}
          navigation={navigation}
        />
      </DialogPrimitive.Portal>
    </DialogPrimitive.Root>
  );
}

function knownSize(image: LightboxImage): Size | null {
  const { width, height } = image;
  return width === null || width === undefined || height === null || height === undefined
    ? null
    : { width, height };
}

function LightboxContent({
  image,
  labels,
  onCloseAutoFocus,
  navigation,
}: {
  image: LightboxImage;
  labels: LightboxLabels;
  onCloseAutoFocus: ((event: Event) => void) | undefined;
  navigation: LightboxNavigation | undefined;
}) {
  const viewportRef = useRef<HTMLDivElement>(null);
  /** 'fit' = into the window; a number = scale of the natural size. */
  const [zoom, setZoom] = useState<number | 'fit'>('fit');
  const [natural, setNatural] = useState<Size | null>(() => knownSize(image));
  const [box, setBox] = useState<Size | null>(null);
  // WP-63: another image of the gallery starts fitted, with its own size.
  const [shownSrc, setShownSrc] = useState(image.src);
  if (shownSrc !== image.src) {
    setShownSrc(image.src);
    setZoom('fit');
    setNatural(knownSize(image));
  }
  // A step to the first or last image disables the button that had the focus (click or ← →
  // pressed on it): the focus would fall out of the box – the image area takes it back.
  const index = navigation?.index;
  useEffect(() => {
    if (index === undefined) return;
    const active = document.activeElement;
    if (
      active === null ||
      active === document.body ||
      (active instanceof HTMLButtonElement && active.disabled)
    ) {
      viewportRef.current?.focus();
    }
  }, [index]);

  const fitted = fitScale(natural, box);
  const scale = zoom === 'fit' ? fitted : zoom;

  const measure = () => {
    const viewport = viewportRef.current;
    if (viewport === null) return;
    setBox({
      width: viewport.clientWidth - VIEWPORT_PADDING,
      height: viewport.clientHeight - VIEWPORT_PADDING,
    });
  };

  const zoomBy = (factor: number) => {
    measure();
    setZoom((current) => clampZoom((current === 'fit' ? fitted : current) * factor));
  };

  // The wheel zooms (a native listener: React's wheel listener is passive and cannot prevent the scroll).
  const onWheel = useEffectEvent((event: WheelEvent) => {
    if (event.deltaY === 0) return;
    event.preventDefault();
    zoomBy(event.deltaY < 0 ? ZOOM_STEP : 1 / ZOOM_STEP);
  });
  useEffect(() => {
    const viewport = viewportRef.current;
    if (viewport === null) return undefined;
    const listener = (event: WheelEvent) => {
      onWheel(event);
    };
    viewport.addEventListener('wheel', listener, { passive: false });
    return () => {
      viewport.removeEventListener('wheel', listener);
    };
  }, []);

  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.ctrlKey || event.altKey || event.metaKey) return;
    // A zoomed image keeps the arrow keys for scrolling.
    if (navigation !== undefined && zoom === 'fit') {
      if (event.key === 'ArrowLeft' && navigation.index > 0) {
        event.preventDefault();
        navigation.onPrevious();
        return;
      }
      if (event.key === 'ArrowRight' && navigation.index < navigation.count - 1) {
        event.preventDefault();
        navigation.onNext();
        return;
      }
    }
    switch (event.key) {
      case '+':
      case '=':
        zoomBy(ZOOM_STEP);
        break;
      case '-':
        zoomBy(1 / ZOOM_STEP);
        break;
      case '0':
        setZoom('fit');
        break;
      case '1':
        setZoom(1);
        break;
      default:
        return;
    }
    event.preventDefault();
  };

  const width = natural === null ? undefined : Math.round(natural.width * scale);
  const height = natural === null ? undefined : Math.round(natural.height * scale);

  return (
    <DialogPrimitive.Content
      data-slot="lightbox"
      data-zoom={zoom === 'fit' ? 'fit' : String(Math.round(zoom * 100))}
      aria-describedby={undefined}
      onOpenAutoFocus={(event) => {
        // The image area, not the first toolbar button (its tooltip would take the first Esc).
        event.preventDefault();
        viewportRef.current?.focus();
      }}
      onCloseAutoFocus={onCloseAutoFocus}
      onKeyDown={onKeyDown}
      className="data-[state=open]:animate-in data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=open]:fade-in-0 fixed inset-0 z-50 flex flex-col outline-none"
    >
      <div className="bg-popover text-popover-foreground flex min-h-10 items-center gap-1 border-b px-3 py-1 shadow-sm">
        <DialogPrimitive.Title className="min-w-0 flex-1 truncate text-xs font-medium">
          {labels.title}
        </DialogPrimitive.Title>
        {navigation === undefined || navigation.count < 2 ? null : (
          <>
            <IconButton
              label={navigation.previous}
              data-action="lightbox-previous"
              onClick={navigation.onPrevious}
              disabled={navigation.index <= 0}
            >
              <ChevronLeftIcon aria-hidden />
            </IconButton>
            <span
              data-slot="lightbox-position"
              className="text-muted-foreground text-2xs whitespace-nowrap tabular-nums"
            >
              {navigation.position}
            </span>
            <IconButton
              label={navigation.next}
              data-action="lightbox-next"
              onClick={navigation.onNext}
              disabled={navigation.index >= navigation.count - 1}
            >
              <ChevronRightIcon aria-hidden />
            </IconButton>
          </>
        )}
        <IconButton
          label={labels.zoomOut}
          onClick={() => {
            zoomBy(1 / ZOOM_STEP);
          }}
          disabled={scale <= ZOOM_MIN}
        >
          <ZoomOutIcon aria-hidden />
        </IconButton>
        <span
          data-slot="lightbox-zoom"
          className="text-muted-foreground w-12 text-center text-2xs tabular-nums"
        >
          {labels.zoom(Math.round(scale * 100))}
        </span>
        <IconButton
          label={labels.zoomIn}
          onClick={() => {
            zoomBy(ZOOM_STEP);
          }}
          disabled={scale >= ZOOM_MAX}
        >
          <ZoomInIcon aria-hidden />
        </IconButton>
        <IconButton
          label={labels.fit}
          aria-pressed={zoom === 'fit'}
          onClick={() => {
            setZoom('fit');
          }}
        >
          <ShrinkIcon aria-hidden />
        </IconButton>
        <IconButton
          label={labels.actualSize}
          aria-pressed={zoom === 1}
          onClick={() => {
            setZoom(1);
          }}
        >
          <ExpandIcon aria-hidden />
        </IconButton>
        <a
          href={image.src}
          download={image.downloadName}
          aria-label={labels.save}
          title={labels.save}
          data-slot="lightbox-save"
          className={buttonVariants({ variant: 'ghost', size: 'icon-sm' })}
        >
          <DownloadIcon aria-hidden />
        </a>
        <DialogPrimitive.Close
          aria-label={labels.close}
          title={labels.close}
          className={buttonVariants({ variant: 'ghost', size: 'icon-sm' })}
        >
          <XIcon aria-hidden />
        </DialogPrimitive.Close>
      </div>
      {/* Focusable: arrow keys scroll a zoomed image. */}
      <div
        ref={viewportRef}
        role="group"
        aria-label={labels.title}
        tabIndex={0}
        data-slot="lightbox-viewport"
        className={cn(
          'focus-visible:ring-ring/60 flex min-h-0 flex-1 overflow-auto p-4 outline-none focus-visible:ring-2 focus-visible:ring-inset',
          zoom === 'fit' ? 'items-center justify-center' : 'items-start justify-start',
        )}
      >
        <img
          src={image.src}
          alt={image.alt}
          draggable={false}
          onLoad={(event) => {
            const img = event.currentTarget;
            if (img.naturalWidth > 0 && img.naturalHeight > 0) {
              setNatural({ width: img.naturalWidth, height: img.naturalHeight });
            }
            measure();
          }}
          style={zoom === 'fit' || width === undefined ? undefined : { width, height, maxWidth: 'none' }}
          className={cn(
            'm-auto shrink-0 rounded-sm shadow-lg select-none',
            zoom === 'fit' && 'max-h-full max-w-full object-contain',
          )}
        />
      </div>
    </DialogPrimitive.Content>
  );
}
