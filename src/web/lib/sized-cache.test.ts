import { describe, expect, it } from 'vitest';
import { SizedLru } from './sized-cache';

describe('SizedLru (R2W-06/R2W-18)', () => {
  it('evicts the oldest entries over the count or the size budget, never the newest', () => {
    const cache = new SizedLru<string, string>({ maxEntries: 3, maxSize: 10 });
    cache.set('a', 'a', 4);
    cache.set('b', 'b', 4);
    expect(cache.count).toBe(2);
    cache.set('c', 'c', 4);
    expect([cache.peek('a'), cache.peek('b'), cache.peek('c')]).toEqual([undefined, 'b', 'c']);
    expect(cache.totalSize).toBe(8);
    cache.set('huge', 'h', 50);
    expect([cache.peek('b'), cache.peek('c'), cache.peek('huge')]).toEqual([undefined, undefined, 'h']);
    expect(cache.totalSize).toBe(50);
  });

  it('get refreshes an entry, peek does not; keep protects entries', () => {
    const cache = new SizedLru<string, string>({ maxEntries: 2, maxSize: 100 });
    cache.set('a', 'a', 1);
    cache.set('b', 'b', 1);
    expect(cache.get('a')).toBe('a');
    cache.set('c', 'c', 1);
    expect([cache.peek('a'), cache.peek('b')]).toEqual(['a', undefined]);
    cache.set('d', 'd', 1, (value) => value === 'a');
    expect([cache.peek('a'), cache.peek('c'), cache.peek('d')]).toEqual(['a', undefined, 'd']);
    cache.set('a', 'a2', 5);
    expect(cache.totalSize).toBe(6);
    cache.clear();
    expect([cache.count, cache.totalSize]).toEqual([0, 0]);
  });
});
