import { describe, expect, it } from 'vitest';
import { createSerial } from './serial';

const realSetImmediate = setImmediate;
const macrotask = () =>
  new Promise<void>((resolve) => {
    realSetImmediate(resolve);
  });

describe('createSerial (lifecycle lock)', () => {
  it('runs tasks strictly one after another; a failure does not block the next', async () => {
    const serial = createSerial();
    const log: string[] = [];
    const gate = Promise.withResolvers<undefined>();
    const a = serial.run(async () => {
      log.push('a:start');
      await gate.promise;
      log.push('a:end');
      return 'a';
    });
    const b = serial.run(() => {
      log.push('b');
      return Promise.reject(new Error('b failed'));
    });
    const c = serial.run(() => {
      log.push('c');
      return Promise.resolve('c');
    });
    expect(serial.pending).toBe(3);
    await macrotask();
    expect(log).toEqual(['a:start']);
    gate.resolve(undefined);
    expect(await a).toBe('a');
    await expect(b).rejects.toThrow('b failed');
    expect(await c).toBe('c');
    await serial.idle();
    expect(log).toEqual(['a:start', 'a:end', 'b', 'c']);
    expect(serial.pending).toBe(0);
  });

  it('a task throwing synchronously becomes a rejection', async () => {
    const serial = createSerial();
    await expect(
      serial.run(() => {
        throw new Error('sync');
      }),
    ).rejects.toThrow('sync');
    expect(await serial.run(() => Promise.resolve(1))).toBe(1);
  });
});
