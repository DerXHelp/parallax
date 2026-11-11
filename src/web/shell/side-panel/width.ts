import { readStorage, storageKey, writeStorage } from '@web/lib/storage';

/**
 * Width rules of the side panel (WP-54, ADR-150): 320 px … 70 % of the session area, remembered per
 * window. Pure helpers (no React) – the host measures the area and calls them.
 */

export const SIDE_PANEL_MIN_WIDTH = 320;
/** Largest share of the session area (transcript + panel). */
export const SIDE_PANEL_MAX_SHARE = 0.7;
/** Below this session area width the panel lies over the transcript (V3-14, WP-58 narrows the window). */
export const SIDE_PANEL_OVERLAY_BELOW = 1100;
/** Default without a remembered width: the former fixed width `min(42rem, 45 %)`. */
const DEFAULT_MAX_WIDTH = 672;
const DEFAULT_SHARE = 0.45;
/** Fallback area width before the first measurement. */
const FALLBACK_AREA = 1280;

/** `parallax.sidePanel.width`: localStorage (last width of any window) and sessionStorage (this window). */
export const SIDE_PANEL_WIDTH_KEY = storageKey('sidePanel', 'width');

function parseWidth(value: string | null): number | null {
  if (value === null) return null;
  const width = Number.parseInt(value, 10);
  return Number.isFinite(width) && width > 0 ? width : null;
}

/**
 * The remembered width: this window's own value (sessionStorage survives a reload of the window),
 * else the last width any window used (localStorage). Broken or missing storage → null.
 */
export function readSidePanelWidth(): number | null {
  return (
    parseWidth(readStorage('session', SIDE_PANEL_WIDTH_KEY)) ??
    parseWidth(readStorage('local', SIDE_PANEL_WIDTH_KEY))
  );
}

/** Remembers the width in both areas (errors are swallowed by lib/storage). */
export function writeSidePanelWidth(width: number): void {
  const value = String(Math.round(width));
  writeStorage('session', SIDE_PANEL_WIDTH_KEY, value);
  writeStorage('local', SIDE_PANEL_WIDTH_KEY, value);
}

function areaOrFallback(area: number | null): number {
  if (area !== null && area > 0) return area;
  return typeof window === 'undefined' ? FALLBACK_AREA : window.innerWidth || FALLBACK_AREA;
}

/** `area × share` rounded down to whole px (1400 × 0.7 = 979.999… in floating point → 980). */
function share(area: number | null, fraction: number): number {
  return Math.floor(areaOrFallback(area) * fraction + 1e-6);
}

/** Largest width for a session area of `area` px (never below the minimum). */
export function sidePanelMaxWidth(area: number | null): number {
  return Math.max(SIDE_PANEL_MIN_WIDTH, share(area, SIDE_PANEL_MAX_SHARE));
}

/** Width without a remembered value: min(672 px, 45 % of the area), at least the minimum. */
export function defaultSidePanelWidth(area: number | null): number {
  return Math.max(SIDE_PANEL_MIN_WIDTH, Math.min(DEFAULT_MAX_WIDTH, share(area, DEFAULT_SHARE)));
}

/** `width` within 320 px … 70 % of the area; never wider than the area itself. */
export function clampSidePanelWidth(width: number, area: number | null): number {
  const clamped = Math.min(Math.max(Math.round(width), SIDE_PANEL_MIN_WIDTH), sidePanelMaxWidth(area));
  return area !== null && area > 0 ? Math.min(clamped, area) : clamped;
}

/** True when the panel should lie over the transcript (session area narrower than 1100 px). */
export function isSidePanelOverlay(area: number | null): boolean {
  return area !== null && area > 0 && area < SIDE_PANEL_OVERLAY_BELOW;
}
