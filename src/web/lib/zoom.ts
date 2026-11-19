import { DEFAULT_ZOOM, MAX_ZOOM, MIN_ZOOM, ZOOM_LEVELS } from '@shared/model';

/**
 * Zoom steps (WP-92, ADR-233): pure helpers around `settings.zoom` (percent). The zoom is the root
 * font size of the page, so everything in rem grows with it. Layout code keeps its widths in
 * "layout px" (CSS px at 100 %), converts measured screen px with `toLayoutPx` and sets widths
 * with `toScreenPx`.
 */

export { DEFAULT_ZOOM, MAX_ZOOM, MIN_ZOOM, ZOOM_LEVELS };

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

/** The step closest to `percent` (ties go to the smaller one), e.g. for a select of the steps. */
export function nearestZoomLevel(percent: number): number {
  const value = clampZoom(percent);
  let best: number = DEFAULT_ZOOM;
  let bestDistance = Number.POSITIVE_INFINITY;
  for (const level of ZOOM_LEVELS) {
    const distance = Math.abs(level - value);
    if (distance < bestDistance) {
      best = level;
      bestDistance = distance;
    }
  }
  return best;
}

/** 125 → 1.25. */
export function zoomFactor(percent: number): number {
  return clampZoom(percent) / 100;
}

/** Screen px (measured, e.g. `innerWidth` or a ResizeObserver) → layout px at this zoom. */
export function toLayoutPx(px: number, percent: number): number {
  return px / zoomFactor(percent);
}

/** Layout px → screen px at this zoom (e.g. an inline `width`). */
export function toScreenPx(px: number, percent: number): number {
  return px * zoomFactor(percent);
}
