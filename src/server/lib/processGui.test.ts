/**
 * spawnGui / spawnExplorer (ADR-144) with fakes only: no test starts a real program.
 */
import type { SpawnOptions } from 'node:child_process';
import { describe, expect, it } from 'vitest';
import { CommandError } from '../sync/ports';
import { PE_SUBSYSTEM_WINDOWS_CUI, PE_SUBSYSTEM_WINDOWS_GUI } from './pe';
import {
  explorerArgument,
  guiEnvironment,
  spawnExplorer,
  spawnGui,
  type GuiChild,
  type GuiSpawnFn,
} from './process';

interface SpawnCall {
  file: string;
  args: readonly string[];
  options: SpawnOptions;
}

/** Fake spawn: records the call; the child emits `spawn` or the given error on the next tick. */
function fakeSpawn(
  outcome: 'spawn' | Error | 'throw' = 'spawn',
): GuiSpawnFn & { calls: SpawnCall[]; unrefs: () => number } {
  const state = { calls: [] as SpawnCall[], unrefs: 0 };
  const spawn = (file: string, args: readonly string[], options: SpawnOptions): GuiChild => {
    state.calls.push({ file, args, options });
    if (outcome === 'throw') throw Object.assign(new Error('EINVAL'), { code: 'EINVAL' });
    const child: GuiChild = {
      once: (event, listener) => {
        if (event === 'spawn' && outcome === 'spawn') {
          queueMicrotask(() => {
            listener();
          });
        }
        if (event === 'error' && outcome instanceof Error) {
          queueMicrotask(() => {
            listener(outcome);
          });
        }
        return child;
      },
      unref: () => {
        state.unrefs += 1;
      },
    };
    return child;
  };
  return Object.assign(spawn, { calls: state.calls, unrefs: () => state.unrefs });
}

/** A PE header with the given subsystem (see pe.test.ts). */
function peHead(subsystem: number): Buffer {
  const bytes = Buffer.alloc(512);
  bytes.write('MZ', 0, 'latin1');
  bytes.writeUInt32LE(0x80, 0x3c);
  bytes.write('PE\0\0', 0x80, 'latin1');
  bytes.writeUInt16LE(240, 0x80 + 20);
  bytes.writeUInt16LE(0x20b, 0x98);
  bytes.writeUInt16LE(subsystem, 0x98 + 68);
  return bytes;
}

const ENV = {
  Path: 'C:\\Windows\\System32',
  USERPROFILE: 'C:\\Users\\me',
  SystemRoot: 'C:\\Windows',
  CLAUDECODE: '1',
  CLAUDE_CODE_SESSION_ID: 'x',
  CLAUDE_AGENT_SDK_VERSION: '1',
  AI_AGENT: 'claude-code_2_agent',
  PARALLAX: '1',
  PARALLAX_HOME: 'C:\\home',
  PARALLAX_ENTRY_ID: 'en_x',
  npm_lifecycle_event: 'start',
  INIT_CWD: 'C:\\repo',
  GIT_TERMINAL_PROMPT: '0',
  NO_COLOR: '1',
  NODE_OPTIONS: '--max-old-space-size=4096',
};
const KEPT_ENV = {
  Path: 'C:\\Windows\\System32',
  USERPROFILE: 'C:\\Users\\me',
  SystemRoot: 'C:\\Windows',
  NODE_OPTIONS: '--max-old-space-size=4096',
};

async function openFailure(promise: Promise<unknown>): Promise<unknown> {
  try {
    await promise;
  } catch (error) {
    return error instanceof CommandError ? error.error : error;
  }
  return null;
}

const EDITOR = 'C:\\Program Files\\Notepad++\\notepad++.exe';

describe('guiEnvironment', () => {
  it('drops Claude session markers, every PARALLAX*, the pnpm run state and (inside a Claude session) tool-shell settings', () => {
    expect(guiEnvironment(ENV)).toEqual(KEPT_ENV);
    // Outside a Claude session the tool-shell names are the user's own.
    const { CLAUDECODE: _drop, ...noSession } = ENV;
    expect(guiEnvironment(noSession)).toMatchObject({ GIT_TERMINAL_PROMPT: '0', NO_COLOR: '1' });
  });
});

