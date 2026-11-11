import { describe, expect, it } from 'vitest';
import { FsTimeoutError, createFsCallGuard } from './fsTimeout';

function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void; reject: (error: Error) => void } {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

describe('createFsCallGuard (ADR-141: 3 s per fs call, fail fast on a hanging drive)', () => {
  it('passes values and errors through', async () => {
    const guard = createFsCallGuard({ timeoutMs: 1000 });
    await expect(guard.run('C:\\x', () => Promise.resolve(42))).resolves.toBe(42);
    const enoent = Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
    await expect(guard.run('C:\\x', () => Promise.reject(enoent))).rejects.toBe(enoent);
    await expect(
      guard.run('C:\\x', () => {
        throw new Error('sync');
      }),
    ).rejects.toThrow('sync');
    expect(guard.hangingDrives()).toEqual([]);
  });

  it('a call that does not answer rejects with FsTimeoutError; its drive then fails fast until it ends', async () => {
    const guard = createFsCallGuard({ timeoutMs: 20 });
    const hanging = deferred<string>();
    const first = guard.run('Z:\\share\\a.txt', () => hanging.promise);
    await expect(first).rejects.toBeInstanceOf(FsTimeoutError);
    await expect(first).rejects.toMatchObject({ code: 'ETIMEDOUT', drive: 'z:' });
    expect(guard.hangingDrives()).toEqual(['z:']);

    // Same drive (any case/separator): rejected at once, the call is never made.
    let called = false;
    await expect(
      guard.run('z:/other', () => {
        called = true;
        return Promise.resolve('x');
      }),
    ).rejects.toBeInstanceOf(FsTimeoutError);
    expect(called).toBe(false);
    // Another drive is not affected.
    await expect(guard.run('C:\\ok', () => Promise.resolve('ok'))).resolves.toBe('ok');

    // The hanging call ends late: the drive is usable again.
    hanging.resolve('late');
    await hanging.promise;
    await Promise.resolve();
    expect(guard.hangingDrives()).toEqual([]);
    await expect(guard.run('Z:\\share\\b.txt', () => Promise.resolve('again'))).resolves.toBe('again');
  });

  it('a late failure of a timed-out call also releases the drive', async () => {
    const guard = createFsCallGuard({ timeoutMs: 10 });
    const hanging = deferred<string>();
    await expect(guard.run('Y:\\x', () => hanging.promise)).rejects.toBeInstanceOf(FsTimeoutError);
    hanging.reject(new Error('EIO'));
    await hanging.promise.catch(() => undefined);
    await Promise.resolve();
    expect(guard.hangingDrives()).toEqual([]);
  });
});
