import { LIMITS } from '@shared/common';
import { ATTACHMENT_MEDIA_TYPES, type AttachmentMediaType } from '@shared/http';
import { fileNameForMediaType } from '@web/lib/media-types';

/**
 * Client-side preparation of image attachments before the upload (ADR-103, WP-37 §4): decode with
 * `createImageBitmap`, scale the long edge to `LIMITS.imageMaxEdgePx`, encode as PNG; above
 * `LIMITS.imageBytes` as JPEG with quality 0.9 → 0.8 → 0.7, else an error. An image that needs
 * neither scaling nor a smaller file stays as it is (no needless re-encoding of a small JPEG as a
 * larger PNG; a small GIF keeps its animation). A GIF above the edge limit is scaled like any other
 * image (R4W-26) – its animation is lost then.
 */

export function isAttachmentType(type: string): type is AttachmentMediaType {
  return (ATTACHMENT_MEDIA_TYPES as readonly string[]).includes(type);
}

export interface Size {
  width: number;
  height: number;
}

/** Size with the long edge at most `maxEdge` (aspect ratio kept, never below 1 px, never enlarged). */
export function fitWithin(size: Size, maxEdge: number): Size {
  const longEdge = Math.max(size.width, size.height);
  if (longEdge <= maxEdge) return { width: size.width, height: size.height };
  const scale = maxEdge / longEdge;
  return {
    width: Math.max(1, Math.round(size.width * scale)),
    height: Math.max(1, Math.round(size.height * scale)),
  };
}

export interface EncodeStep {
  type: 'image/png' | 'image/jpeg';
  /** JPEG quality (0–1); PNG has none. */
  quality: number | null;
}

/** Encodings tried in order until one fits `LIMITS.imageBytes` (ADR-103). */
export const ENCODE_STEPS: readonly EncodeStep[] = [
  { type: 'image/png', quality: null },
  { type: 'image/jpeg', quality: 0.9 },
  { type: 'image/jpeg', quality: 0.8 },
  { type: 'image/jpeg', quality: 0.7 },
];

export interface PreparedImage extends Size {
  blob: Blob;
  type: AttachmentMediaType;
  /** File name matching the type (`shot.png` → `shot.jpg` after a JPEG step). */
  name: string;
}

/** `type`: not an image type of the API; `decode`: unreadable; `tooLarge`: even JPEG 0.7 is too big. */
export type ImageProblem = 'type' | 'decode' | 'tooLarge';

export class ImagePrepareError extends Error {
  constructor(readonly problem: ImageProblem) {
    super(`image ${problem}`);
    this.name = 'ImagePrepareError';
  }
}

/** A decoded image: its size, an encoder at another size, and the release of the bitmap. */
export interface DecodedImage extends Size {
  /** Draws the image at `size` and encodes it; null when the browser cannot encode. */
  encode(size: Size, step: EncodeStep): Promise<Blob | null>;
  close(): void;
}

/** Decoder (replaced in tests: happy-dom has neither `createImageBitmap` nor a canvas). */
export type ImageDecoder = (file: Blob) => Promise<DecodedImage>;

/** `createImageBitmap` + a 2D canvas (`toBlob`). */
export const decodeWithCanvas: ImageDecoder = async (file) => {
  const bitmap = await createImageBitmap(file);
  return {
    width: bitmap.width,
    height: bitmap.height,
    close: () => {
      bitmap.close();
    },
    encode: (size, step) => {
      const canvas = document.createElement('canvas');
      canvas.width = size.width;
      canvas.height = size.height;
      const context = canvas.getContext('2d');
      if (context === null) return Promise.resolve(null);
      if (step.type === 'image/jpeg') {
        // JPEG has no alpha: transparent screenshot parts would turn black.
        context.fillStyle = '#ffffff';
        context.fillRect(0, 0, size.width, size.height);
      }
      context.imageSmoothingQuality = 'high';
      context.drawImage(bitmap, 0, 0, size.width, size.height);
      return new Promise((resolve) => {
        canvas.toBlob(
          (blob) => {
            resolve(blob);
          },
          step.type,
          step.quality ?? undefined,
        );
      });
    },
  };
};

/** `name` with the extension of `type` (pasted images are often just "image.png"). */
export function nameForType(name: string, type: AttachmentMediaType): string {
  return fileNameForMediaType(name, type);
}

export interface PrepareOptions {
  decode?: ImageDecoder;
  maxEdge?: number;
  maxBytes?: number;
}

/** Prepares one image for the upload; rejects with `ImagePrepareError`. */
export async function prepareImage(file: File, options: PrepareOptions = {}): Promise<PreparedImage> {
  const maxEdge = options.maxEdge ?? LIMITS.imageMaxEdgePx;
  const maxBytes = options.maxBytes ?? LIMITS.imageBytes;
  const decode = options.decode ?? decodeWithCanvas;
  const type = file.type;
  if (!isAttachmentType(type)) throw new ImagePrepareError('type');
  let decoded: DecodedImage;
  try {
    decoded = await decode(file);
  } catch {
    throw new ImagePrepareError('decode');
  }
  try {
    const original: Size = { width: decoded.width, height: decoded.height };
    const target = fitWithin(original, maxEdge);
    const unscaled = target.width === original.width && target.height === original.height;
    if (file.size <= maxBytes && unscaled) {
      return { blob: file, type, name: nameForType(file.name, type), ...original };
    }
    for (const step of ENCODE_STEPS) {
      const blob = await decoded.encode(target, step);
      if (blob !== null && blob.size <= maxBytes) {
        return { blob, type: step.type, name: nameForType(file.name, step.type), ...target };
      }
    }
    throw new ImagePrepareError('tooLarge');
  } finally {
    decoded.close();
  }
}
