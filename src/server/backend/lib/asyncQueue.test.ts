import { describe, expect, it } from 'vitest';
import { AsyncQueue } from './asyncQueue';

async function collect<T>(queue: AsyncQueue<T>): Promise<T[]> {
  const out: T[] = [];
  for await (const value of queue) out.push(value);
  return out;
}

describe('AsyncQueue', () => {
  it('delivers buffered values in order, then done after end()', async () => {
    const queue = new AsyncQueue<number>();
    queue.push(1);
    queue.push(2);
    expect(queue.size).toBe(2);
    queue.end();
    expect(queue.ended).toBe(true);
    await expect(collect(queue)).resolves.toEqual([1, 2]);
    expect(queue.size).toBe(0);
  });

  it('resolves a pending next() when a value arrives', async () => {
    const queue = new AsyncQueue<string>();
    const it = queue[Symbol.asyncIterator]();
    const pending = it.next();
    queue.push('a');
    await expect(pending).resolves.toEqual({ value: 'a', done: false });
    const done = it.next();
    queue.end();
    await expect(done).resolves.toEqual({ value: undefined, done: true });
  });

  it('keeps undefined values (boxed buffer)', async () => {
    const queue = new AsyncQueue<undefined | number>();
    queue.push(undefined);
    queue.push(3);
    queue.end();
    await expect(collect(queue)).resolves.toEqual([undefined, 3]);
  });

  it('push after end throws; end is idempotent', () => {
    const queue = new AsyncQueue<number>();
    queue.end();
    queue.end(new Error('ignored'));
    expect(() => {
      queue.push(1);
    }).toThrow(/after end/);
  });

  it('end(error): buffered values first, then the error once, then done', async () => {
    const queue = new AsyncQueue<number>();
    queue.push(1);
    queue.end(new Error('boom'));
    const it = queue[Symbol.asyncIterator]();
    await expect(it.next()).resolves.toEqual({ value: 1, done: false });
    await expect(it.next()).rejects.toThrow('boom');
    await expect(it.next()).resolves.toEqual({ value: undefined, done: true });
  });

  it('end(error) rejects a pending next()', async () => {
    const queue = new AsyncQueue<number>();
    const it = queue[Symbol.asyncIterator]();
    const pending = it.next();
    queue.end(new Error('crashed'));
    await expect(pending).rejects.toThrow('crashed');
  });

  it('allows only one consumer', () => {
    const queue = new AsyncQueue<number>();
    queue[Symbol.asyncIterator]();
    expect(() => queue[Symbol.asyncIterator]()).toThrow(/single consumer/);
  });

  it('break in for-await drops the buffer and ignores later pushes', async () => {
    const queue = new AsyncQueue<number>();
    queue.push(1);
    queue.push(2);
    for await (const value of queue) {
      expect(value).toBe(1);
      break;
    }
    expect(queue.size).toBe(0);
    queue.push(3);
    expect(queue.size).toBe(0);
    queue.end();
  });
});
