import { describe, expect, it } from 'vitest';
import { sampleItems } from '@shared/samples';
import { sliceAround } from './transcriptWindow';

const items = Array.from({ length: 10 }, (_, i) =>
  sampleItems.userMessage({ id: `u${String(i + 1)}`, order: i + 1 }),
);
const ids = (window: ReturnType<typeof sliceAround>) => window?.items.map((item) => item.id);

describe('sliceAround (WP-110)', () => {
  it('returns the item and up to n items on each side', () => {
    const window = sliceAround(items, 'u5', 2);
    expect(ids(window)).toEqual(['u3', 'u4', 'u5', 'u6', 'u7']);
    expect(window).toMatchObject({ hasEarlier: true, hasLater: true });
  });

  it('stops at both ends', () => {
    expect(sliceAround(items, 'u1', 3)).toMatchObject({ hasEarlier: false, hasLater: true });
    expect(ids(sliceAround(items, 'u10', 3))).toEqual(['u7', 'u8', 'u9', 'u10']);
    expect(sliceAround(items, 'u10', 3)?.hasLater).toBe(false);
    expect(ids(sliceAround(items, 'u5', -1))).toEqual(['u5']);
  });

  it('null for an unknown item', () => {
    expect(sliceAround(items, 'nope', 5)).toBeNull();
  });
});
