/**
 * Images of the interactive fake scenario (Phase 2, WP-34): `fake:image` reads `fake-shot.png` and
 * gets an image tool result – a tiny but complete PNG (24×16 RGB, signature + IHDR + IDAT + IEND
 * with valid CRCs, 98 bytes), so the normalizer stores it as a blob and the UI shows it (lightbox);
 * a prompt with images is answered with how many arrived.
 */
import type { OutgoingPrompt } from '../types';

export const FAKE_SHOT_NAME = 'fake-shot.png';
export const FAKE_SHOT_WIDTH = 24;
export const FAKE_SHOT_HEIGHT = 16;

/** "Window" in light grey with a dark title bar and an orange block. */
export const FAKE_SHOT_PNG_BASE64 =
  'iVBORw0KGgoAAAANSUhEUgAAABgAAAAQCAIAAACDRijCAAAAKUlEQVR42mPQ0DGhCmIYfAZ9/fqBKmgwG3SzPBwrGjVoMBs0jBMkhQgAcCdmjnAQHR8AAAAASUVORK5CYII=';

/** Number of image blocks of a prompt. */
export function promptImageCount(prompt: OutgoingPrompt): number {
  return prompt.content.filter((block) => block.type === 'image').length;
}

/** Answer of the fake CLI to a prompt with images. */
export function receivedImagesText(count: number): string {
  return `Fake: received ${String(count)} image(s)`;
}
