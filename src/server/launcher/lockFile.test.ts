import { readFile, rm, writeFile } from 'node:fs/promises';
import { afterEach, describe, expect, it } from 'vitest';
import { SERVER_LOCK_FILE, serverLockFileSchema } from '@shared/http';
import { sampleTime, sampleToken, sampleUuid } from '@shared/samples';
import { makeTempHome } from '../http/testServer';
import { readServerLock, serverLockPath, writeServerLock } from './lockFile';

const homes: string[] = [];

async function tempHome(): Promise<string> {
  const home = await makeTempHome('wp21-lock-');
  homes.push(home);
  return home;
}

afterEach(async () => {
  for (const home of homes.splice(0)) await rm(home, { recursive: true, force: true });
});

function instance(n = 1) {
  return { serverInstanceId: sampleUuid(n), startedAt: sampleTime(), buildId: '0.0.0+abc' };
}

describe('server lock file (C.8, ADR-015)', () => {
  it('writes the lock atomically and reads it back', async () => {
    const home = await tempHome();
    const token = sampleToken(7);
    const handle = await writeServerLock({
      home,
      port: 4711,
      instance: instance(),
      launcherToken: token,
      pid: 1234,
    });
    expect(handle.file).toBe(serverLockPath(home));
    expect(serverLockPath(home).endsWith(SERVER_LOCK_FILE)).toBe(true);
    const raw: unknown = JSON.parse(await readFile(handle.file, 'utf8'));
    expect(serverLockFileSchema.parse(raw)).toEqual(handle.lock);
    expect(handle.lock).toMatchObject({ schemaVersion: 1, pid: 1234, port: 4711, launcherToken: token });
    expect(await readServerLock(home)).toEqual({ kind: 'ok', lock: handle.lock });
  });

  it('defaults the pid to this process', async () => {
    const home = await tempHome();
    const handle = await writeServerLock({
      home,
      port: 1,
      instance: instance(),
      launcherToken: sampleToken(),
    });
    expect(handle.lock.pid).toBe(process.pid);
  });

  it('refuses invalid values before writing', async () => {
    const home = await tempHome();
    await expect(
      writeServerLock({ home, port: 0, instance: instance(), launcherToken: sampleToken() }),
    ).rejects.toThrow();
    expect(await readServerLock(home)).toEqual({ kind: 'missing' });
  });

  it.each([
    ['json', '{not json'],
    ['schema', JSON.stringify({ schemaVersion: 2, pid: 1 })],
  ] as const)('reports an invalid lock file (%s)', async (reason, text) => {
    const home = await tempHome();
    await writeFile(serverLockPath(home), text);
    expect(await readServerLock(home)).toEqual({ kind: 'invalid', reason });
  });

  it('treats a read error other than ENOENT as unreadable', async () => {
    const read = () => Promise.reject(Object.assign(new Error('denied'), { code: 'EISDIR' }));
    expect(await readServerLock('C:\\nowhere', read)).toEqual({ kind: 'invalid', reason: 'unreadable' });
  });

  it('release removes only its own lock and is idempotent', async () => {
    const home = await tempHome();
    const first = await writeServerLock({
      home,
      port: 4711,
      instance: instance(),
      launcherToken: sampleToken(),
    });
    // A second server replaced the file: the first one must not delete it.
    const second = await writeServerLock({
      home,
      port: 4712,
      instance: instance(2),
      launcherToken: sampleToken(),
    });
    expect(await first.release()).toBe(false);
    expect(await readServerLock(home)).toEqual({ kind: 'ok', lock: second.lock });
    expect(await second.release()).toBe(true);
    expect(await readServerLock(home)).toEqual({ kind: 'missing' });
    expect(await second.release()).toBe(false);
  });
});
