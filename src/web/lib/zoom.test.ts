import { describe, expect, it } from 'vitest';
import {
  BASE_ZOOM,
  clampZoom,
  rootFontSize,
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

  it('converts between screen px and layout px, the base size included (WP-96)', () => {
    expect(BASE_ZOOM).toBe(110);
    expect(zoomFactor(100)).toBe(1.1);
    expect(zoomFactor(125)).toBe(1.375);
    expect(toLayoutPx(1100, 100)).toBe(1000);
    expect(toLayoutPx(1100, 125)).toBe(800);
    expect(toScreenPx(288, 100)).toBe(316.8);
    expect(toScreenPx(320, 100)).toBe(352);
    expect(toLayoutPx(990, 100)).toBe(900);
    expect(toScreenPx(288, 125)).toBe(396);
    expect(toLayoutPx(toScreenPx(321, 175), 175)).toBeCloseTo(321);
  });

  it('the root font size is the setting times the base size (WP-96)', () => {
    expect(rootFontSize(100)).toBe('110%');
    expect(rootFontSize(67)).toBe('73.7%');
    expect(rootFontSize(125)).toBe('137.5%');
    expect(rootFontSize(200)).toBe('220%');
    expect(rootFontSize(Number.NaN)).toBe('110%');
  });
});
