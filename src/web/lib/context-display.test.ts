import { describe, expect, it } from 'vitest';
import { sampleContextGauge } from '@shared/samples';
import { AUTOCOMPACT_SOON_RATIO, contextDisplay, contextLevel } from './context-display';

const opus = (totalTokens: number, autoCompactThreshold: number | null) =>
  sampleContextGauge({
    totalTokens,
    maxTokens: 1_000_000,
    percentage: Math.round(totalTokens / 10_000),
    autoCompactThreshold,
    isAutoCompactEnabled: autoCompactThreshold === null ? null : true,
  });

describe('context display (WP-63 §1.4)', () => {
  it('Opus 1M, autocompact 400k, 260k → neutral, no symbol; the bar runs to the threshold', () => {
    const display = contextDisplay(opus(260_000, 400_000));
    expect(display).toMatchObject({
      level: 'normal',
      compactSoon: false,
      autoCompactAt: 400_000,
      fill: 65,
      windowPercent: 26,
      tokensUntilCompact: 140_000,
    });
  });

  it('Opus 1M, autocompact 400k, 380k → neutral + symbol (autocompact in 20k)', () => {
    expect(contextDisplay(opus(380_000, 400_000))).toMatchObject({
      level: 'normal',
      compactSoon: true,
      fill: 95,
      tokensUntilCompact: 20_000,
    });
  });

  it('Sonnet 200k without early compact, 120k → warning (60 % of the window)', () => {
    const display = contextDisplay(
      sampleContextGauge({ totalTokens: 120_000, maxTokens: 200_000, percentage: 60 }),
    );
    expect(display).toMatchObject({ level: 'warning', compactSoon: false, autoCompactAt: null, fill: 60 });
  });

  it('Opus 1M without autocompact, 850k → danger', () => {
    expect(contextDisplay(opus(850_000, null))).toMatchObject({
      level: 'danger',
      fill: 85,
      compactSoon: false,
    });
  });

  it('really full and compact soon at the same time', () => {
    const display = contextDisplay(
      sampleContextGauge({
        totalTokens: 160_000,
        maxTokens: 200_000,
        autoCompactThreshold: 167_000,
        isAutoCompactEnabled: true,
      }),
    );
    expect(display).toMatchObject({ level: 'danger', compactSoon: true });
  });

  it('autocompact off or unknown, or a threshold beyond the window → scaled to the window', () => {
    const base = { totalTokens: 380_000, maxTokens: 1_000_000, autoCompactThreshold: 400_000 };
    for (const isAutoCompactEnabled of [false, null]) {
      expect(contextDisplay(sampleContextGauge({ ...base, isAutoCompactEnabled }))).toMatchObject({
        autoCompactAt: null,
        fill: 38,
        compactSoon: false,
      });
    }
    expect(
      contextDisplay(
        sampleContextGauge({ ...base, maxTokens: 300_000, totalTokens: 100_000, isAutoCompactEnabled: true }),
      ).autoCompactAt,
    ).toBeNull();
  });

  it('the symbol starts exactly at the ratio; over the threshold the fill stays at 100', () => {
    expect(contextDisplay(opus(400_000 * AUTOCOMPACT_SOON_RATIO, 400_000)).compactSoon).toBe(true);
    expect(contextDisplay(opus(400_000 * AUTOCOMPACT_SOON_RATIO - 1, 400_000)).compactSoon).toBe(false);
    expect(contextDisplay(opus(450_000, 400_000))).toMatchObject({ fill: 100, tokensUntilCompact: 0 });
  });

  it('levels: below 50 neutral, from 50 warning, from 80 danger', () => {
    expect([49.9, 50, 79.9, 80].map(contextLevel)).toEqual(['normal', 'warning', 'warning', 'danger']);
  });
});
