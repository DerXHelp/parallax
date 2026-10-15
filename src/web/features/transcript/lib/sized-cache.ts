/**
 * LRU cache bounded by the number of entries AND by their total size (chars) – R2W-06/R2W-18:
 * the caches of the transcript (highlighted code, jsdiff rows, loaded full texts) must not grow
 * with the size of what they hold. `get` makes an entry the newest, `peek` does not (safe in
 * render / `useSyncExternalStore` snapshots). The entry just written is never evicted, even when
 * it alone is over budget; `keep` protects further entries (e.g. full texts still loading).
 */
export class SizedLru<K, V> {
  private readonly entries = new Map<K, { value: V; size: number }>();
  private readonly maxEntries: number;
  private readonly maxSize: number;
  private total = 0;

  constructor(options: { maxEntries: number; maxSize: number }) {
    this.maxEntries = options.maxEntries;
    this.maxSize = options.maxSize;
  }

  /** Number of entries. */
  get count(): number {
    return this.entries.size;
  }

  /** Sum of the sizes of all entries. */
  get totalSize(): number {
    return this.total;
  }

  get(key: K): V | undefined {
    const entry = this.entries.get(key);
    if (entry === undefined) return undefined;
    this.entries.delete(key);
    this.entries.set(key, entry);
    return entry.value;
  }

  peek(key: K): V | undefined {
    return this.entries.get(key)?.value;
  }

  set(key: K, value: V, size: number, keep?: (value: V) => boolean): void {
    const previous = this.entries.get(key);
    if (previous !== undefined) {
      this.total -= previous.size;
      this.entries.delete(key);
    }
    const entrySize = Math.max(0, size);
    this.entries.set(key, { value, size: entrySize });
    this.total += entrySize;
    for (const [candidate, entry] of this.entries) {
      if (this.entries.size <= this.maxEntries && this.total <= this.maxSize) break;
      if (candidate === key || keep?.(entry.value) === true) continue;
      this.entries.delete(candidate);
      this.total -= entry.size;
    }
  }

  clear(): void {
    this.entries.clear();
    this.total = 0;
  }
}
