import { once } from 'node:events';
import { readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import { SERVER_LOCK_FILE, serverLockFileSchema } from '@shared/http';
import { sampleTime, sampleToken, sampleUuid } from '@shared/samples';
import { makeTempHome } from '../http/testServer';
import { DEFAULT_RETRY_DELAYS_MS, nodeFsOps, type FsOps } from '../lib/fs';
import { spawnHidden } from '../lib/process';
import { LOCK_RETRY_DELAYS_MS, readServerLock, serverLockPath, writeServerLock } from './lockFile';

const windowsOnly = process.platform === 'win32' ? it : it.skip;

/** node -e: reads argv[1] every 20 ms for argv[2] ms, prints {reads, ok, missing, busy, torn}. */
const POLLING_READER = `
const fs = require('node:fs');
const [file, ms] = process.argv.slice(1);
const stats = { reads: 0, ok: 0, missing: 0, busy: 0, torn: 0 };
const end = Date.now() + Number(ms);
(function loop() {
  if (Date.now() > end) { process.stdout.write(JSON.stringify(stats)); return; }
  stats.reads += 1;
  try { JSON.parse(fs.readFileSync(file, 'utf8')); stats.ok += 1; }
  catch (e) {
    if (e.code === 'ENOENT') stats.missing += 1;
    else if (e.code === 'EPERM' || e.code === 'EBUSY' || e.code === 'EACCES') stats.busy += 1;
    else stats.torn += 1;
  }
  setTimeout(loop, 20);
})();
`;

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

  it('retries a rename refused while another process reads the file (EPERM, R2-01)', async () => {
    const home = await tempHome();
    let refusals = 3;
    const fs: FsOps = {
      ...nodeFsOps,
      rename: (from, to) => {
        if (refusals > 0) {
          refusals -= 1;
          return Promise.reject(
            Object.assign(new Error('EPERM: operation not permitted, rename'), { code: 'EPERM' }),
          );
        }
        return nodeFsOps.rename(from, to);
      },
    };
    const handle = await writeServerLock({
      home,
      port: 4711,
      instance: instance(),
      launcherToken: sampleToken(),
      fs,
    });
    expect(refusals).toBe(0);
    expect(await readServerLock(home)).toEqual({ kind: 'ok', lock: handle.lock });
    expect(LOCK_RETRY_DELAYS_MS.length).toBeGreaterThan(DEFAULT_RETRY_DELAYS_MS.length);
  });

  it('gives up after the lock retry schedule and leaves no temp file behind', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    try {
      const home = await tempHome();
      let attempts = 0;
      const fs: FsOps = {
        ...nodeFsOps,
        rename: () => {
          attempts += 1;
          return Promise.reject(Object.assign(new Error('EBUSY'), { code: 'EBUSY' }));
        },
      };
      const write = writeServerLock({
        home,
        port: 4711,
        instance: instance(),
        launcherToken: sampleToken(),
        fs,
      });
      const state: { result: string | null } = { result: null };
      void write.then(
        () => {
          state.result = 'written';
        },
        (error: unknown) => {
          state.result = error instanceof Error ? error.message : 'error';
        },
      );
      // The temp file is written with real I/O; only the retry delays run on the fake clock.
      for (let i = 0; i < 5_000 && state.result === null; i += 1) {
        await vi.advanceTimersByTimeAsync(100);
        await new Promise((resolve) => setImmediate(resolve));
      }
      expect(state.result).toBe('EBUSY');
      expect(attempts).toBe(LOCK_RETRY_DELAYS_MS.length + 1);
      expect((await readdir(home)).filter((name) => name.endsWith('.tmp'))).toEqual([]);
    } finally {
      vi.useRealTimers();
    }
  });

  it('a read during a replace (EPERM) is retried; the reader never throws', async () => {
    const home = await tempHome();
    const handle = await writeServerLock({
      home,
      port: 4711,
      instance: instance(),
      launcherToken: sampleToken(),
    });
    let refusals = 2;
    const read = (file: string) => {
      if (refusals > 0) {
        refusals -= 1;
        return Promise.reject(Object.assign(new Error('EPERM'), { code: 'EPERM' }));
      }
      return readFile(file, 'utf8');
    };
    expect(await readServerLock(home, read)).toEqual({ kind: 'ok', lock: handle.lock });
    const always = () => Promise.reject(Object.assign(new Error('EBUSY'), { code: 'EBUSY' }));
    expect(await readServerLock(home, always)).toEqual({ kind: 'invalid', reason: 'unreadable' });
  });

  windowsOnly(
    'stays consistent while another process polls the file (R2-01)',
    async () => {
      const home = await tempHome();
      await writeServerLock({ home, port: 4711, instance: instance(), launcherToken: sampleToken() });
      // A reader 7× faster than the launcher (150 ms): counts readable/missing/busy/torn reads.
      const reader = spawnHidden(process.execPath, ['-e', POLLING_READER, serverLockPath(home), '3000'], {
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      let out = '';
      reader.stdout?.setEncoding('utf8');
      reader.stdout?.on('data', (chunk: string) => {
        out += chunk;
      });
      const reading = { done: false };
      const closed = once(reader, 'close').then(() => {
        reading.done = true;
      });
      // Replace the file over and over until the reader ends (every write must succeed).
      let writes = 0;
      try {
        while (!reading.done || writes < 20) {
          writes += 1;
          const handle = await writeServerLock({
            home,
            port: 1000 + writes,
            instance: instance(writes),
            launcherToken: sampleToken(writes),
          });
          expect(await readServerLock(home)).toEqual({ kind: 'ok', lock: handle.lock });
          await new Promise((resolve) => setImmediate(resolve));
        }
      } finally {
        await closed;
      }
      const stats = z
        .object({ reads: z.number(), ok: z.number(), torn: z.number() })
        .parse(JSON.parse(out) as unknown);
      expect(stats.ok).toBeGreaterThan(0);
      expect(stats.torn).toBe(0);
      expect((await readdir(home)).filter((name) => name.endsWith('.tmp'))).toEqual([]);
    },
    60_000,
  );

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
