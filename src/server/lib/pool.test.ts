import { describe, expect, it } from 'vitest';
import { mapPool } from './pool';

describe('mapPool', () => {
  it('keeps the item order and never runs more than `limit` calls at once', async () => {
    let running = 0;
    let peak = 0;
    const results = await mapPool([5, 1, 4, 2, 3, 0, 6, 7, 8, 9], 3, async (value, index) => {
      running += 1;
      peak = Math.max(peak, running);
      await new Promise((resolve) => setTimeout(resolve, value));
      running -= 1;
      return `${String(index)}:${String(value)}`;
    });
    expect(results).toEqual(['0:5', '1:1', '2:4', '3:2', '4:3', '5:0', '6:6', '7:7', '8:8', '9:9']);
    expect(peak).toBe(3);
    expect(await mapPool([], 8, () => Promise.resolve(1))).toEqual([]);
  });

  it('a throwing call rejects the whole map', async () => {
    await expect(
      mapPool([1, 2, 3], 2, (value) =>
        value === 2 ? Promise.reject(new Error('boom')) : Promise.resolve(value),
      ),
    ).rejects.toThrow('boom');
  });
});
