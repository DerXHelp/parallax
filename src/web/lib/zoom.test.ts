import { describe, expect, it } from 'vitest';
import {
  clampZoom,
  nearestZoomLevel,
  stepZoom,
  toLayoutPx,
  toScreenPx,
  zoomFactor,
  ZOOM_LEVELS,
} from './zoom';

describe('zoom steps (WP-92)', () => {
  it('clamps to whole percent within 50 … 200', () => {
    expect(clampZoom(30)).toBe(50);
    expect(clampZoom(260)).toBe(200);
    expect(clampZoom(124.6)).toBe(125);
    expect(clampZoom(Number.NaN)).toBe(100);
  });

  it('moves one step up or down; a value between two steps snaps to the next one', () => {
    expect(stepZoom(100, 1)).toBe(110);
    expect(stepZoom(100, -1)).toBe(90);
    expect(stepZoom(67, -1)).toBe(50);
    expect(stepZoom(85, 1)).toBe(90);
    expect(stepZoom(85, -1)).toBe(80);
    expect(stepZoom(200, 1)).toBe(200);
    expect(stepZoom(50, -1)).toBe(50);
    // Every step is reached from 50 to 200 and back.
    const up: number[] = [];
    for (let value = 50; value < 200; value = stepZoom(value, 1)) up.push(value);
    expect([...up, 200]).toEqual([...ZOOM_LEVELS]);
  });

  it('finds the nearest step', () => {
    expect(nearestZoomLevel(100)).toBe(100);
    expect(nearestZoomLevel(118)).toBe(125);
    expect(nearestZoomLevel(117)).toBe(110);
    expect(nearestZoomLevel(999)).toBe(200);
  });

  it('converts between screen px and layout px', () => {
    expect(zoomFactor(125)).toBe(1.25);
    expect(toLayoutPx(1000, 125)).toBe(800);
    expect(toScreenPx(288, 125)).toBe(360);
    expect(toLayoutPx(toScreenPx(321, 175), 175)).toBeCloseTo(321);
  });
});