describe('spawnGui (ADR-144)', () => {
  const gui = (spawn: GuiSpawnFn, readHead = () => Promise.resolve(peHead(PE_SUBSYSTEM_WINDOWS_GUI))) => ({
    cwd: 'C:\\work\\project',
    env: ENV,
    spawn,
    readHead,
    platform: 'win32' as const,
  });

  it('starts a checked GUI .exe visible and detached with exactly these options', async () => {
    const spawn = fakeSpawn();
    await spawnGui(EDITOR, ['-n12', '-c3', 'C:\\work\\project\\a file.txt'], gui(spawn));
    expect(spawn.calls).toEqual([
      {
        file: EDITOR,
        args: ['-n12', '-c3', 'C:\\work\\project\\a file.txt'],
        options: {
          cwd: 'C:\\work\\project',
          env: KEPT_ENV,
          shell: false,
          windowsHide: false,
          detached: true,
          stdio: 'ignore',
        },
      },
    ]);
    expect(spawn.unrefs()).toBe(1);
  });

  it.each([
    ['a bare name', 'notepad++.exe'],
    ['a relative path', 'tools\\editor.exe'],
    ['a UNC path', '\\\\server\\share\\editor.exe'],
    ['a device path', '\\\\?\\C:\\editor.exe'],
    ['a .cmd file', 'C:\\tools\\editor.cmd'],
    ['a .bat file', 'C:\\tools\\editor.bat'],
  ])('OPEN_FAILED path for %s – nothing read, nothing started', async (_name, file) => {
    const spawn = fakeSpawn();
    let reads = 0;
    const readHead = () => {
      reads += 1;
      return Promise.resolve(peHead(PE_SUBSYSTEM_WINDOWS_GUI));
    };
    expect(await openFailure(spawnGui(file, [], gui(spawn, readHead)))).toEqual({
      code: 'OPEN_FAILED',
      params: { reason: 'path' },
    });
    expect(reads).toBe(0);
    expect(spawn.calls).toEqual([]);
  });

  it.each([
    'C:\\Windows\\System32\\cmd.exe',
    'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\POWERSHELL.EXE',
    'C:\\Windows\\explorer.exe',
    'C:\\x\\MsHta.exe',
    'C:\\x\\rundll32.exe',
  ])('OPEN_FAILED blocked for %s (block list, any case)', async (file) => {
    const spawn = fakeSpawn();
    expect(await openFailure(spawnGui(file, [], gui(spawn)))).toEqual({
      code: 'OPEN_FAILED',
      params: { reason: 'blocked' },
    });
    expect(spawn.calls).toEqual([]);
  });

  it.each([
    ['a console program', peHead(PE_SUBSYSTEM_WINDOWS_CUI)],
    ['a broken header', Buffer.from('MZ but nothing else')],
    ['no PE at all', Buffer.from('#!/bin/sh')],
  ])('OPEN_FAILED not_gui for %s', async (_name, head) => {
    const spawn = fakeSpawn();
    expect(
      await openFailure(
        spawnGui(
          EDITOR,
          [],
          gui(spawn, () => Promise.resolve(head)),
        ),
      ),
    ).toEqual({
      code: 'OPEN_FAILED',
      params: { reason: 'not_gui' },
    });
    expect(spawn.calls).toEqual([]);
  });

  it('a header that cannot be read → OPEN_FAILED {reason: <errno>}', async () => {
    const spawn = fakeSpawn();
    const missing = () => Promise.reject(Object.assign(new Error('ENOENT'), { code: 'ENOENT' }));
    expect(await openFailure(spawnGui(EDITOR, [], gui(spawn, missing)))).toEqual({
      code: 'OPEN_FAILED',
      params: { reason: 'ENOENT' },
    });
  });

  it('spawn errors (AppLocker EACCES, a synchronous throw) → OPEN_FAILED {reason}', async () => {
    const denied = fakeSpawn(Object.assign(new Error('EACCES'), { code: 'EACCES' }));
    expect(await openFailure(spawnGui(EDITOR, [], gui(denied)))).toEqual({
      code: 'OPEN_FAILED',
      params: { reason: 'EACCES' },
    });
    expect(denied.unrefs()).toBe(0);
    expect(await openFailure(spawnGui(EDITOR, [], gui(fakeSpawn('throw'))))).toEqual({
      code: 'OPEN_FAILED',
      params: { reason: 'EINVAL' },
    });
  });
});

describe('spawnExplorer (ADR-144)', () => {
  const options = (spawn: GuiSpawnFn) => ({ env: ENV, spawn, platform: 'win32' as const });

  it('select: %SystemRoot%\\explorer.exe with ONE verbatim argument /select,"<path>"', async () => {
    const spawn = fakeSpawn();
    await spawnExplorer('C:\\work\\project\\a file.txt', 'select', options(spawn));
    expect(spawn.calls).toEqual([
      {
        file: 'C:\\Windows\\explorer.exe',
        args: ['/select,"C:\\work\\project\\a file.txt"'],
        options: {
          cwd: 'C:\\Windows',
          env: KEPT_ENV,
          shell: false,
          windowsHide: false,
          detached: true,
          stdio: 'ignore',
          windowsVerbatimArguments: true,
          argv0: '"C:\\Windows\\explorer.exe"',
        },
      },
    ]);
    expect(spawn.unrefs()).toBe(1);
  });

  it('open: one quoted argument (a folder, or a file with its default program)', async () => {
    const spawn = fakeSpawn();
    await spawnExplorer('C:\\work\\project', 'open', options(spawn));
    expect(spawn.calls[0]?.args).toEqual(['"C:\\work\\project"']);
    expect(explorerArgument('C:\\a b\\c.pdf', 'open')).toBe('"C:\\a b\\c.pdf"');
    expect(explorerArgument('C:\\a b\\c.pdf', 'select')).toBe('/select,"C:\\a b\\c.pdf"');
  });

  it.each([
    '\\\\server\\share\\x',
    '//server/x',
    '\\\\?\\C:\\x',
    'C:\\x\\a".txt',
    'C:\\x\\a.txt:ads',
    'relative\\x',
  ])('OPEN_FAILED path for %s – never started', async (target) => {
    const spawn = fakeSpawn();
    expect(await openFailure(spawnExplorer(target, 'select', options(spawn)))).toEqual({
      code: 'OPEN_FAILED',
      params: { reason: 'path' },
    });
    expect(spawn.calls).toEqual([]);
  });

  it('a spawn error → OPEN_FAILED {reason}', async () => {
    const spawn = fakeSpawn(Object.assign(new Error('ENOENT'), { code: 'ENOENT' }));
    expect(await openFailure(spawnExplorer('C:\\x', 'open', options(spawn)))).toEqual({
      code: 'OPEN_FAILED',
      params: { reason: 'ENOENT' },
    });
  });
});
