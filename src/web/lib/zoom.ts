import { DEFAULT_ZOOM, MAX_ZOOM, MIN_ZOOM, ZOOM_LEVELS } from '@shared/model';

/**
 * Zoom steps (WP-92, ADR-233): pure helpers around `settings.zoom` (percent). The zoom is the root
 * font size of the page, so everything in rem grows with it. Layout code keeps its widths in
 * "layout px" (CSS px of the rem design at a 16 px root), converts measured screen px with
 * `toLayoutPx` and sets widths with `toScreenPx`.
 *
 * WP-96 (ADR-237): the design's default size is BASE_ZOOM – at the setting 100 % the root font size
 * is 110 % of the browser default (what 110 % looked like before). The setting stays relative to it,
 * so every conversion goes through `zoomFactor`, which includes the base.
 */

export { DEFAULT_ZOOM, MAX_ZOOM, MIN_ZOOM, ZOOM_LEVELS };

/** Root font size at the setting 100 %, in percent of the browser default (user, 20.11.2026). */
export const BASE_ZOOM = 110;

/** `percent` as a whole number within 50 … 200 (anything not finite → 100). */
export function clampZoom(percent: number): number {
  if (!Number.isFinite(percent)) return DEFAULT_ZOOM;
  return Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, Math.round(percent)));
}

/** The next step above (`direction` 1) or below (-1); a value between two steps snaps to the next one. */
export function stepZoom(current: number, direction: 1 | -1): number {
  const value = clampZoom(current);
  if (direction === 1) return ZOOM_LEVELS.find((level) => level > value) ?? MAX_ZOOM;
  return ZOOM_LEVELS.findLast((level) => level < value) ?? MIN_ZOOM;
}

/** Screen px per layout px at this setting: 100 → 1.1, 125 → 1.375 (integer math, so 1.1 is exact). */
export function zoomFactor(percent: number): number {
  return (clampZoom(percent) * BASE_ZOOM) / 10_000;
}

/** The root font size for this setting: 100 → `110%`, 125 → `137.5%`. */
export function rootFontSize(percent: number): string {
  return `${String((clampZoom(percent) * BASE_ZOOM) / 100)}%`;
}

/**
 * Screen px (measured, e.g. `innerWidth` or a ResizeObserver) → layout px at this zoom. Both
 * conversions multiply before dividing, so whole results stay whole (1100 → 1000, not 999.99…).
 */
export function toLayoutPx(px: number, percent: number): number {
  return (px * 10_000) / (clampZoom(percent) * BASE_ZOOM);
}

/** Layout px → screen px at this zoom (e.g. an inline `width`): 320 → 352 at 100 %. */
export function toScreenPx(px: number, percent: number): number {
  return (px * clampZoom(percent) * BASE_ZOOM) / 10_000;
}
