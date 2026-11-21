import { describe, expect, it } from 'vitest';
import { POSIX_PATHS, WIN32_PATHS } from '@shared/paths';
import {
  FsTimeoutError,
  MOUNTS_CACHE_MS,
  createFsCallGuard,
  createMountReader,
  deepestMount,
  driveOf,
  parseMountPoints,
  posixMountGroup,
} from './fsTimeout';

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
    const guard = createFsCallGuard({ timeoutMs: 1000, rules: WIN32_PATHS });
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
    const guard = createFsCallGuard({ timeoutMs: 20, rules: WIN32_PATHS });
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
    const guard = createFsCallGuard({ timeoutMs: 10, rules: WIN32_PATHS });
    const hanging = deferred<string>();
    await expect(guard.run('Y:\\x', () => hanging.promise)).rejects.toBeInstanceOf(FsTimeoutError);
    hanging.reject(new Error('EIO'));
    await hanging.promise.catch(() => undefined);
    await Promise.resolve();
    expect(guard.hangingDrives()).toEqual([]);
  });
});

describe('POSIX: one group per mount, never the first two characters (WP-103)', () => {
  it.each([
    ['/home/u/repo/a.ts', '/'],
    ['/', '/'],
    ['/mnt', '/'],
    ['/mnt/nas/projects/x', '/mnt/nas'],
    ['/mnt/other', '/mnt/other'],
    ['/net/server/share/x', '/net/server'],
    ['/media/u', '/media/u'],
    ['/media/u/USB-STICK/docs', '/media/u/USB-STICK'],
    [
      '/run/user/1000/gvfs/smb-share:server=nas,share=x/a',
      '/run/user/1000/gvfs/smb-share:server=nas,share=x',
    ],
    ['/run/user/1000/doc/x', '/run/user/1000'],
    ['//mnt//nas///x', '/mnt/nas'],
  ])('%s → %s', (path, group) => {
    expect(posixMountGroup(path)).toBe(group);
    expect(driveOf(path, POSIX_PATHS)).toBe(group);
  });

  it('a hanging share fails fast; the rest of the machine (and other shares) is not affected', async () => {
    const guard = createFsCallGuard({ timeoutMs: 10, rules: POSIX_PATHS });
    const hanging = deferred<string>();
    await expect(guard.run('/mnt/nas/a', () => hanging.promise)).rejects.toMatchObject({ drive: '/mnt/nas' });
    expect(guard.hangingDrives()).toEqual(['/mnt/nas']);
    await expect(guard.run('/mnt/nas/b', () => Promise.resolve(1))).rejects.toBeInstanceOf(FsTimeoutError);
    // "/m" would be shared by /mnt and /media – the groups are not.
    await expect(guard.run('/media/u/stick/x', () => Promise.resolve(2))).resolves.toBe(2);
    await expect(guard.run('/mnt/other/x', () => Promise.resolve(3))).resolves.toBe(3);
    await expect(guard.run('/home/u/x', () => Promise.resolve(4))).resolves.toBe(4);
    hanging.resolve('late');
    await hanging.promise;
    await Promise.resolve();
    expect(guard.hangingDrives()).toEqual([]);
  });
});

describe('Linux: the real mount points refine the groups (follow-up WP-109)', () => {
  const MOUNTINFO = [
    '22 1 8:2 / / rw,relatime shared:1 - ext4 /dev/sda2 rw',
    '61 22 0:52 / /home/u/remote rw,nosuid,nodev - fuse.sshfs u@nas:/srv rw',
    '62 22 0:53 / /home/u/my\\040drive rw - fuse.rclone gdrive: rw',
    '70 22 0:60 / /run/user/1000/gvfs rw - fuse.gvfsd-fuse gvfsd-fuse rw',
    '',
    'broken line',
  ].join('\n');

  it('parses the mount points (octal escapes) and finds the deepest one of a path', () => {
    const mounts = parseMountPoints(MOUNTINFO);
    expect(mounts).toEqual(['/', '/home/u/remote', '/home/u/my drive', '/run/user/1000/gvfs']);
    expect(deepestMount('/home/u/remote/a/b', mounts)).toBe('/home/u/remote');
    expect(deepestMount('/home/u/remote', mounts)).toBe('/home/u/remote');
    // A name that only starts like a mount point is not inside it.
    expect(deepestMount('/home/u/remote2/x', mounts)).toBe('/');
    expect(deepestMount('/home/u/my drive/x', mounts)).toBe('/home/u/my drive');
  });

  it.each([
    ['/home/u/remote/a.ts', '/home/u/remote'],
    ['/home/u/repo/a.ts', '/'],
    // One gvfs mount holds every share: the guess per share is finer.
    [
      '/run/user/1000/gvfs/smb-share:server=nas,share=x/a',
      '/run/user/1000/gvfs/smb-share:server=nas,share=x',
    ],
    ['/mnt/nas/x', '/mnt/nas'],
  ])('%s → %s', (path, group) => {
    expect(driveOf(path, POSIX_PATHS, parseMountPoints(MOUNTINFO))).toBe(group);
  });

  it('a hanging FUSE mount in the home folder does not hold up the projects next to it', async () => {
    const guard = createFsCallGuard({
      timeoutMs: 10,
      rules: POSIX_PATHS,
      mounts: () => parseMountPoints(MOUNTINFO),
    });
    const hanging = deferred<string>();
    await expect(guard.run('/home/u/remote/a', () => hanging.promise)).rejects.toMatchObject({
      drive: '/home/u/remote',
    });
    await expect(guard.run('/home/u/remote/b', () => Promise.resolve(1))).rejects.toBeInstanceOf(
      FsTimeoutError,
    );
    await expect(guard.run('/home/u/repo/x', () => Promise.resolve(2))).resolves.toBe(2);
    hanging.resolve('late');
    await hanging.promise;
  });

  it('the reader: Linux only, cached for a while, null when unreadable', () => {
    expect(createMountReader({ platform: 'win32', read: () => MOUNTINFO })()).toBeNull();
    let now = 0;
    let reads = 0;
    let text = MOUNTINFO;
    const reader = createMountReader({
      platform: 'linux',
      now: () => now,
      read: () => {
        reads += 1;
        return text;
      },
    });
    expect(reader()).toHaveLength(4);
    text = '22 1 8:2 / / rw - ext4 /dev/sda2 rw';
    now = MOUNTS_CACHE_MS - 1;
    expect(reader()).toHaveLength(4);
    now = MOUNTS_CACHE_MS;
    expect(reader()).toEqual(['/']);
    expect(reads).toBe(2);
    const broken = createMountReader({
      platform: 'linux',
      read: () => {
        throw new Error('EACCES');
      },
    });
    expect(broken()).toBeNull();
  });
});
