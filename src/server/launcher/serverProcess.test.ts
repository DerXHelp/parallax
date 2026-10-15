import { mkdir, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:net';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { makeTempHome } from '../http/testServer';
import { probePort, readServerOutput, serverOutLogPath } from './serverProcess';

const homes: string[] = [];

afterEach(async () => {
  for (const home of homes.splice(0)) await rm(home, { recursive: true, force: true });
});

describe('server process helpers', () => {
  it('probePort: free, then in use while another socket listens', async () => {
    const blocker = createServer((socket) => socket.destroy());
    await new Promise<void>((resolve) => blocker.listen(0, '127.0.0.1', resolve));
    const address = blocker.address();
    if (address === null || typeof address === 'string') throw new Error('not listening');
    try {
      expect(await probePort(address.port)).toBe('in_use');
    } finally {
      await new Promise<void>((resolve) => {
        blocker.close(() => {
          resolve();
        });
      });
    }
    expect(await probePort(address.port)).toBe('free');
  });

  it('readServerOutput returns only the output after the offset (bounded)', async () => {
    const home = await makeTempHome('wp21-out-');
    homes.push(home);
    const file = serverOutLogPath(home);
    expect(file).toBe(path.join(home, 'logs', 'server.out.log'));
    expect(await readServerOutput(home, 0)).toBe('');
    await mkdir(path.dirname(file), { recursive: true });
    await writeFile(file, 'old run\nnew run: EADDRINUSE\n');
    expect(await readServerOutput(home, 'old run\n'.length)).toBe('new run: EADDRINUSE\n');
    expect(await readServerOutput(home, 0, 8)).toBe('DRINUSE\n');
    expect(await readServerOutput(home, 1_000)).toBe('');
  });
});
