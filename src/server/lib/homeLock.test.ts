import { mkdir, rm } from 'node:fs/promises';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { makeTempHome } from '../http/testServer';
import {
  acquireDirectoryLock,
  acquireHomeLock,
  directoryLockPipeName,
  homeLockKey,
  homeLockPipeName,
  type HomeLock,
} from './homeLock';
import { isProcessAlive, killProcessTree, spawnHidden } from './process';

const windowsOnly = process.platform === 'win32' ? it : it.skip;

/** Real processes: a node start takes seconds under parallel load (docs/wp/FLAKES.md). */
const PROCESS_TEST_TIMEOUT_MS = 60_000;
const DEADLINE_MS = 20_000;

/** node -e: listens on the pipe argv[1]; prints `listening` or `error:<code>`. */
const PIPE_HOLDER = `
const net = require('node:net');
const server = net.createServer((socket) => socket.destroy());
server.on('error', (error) => { process.stdout.write('error:' + error.code + '\\n'); process.exit(0); });
server.listen(process.argv[1], () => process.stdout.write('listening\\n'));
setTimeout(() => process.exit(0), 60000).unref();
`;

const homes: string[] = [];
const locks: HomeLock[] = [];
const children = new Set<number>();

afterEach(async () => {
  for (const lock of locks.splice(0)) await lock.release();
  for (const pid of children) if (isProcessAlive(pid)) await killProcessTree(pid).catch(() => undefined);
  children.clear();
  for (const home of homes.splice(0)) await rm(home, { recursive: true, force: true });
});

async function tempHome(): Promise<string> {
  const home = await makeTempHome('r2-homelock-');
  homes.push(home);
  return home;
}

async function acquired(home: string): Promise<HomeLock> {
  const result = await acquireHomeLock(home);
  if (result.kind !== 'acquired') throw new Error(`home lock busy: ${result.pipe}`);
  locks.push(result.lock);
  return result.lock;
}

/** Starts PIPE_HOLDER and resolves with its first output line. */
function holder(pipe: string): Promise<{ pid: number; line: string }> {
  const child = spawnHidden(process.execPath, ['-e', PIPE_HOLDER, pipe], {
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const pid = child.pid;
  if (pid === undefined) throw new Error('no pid');
  children.add(pid);
  return new Promise((resolve, reject) => {
    let out = '';
    child.stdout?.setEncoding('utf8');
    child.stdout?.on('data', (chunk: string) => {
      out += chunk;
      const line = out.split('\n')[0];
      if (out.includes('\n') && line !== undefined) resolve({ pid, line: line.trim() });
    });
    child.once('error', reject);
  });
}

async function eventually(check: () => Promise<boolean>): Promise<boolean> {
  const end = Date.now() + DEADLINE_MS;
  while (Date.now() < end) {
    if (await check()) return true;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  return check();
}

describe('home lock (R2-05)', () => {
  it('pipe names: stable per key, different per home', () => {
    const a = homeLockPipeName('c:\\users\\u\\appdata\\local\\parallax');
    expect(a).toMatch(/^\\\\\.\\pipe\\parallax-home-[0-9a-f]{16}$/);
    expect(homeLockPipeName('c:\\users\\u\\appdata\\local\\parallax')).toBe(a);
    expect(homeLockPipeName('d:\\px-data')).not.toBe(a);
  });

  it('one key for every spelling of the same directory', async () => {
    const home = await tempHome();
    const key = await homeLockKey(home);
    expect(await homeLockKey(home.toUpperCase())).toBe(key);
    expect(await homeLockKey(`${home}\\`)).toBe(key);
    expect(await homeLockKey(home.replaceAll('\\', '/'))).toBe(key);
    expect(await homeLockKey(path.join(home, 'sub', '..'))).toBe(key);
  });

  it('refuses unsafe paths; without Windows there is no exclusivity', async () => {
    await expect(acquireHomeLock('\\\\server\\share\\px')).rejects.toBeInstanceOf(TypeError);
    const result = await acquireHomeLock('C:\\px', { platform: 'linux' });
    expect(result).toMatchObject({ kind: 'acquired', lock: { exclusive: false, pipe: null } });
  });

  windowsOnly('a second acquire of the same home is busy – in any spelling – until released', async () => {
    const home = await tempHome();
    const other = await tempHome();
    const lock = await acquired(home);
    expect(lock.exclusive).toBe(true);
    for (const spelling of [home, home.toUpperCase(), `${home}\\`, home.replaceAll('\\', '/')]) {
      expect(await acquireHomeLock(spelling)).toEqual({ kind: 'busy', pipe: lock.pipe, reason: 'in_use' });
    }
    await acquired(other);
    await lock.release();
    await lock.release();
    expect((await acquired(home)).pipe).toBe(lock.pipe);
  });

  windowsOnly(
    'directory locks (R3-04): one pipe per kind and directory, independent of the home lock',
    async () => {
      const home = await tempHome();
      expect(directoryLockPipeName('launch', 'c:\\x')).toMatch(
        /^\\\\\.\\pipe\\parallax-launch-[0-9a-f]{16}$/,
      );
      expect(directoryLockPipeName('home', 'c:\\x')).toBe(homeLockPipeName('c:\\x'));
      const homeLock = await acquired(home);
      const launch = await acquireDirectoryLock('launch', home);
      if (launch.kind !== 'acquired') throw new Error('launch lock busy');
      locks.push(launch.lock);
      expect(launch.lock.pipe).not.toBe(homeLock.pipe);
      expect(await acquireDirectoryLock('launch', home.toUpperCase())).toEqual({
        kind: 'busy',
        pipe: launch.lock.pipe,
        reason: 'in_use',
      });
      const build = await acquireDirectoryLock('build', home);
      expect(build.kind).toBe('acquired');
      if (build.kind === 'acquired') locks.push(build.lock);
      await launch.lock.release();
      const again = await acquireDirectoryLock('launch', home);
      expect(again.kind).toBe('acquired');
      if (again.kind === 'acquired') locks.push(again.lock);
    },
  );

  windowsOnly('creates a missing home so that its real path is the key', async () => {
    const base = await tempHome();
    const home = path.join(base, 'new', 'home');
    const lock = await acquired(home);
    await mkdir(home, { recursive: true });
    expect(lock.pipe).toBe(homeLockPipeName(await homeLockKey(home)));
  });

  windowsOnly(
    'two processes: the second one gets EADDRINUSE / busy; the lock ends with the holding process',
    async () => {
      const home = await tempHome();
      const pipe = homeLockPipeName(await homeLockKey(home));
      // Another process holds the home → this one is busy.
      const first = await holder(pipe);
      expect(first.line).toBe('listening');
      expect(await acquireHomeLock(home)).toEqual({ kind: 'busy', pipe, reason: 'in_use' });
      // The holder dies (crash, taskkill) → no stale state: the lock is free again.
      await killProcessTree(first.pid);
      expect(
        await eventually(async () => {
          const result = await acquireHomeLock(home);
          if (result.kind === 'acquired') locks.push(result.lock);
          return result.kind === 'acquired';
        }),
      ).toBe(true);
      // Now this process holds it → another process cannot listen on the pipe.
      const second = await holder(pipe);
      expect(second.line).toBe('error:EADDRINUSE');
    },
    PROCESS_TEST_TIMEOUT_MS,
  );
});
