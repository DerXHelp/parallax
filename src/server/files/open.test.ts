import type { SpawnOptions } from 'node:child_process';
import { Writable } from 'node:stream';
import { pino } from 'pino';
import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { defaultEditorSettings, type EditorSettings } from '@shared/model';
import type { GuiChild, GuiSpawnFn } from '../lib/process';
import { createMemoryFs, type FsProbe } from '../lib/windows';
import { CommandError } from '../sync/ports';
import { createRecordingOpener, createSystemLauncher, type OpenRequest } from './open';

const logLine = z.object({ msg: z.string() });
const NPP = 'C:\\Program Files\\Notepad++\\notepad++.exe';
const ENV = { ProgramFiles: 'C:\\Program Files', SystemRoot: 'C:\\Windows', Path: 'C:\\Windows' };

function guiHead(): Buffer {
  const bytes = Buffer.alloc(512);
  bytes.write('MZ', 0, 'latin1');
  bytes.writeUInt32LE(0x80, 0x3c);
  bytes.write('PE\0\0', 0x80, 'latin1');
  bytes.writeUInt16LE(240, 0x80 + 20);
  bytes.writeUInt16LE(0x20b, 0x98);
  bytes.writeUInt16LE(2, 0x98 + 68);
  return bytes;
}

function recordingSpawn(): GuiSpawnFn & {
  calls: { file: string; args: readonly string[]; options: SpawnOptions }[];
} {
  const calls: { file: string; args: readonly string[]; options: SpawnOptions }[] = [];
  const spawn: GuiSpawnFn = (file, args, options) => {
    calls.push({ file, args, options });
    const child: GuiChild = {
      once: (event, listener) => {
        if (event === 'spawn') {
          queueMicrotask(() => {
            listener();
          });
        }
        return child;
      },
      unref: () => undefined,
    };
    return child;
  };
  return Object.assign(spawn, { calls });
}

function launcher(files: Record<string, string> = { [NPP]: '' }) {
  const spawn = recordingSpawn();
  const clock = { now: 0 };
  const registry: string[] = [];
  const query = (key: string) => {
    registry.push(key);
    return Promise.resolve(null);
  };
  const memory = createMemoryFs(files);
  /** Files removed later in a test (an uninstalled editor). */
  const gone = new Set<string>();
  const probe: FsProbe = {
    isFile: (file) => (gone.has(file) ? Promise.resolve(false) : memory.isFile(file)),
    readText: (file) => memory.readText(file),
  };
  const system = createSystemLauncher({
    regQuery: query,
    regKeyQuery: query,
    probe,
    env: ENV,
    spawn,
    readHead: () => Promise.resolve(guiHead()),
    platform: 'win32',
    now: () => clock.now,
  });
  return { system, spawn, clock, registry, gone };
}

const request = (p: Partial<OpenRequest> = {}): OpenRequest => ({
  target: 'editor',
  path: 'D:\\link\\src\\a.ts',
  realPath: 'D:\\work\\sample\\src\\a.ts',
  directory: false,
  line: 12,
  col: null,
  editor: defaultEditorSettings(),
  ...p,
});

