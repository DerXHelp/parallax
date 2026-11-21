import type { SpawnOptions } from 'node:child_process';
import { describe, expect, it } from 'vitest';
import type { GuiChild, GuiSpawnFn, RunFileFn, RunFileResult } from '../lib/process';
import { posixFileUri, showInFileManager, xdgOpen } from './desktop';

const tool = (name: string) => `/usr/bin/${name}`;

function fakeSpawn(error?: Error) {
  const calls: { file: string; args: readonly string[]; options: SpawnOptions }[] = [];
  const spawn: GuiSpawnFn = (file, args, options) => {
    calls.push({ file, args, options });
    const listeners = new Map<string, (error?: Error) => void>();
    const child: GuiChild = {
      once: (event, listener) => {
        listeners.set(event, listener);
        return child;
      },
      unref: () => undefined,
    };
    queueMicrotask(() => {
      if (error === undefined) listeners.get('spawn')?.();
      else listeners.get('error')?.(error);
    });
    return child;
  };
  return { spawn, calls };
}

function fakeRun(result: Partial<RunFileResult> | Error = {}) {
  const calls: { file: string; args: readonly string[] }[] = [];
  const run: RunFileFn = (file, args) => {
    calls.push({ file, args });
    if (result instanceof Error) return Promise.reject(result);
    return Promise.resolve({
      exitCode: 0,
      signal: null,
      stdout: '()\n',
      stderr: '',
      timedOut: false,
      ...result,
    });
  };
  return { run, calls };
}

describe('Linux desktop programs (WP-106, WP-100 §5.6)', () => {
  it('posixFileUri: percent-encoded segments, the GVariant quote too', () => {
    expect(posixFileUri('/home/demo/my work/a.txt')).toBe('file:///home/demo/my%20work/a.txt');
    expect(posixFileUri("/home/demo/it's/ä#1.md")).toBe('file:///home/demo/it%27s/%C3%A4%231.md');
  });

  it('xdgOpen: absolute xdg-open, one argument, detached, no shell, GUI environment', async () => {
    const { spawn, calls } = fakeSpawn();
    await xdgOpen('/home/demo/work/report.pdf', {
      tool,
      spawn,
      env: { PATH: '/usr/bin', DISPLAY: ':0', CLAUDECODE: '1', PARALLAX_ENTRY_ID: 'en_x' },
    });
    expect(calls).toHaveLength(1);
    const call = calls[0];
    expect(call?.file).toBe('/usr/bin/xdg-open');
    expect(call?.args).toEqual(['/home/demo/work/report.pdf']);
    expect(call?.options).toMatchObject({
      cwd: '/home/demo/work',
      shell: false,
      detached: true,
      stdio: 'ignore',
    });
    expect(call?.options.env).toEqual({ PATH: '/usr/bin', DISPLAY: ':0' });
    // A link: the working folder is the root.
    await xdgOpen('https://example.invalid/docs', { tool, spawn, env: {} });
    expect(calls[1]?.options.cwd).toBe('/');
  });

  it('xdgOpen: never an option-like or empty target; start errors → OPEN_FAILED {reason}', async () => {
    const { spawn, calls } = fakeSpawn();
    for (const target of ['', '--help']) {
      await expect(xdgOpen(target, { tool, spawn, env: {} })).rejects.toMatchObject({
        error: { code: 'OPEN_FAILED', params: { reason: 'path' } },
      });
    }
    expect(calls).toEqual([]);
    await expect(
      xdgOpen('/home/demo/a.txt', { tool: () => 'xdg-open', spawn, env: {} }),
    ).rejects.toMatchObject({
      error: { params: { reason: 'path' } },
    });
    const failing = fakeSpawn(Object.assign(new Error('spawn ENOENT'), { code: 'ENOENT' }));
    await expect(xdgOpen('/home/demo/a.txt', { tool, spawn: failing.spawn, env: {} })).rejects.toMatchObject({
      error: { code: 'OPEN_FAILED', params: { reason: 'ENOENT' } },
    });
  });

  it('showInFileManager: FileManager1 ShowItems (file) / ShowFolders (folder) over gdbus', async () => {
    const { run, calls } = fakeRun();
    const { spawn, calls: spawned } = fakeSpawn();
    await showInFileManager('/home/demo/my work/a.txt', false, { tool, run, spawn, env: {} });
    await showInFileManager('/home/demo/my work', true, { tool, run, spawn, env: {} });
    expect(calls).toEqual([
      {
        file: '/usr/bin/gdbus',
        args: [
          'call',
          '--session',
          '--dest',
          'org.freedesktop.FileManager1',
          '--object-path',
          '/org/freedesktop/FileManager1',
          '--method',
          'org.freedesktop.FileManager1.ShowItems',
          "['file:///home/demo/my%20work/a.txt']",
          "''",
        ],
      },
      expect.objectContaining({
        args: expect.arrayContaining([
          'org.freedesktop.FileManager1.ShowFolders',
          "['file:///home/demo/my%20work']",
        ]) as unknown,
      }),
    ]);
    expect(spawned).toEqual([]);
  });

  it('showInFileManager: no file manager on the bus → xdg-open on the folder; unsafe paths refused', async () => {
    const { spawn, calls } = fakeSpawn();
    await showInFileManager('/home/demo/work/a.txt', false, {
      tool,
      run: fakeRun({ exitCode: 1 }).run,
      spawn,
      env: {},
    });
    await showInFileManager('/home/demo/work', true, {
      tool,
      run: fakeRun(new Error('spawn ENOENT')).run,
      spawn,
      env: {},
    });
    await showInFileManager('/home/demo/work', true, {
      tool,
      run: fakeRun({ timedOut: true, exitCode: null }).run,
      spawn,
      env: {},
    });
    expect(calls.map((c) => c.args)).toEqual([['/home/demo/work'], ['/home/demo/work'], ['/home/demo/work']]);
    const { run, calls: ran } = fakeRun();
    for (const target of ['work/a.txt', '/proc/self/environ']) {
      await expect(showInFileManager(target, false, { tool, run, spawn, env: {} })).rejects.toMatchObject({
        error: { code: 'OPEN_FAILED', params: { reason: 'path' } },
      });
    }
    expect(ran).toEqual([]);
  });
});