describe('createSystemLauncher (ADR-144; spawn faked – nothing starts)', () => {
  it('editor: the detected Notepad++ with per-argument placeholders, cwd = folder of the editor (R5-02)', async () => {
    const { system, spawn } = launcher();
    await system.open(request());
    expect(spawn.calls).toHaveLength(1);
    expect(spawn.calls[0]).toMatchObject({
      file: NPP,
      args: ['-n12', '-c1', 'D:\\work\\sample\\src\\a.ts'],
      options: {
        cwd: 'C:\\Program Files\\Notepad++',
        shell: false,
        windowsHide: false,
        detached: true,
        stdio: 'ignore',
      },
    });
  });

  it('editor: custom executable and arguments; cwd = its folder, never the project (R5-02)', async () => {
    const custom: EditorSettings = {
      preset: 'custom',
      executable: 'D:\\Tools\\ed.exe',
      args: ['+{line}:{col}', '{file}'],
    };
    const { system, spawn } = launcher({ 'D:\\Tools\\ed.exe': '' });
    await system.open(request({ editor: custom, line: 4, col: 2 }));
    expect(spawn.calls[0]).toMatchObject({
      file: 'D:\\Tools\\ed.exe',
      args: ['+4:2', 'D:\\work\\sample\\src\\a.ts'],
      options: { cwd: 'D:\\Tools' },
    });
  });

  it('editor lookup (R5-04): one registry search per preset and minute; a vanished hit, a later click or detect look again', async () => {
    const { system, spawn, clock, registry, gone } = launcher();
    await system.open(request());
    const perSearch = registry.length;
    expect(perSearch).toBeGreaterThan(0);
    clock.now = 59_999;
    await system.open(request());
    expect(registry).toHaveLength(perSearch);
    // After the minute: a new search.
    clock.now = 60_000;
    await system.open(request());
    expect(registry).toHaveLength(2 * perSearch);
    // detect always searches afresh.
    await system.detect(defaultEditorSettings());
    expect(registry.length).toBeGreaterThan(2 * perSearch);
    const afterDetect = registry.length;
    await system.open(request());
    expect(registry).toHaveLength(afterDetect);
    // The cached editor is gone (uninstalled): searched again → EDITOR_NOT_FOUND, nothing started.
    gone.add(NPP);
    const error = await system.open(request()).catch((caught: unknown) => caught);
    expect(error).toMatchObject({ error: { code: 'EDITOR_NOT_FOUND' } });
    expect(registry.length).toBeGreaterThan(afterDetect);
    expect(spawn.calls).toHaveLength(4);
  });

  it('editor not installed → EDITOR_NOT_FOUND, nothing started', async () => {
    const { system, spawn } = launcher({});
    const error = await system.open(request()).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(CommandError);
    expect(error).toMatchObject({ error: { code: 'EDITOR_NOT_FOUND', params: { preset: 'notepadpp' } } });
    expect(spawn.calls).toEqual([]);
  });

  it('explorer: a file is selected, a folder opened; default: explorer.exe "<file>" – exact arguments', async () => {
    const { system, spawn } = launcher();
    await system.open(request({ target: 'explorer' }));
    await system.open(request({ target: 'explorer', realPath: 'D:\\work\\sample', directory: true }));
    await system.open(request({ target: 'default', realPath: 'D:\\work\\sample\\doc.pdf' }));
    expect(spawn.calls.map((call) => [call.file, call.args, call.options.windowsVerbatimArguments])).toEqual([
      ['C:\\Windows\\explorer.exe', ['/select,"D:\\work\\sample\\src\\a.ts"'], true],
      ['C:\\Windows\\explorer.exe', ['"D:\\work\\sample"'], true],
      ['C:\\Windows\\explorer.exe', ['"D:\\work\\sample\\doc.pdf"'], true],
    ]);
  });

  it('detect: both presets and the configured executable', async () => {
    const { system } = launcher();
    expect(await system.detect(defaultEditorSettings())).toEqual({
      notepadpp: NPP,
      vscode: null,
      custom: null,
    });
  });
});

describe('createRecordingOpener (WP-60 wires it with the FakeBackend)', () => {
  it('records and logs "file.open (fake): <target> <path>", starts nothing', async () => {
    const lines: string[] = [];
    const sink = new Writable({
      write(chunk: Buffer, _encoding, done) {
        lines.push(chunk.toString('utf8'));
        done();
      },
    });
    const opener = createRecordingOpener({ logger: pino({ level: 'info' }, sink) });
    await opener.open(request());
    await opener.open(request({ target: 'explorer' }));
    expect(opener.calls.map((call) => call.target)).toEqual(['editor', 'explorer']);
    const messages = lines.map((line) => logLine.parse(JSON.parse(line)).msg);
    expect(messages).toEqual([
      'file.open (fake): editor D:\\link\\src\\a.ts',
      'file.open (fake): explorer D:\\link\\src\\a.ts',
    ]);
  });

  it('detect: nothing installed by default, or the given answer', async () => {
    expect(
      await createRecordingOpener().detect({ preset: 'custom', executable: 'D:\\x.exe', args: ['{file}'] }),
    ).toEqual({
      notepadpp: null,
      vscode: null,
      custom: { executable: 'D:\\x.exe', exists: false },
    });
    const detection = { notepadpp: NPP, vscode: null, custom: null };
    expect(await createRecordingOpener({ detection }).detect(defaultEditorSettings())).toBe(detection);
  });
});
