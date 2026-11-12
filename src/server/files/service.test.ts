import { mkdir, readFile, symlink, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { LIMITS, type EntryId } from '@shared/common';
import {
  sessionFilesFileSchema,
  settingsSchema,
  type EditorSettings,
  type Settings,
  type ToolCallItem,
} from '@shared/model';
import { commandResultSchemas, type CommandOf, type HostCommand, type SessionOp } from '@shared/protocol';
import { SAMPLE_IDS, sampleId, sampleItems, sampleTime } from '@shared/samples';
import { makeTempHome } from '../http/testServer';
import type { RunFileFn } from '../lib/process';
import { attachmentsDir } from '../store/attachments';
import { entryDir } from '../store/decisions';
import { CommandError } from '../sync/ports';
import { nodeFileFs, type FileFs } from './fileFs';
import { createRecordingOpener } from './open';
import type { FileEntryInfo } from './ports';
import { createFileService, type FileServiceDeps } from './service';
import { SESSION_FILES_FILE } from './sessionIndex';
import { countingFileFs, fakeTranscripts } from './testing';

const ENTRY = SAMPLE_IDS.entry;
const CTX = { clientId: SAMPLE_IDS.client, cmdId: SAMPLE_IDS.cmdId };

let toolSeq = 0;
function tool(toolName: string, input: ToolCallItem['input'], p: Partial<ToolCallItem> = {}): ToolCallItem {
  toolSeq += 1;
  const id = `toolu_svc${String(toolSeq).padStart(6, '0')}`;
  return sampleItems.toolCall({ id: `msg:${id}`, toolUseId: id, toolName, input, order: toolSeq, ...p });
}
const upsert = (item: ToolCallItem): SessionOp => ({ op: 'item.upsert', item });

interface Setup {
  home: string;
  cwd: string;
  extra: string;
  outside: string;
  info: FileEntryInfo;
  fs: ReturnType<typeof countingFileFs>;
  opener: ReturnType<typeof createRecordingOpener>;
  settings: { current: Settings };
  service: ReturnType<typeof createFileService>;
  run: (cmd: HostCommand) => Promise<unknown>;
  clock: { now: number };
  gitRuns: string[];
}

async function setup(overrides: Partial<FileServiceDeps> & { baseFs?: FileFs } = {}): Promise<Setup> {
  const home = await makeTempHome('files-svc-');
  const cwd = path.join(home, 'project');
  const extra = path.join(home, 'shared-docs');
  const outside = path.join(home, 'outside');
  await mkdir(path.join(cwd, 'src'), { recursive: true });
  await mkdir(extra, { recursive: true });
  await mkdir(outside, { recursive: true });
  await writeFile(path.join(cwd, 'README.md'), '# Sample\n');
  await writeFile(path.join(cwd, 'src', 'main.ts'), 'export const x = 1;\n');
  await writeFile(path.join(cwd, 'tool.ps1'), 'Write-Host hi\n');
  await writeFile(path.join(cwd, 'data.bin'), Buffer.from([0x50, 0x4b, 0x03, 0x04, 0, 0, 0]));
  await writeFile(path.join(extra, 'guide.txt'), 'guide\n');
  await writeFile(path.join(outside, 'secret.txt'), 'secret\n');
  const info: FileEntryInfo = {
    cwd,
    additionalDirectories: [extra],
    conversationIds: [SAMPLE_IDS.conversation],
  };
  const fs = countingFileFs(overrides.baseFs ?? nodeFileFs);
  const opener = createRecordingOpener();
  const settings = { current: settingsSchema.parse({}) };
  const clock = { now: 1_000_000 };
  const gitRuns: string[] = [];
  const gitRun: RunFileFn = (_file, _args, options) => {
    gitRuns.push(options.cwd ?? '');
    return Promise.resolve({
      exitCode: 0,
      signal: null,
      stdout: 'README.md\0src/main.ts\0',
      stderr: '',
      timedOut: false,
    });
  };
  const service = createFileService({
    home,
    entries: { entry: (entryId: EntryId) => (entryId === ENTRY ? info : null) },
    transcripts: fakeTranscripts(),
    settings: () => settings.current,
    launcher: opener,
    fs,
    indexDebounceMs: 60_000,
    git: { resolve: () => Promise.resolve('C:\\Program Files\\Git\\cmd\\git.exe'), run: gitRun },
    now: () => clock.now,
    ...overrides,
  });
  const run = (cmd: HostCommand) => service.commands.handle(cmd, CTX);
  return { home, cwd, extra, outside, info, fs, opener, settings, service, run, clock, gitRuns };
}

async function failure(promise: Promise<unknown>): Promise<unknown> {
  const error = await promise.catch((caught: unknown) => caught);
  return error instanceof CommandError ? error.error : error;
}

const stat = (p: string, entryId: EntryId = ENTRY): CommandOf<'file.stat'> => ({
  name: 'file.stat',
  entryId,
  path: p,
});
const open = (
  p: string,
  target: 'editor' | 'explorer' | 'default',
  line: number | null = null,
): CommandOf<'file.open'> => ({
  name: 'file.open',
  entryId: ENTRY,
  path: p,
  target,
  line,
  col: null,
});

describe('createFileService – L15 spy test: rejected paths never reach the file system or a program', () => {
  it('UNC, device and paths outside the policy: no fs call, no program start (every command, HTTP)', async () => {
    const s = await setup();
    const rejected = ['\\\\host\\share\\x', '//host/x', '\\\\?\\C:\\x'];
    const outsidePolicy = [
      'C:\\Windows\\win.ini',
      path.join(s.outside, 'secret.txt'),
      path.join(s.home, 'project-other', 'a.txt'),
    ];
    for (const target of [...rejected, ...outsidePolicy]) {
      const expected = rejected.includes(target) ? 'PATH_REJECTED' : 'PATH_NOT_ALLOWED';
      expect([target, await failure(s.run(stat(target)))]).toEqual([
        target,
        expect.objectContaining({ code: expected }),
      ]);
      for (const how of ['editor', 'explorer', 'default'] as const) {
        expect([target, how, await failure(s.run(open(target, how)))]).toEqual([
          target,
          how,
          expect.objectContaining({ code: expected }),
        ]);
      }
      expect(await failure(s.service.open(ENTRY, target))).toMatchObject({ code: expected });
    }
    const many = commandResultSchemas['file.statMany'].parse(
      await s.run({ name: 'file.statMany', entryId: ENTRY, paths: [...rejected, ...outsidePolicy] }),
    );
    expect(many.results.every((result) => !result.ok)).toBe(true);
    expect(s.fs.calls).toEqual([]);
    expect(s.opener.calls).toEqual([]);
  });
});

describe('createFileService – file.stat / file.statMany', () => {
  it('access by root: cwd, additional dir, attachments; ENTRY_NOT_FOUND; FILE_NOT_FOUND', async () => {
    const s = await setup();
    expect(await s.run(stat(path.join(s.cwd, 'README.md')))).toMatchObject({
      file: { kind: 'markdown', access: 'cwd', bytes: 9, previewable: true },
    });
    expect(await s.run(stat(path.join(s.extra, 'guide.txt')))).toMatchObject({
      file: { kind: 'text', access: 'additional' },
    });
    const attachment = path.join(attachmentsDir(s.home, ENTRY), 'abcdef0123456789', 'paste.txt');
    await mkdir(path.dirname(attachment), { recursive: true });
    await writeFile(attachment, 'pasted\n');
    expect(await s.run(stat(attachment))).toMatchObject({ file: { access: 'attachments' } });
    expect(await s.run(stat(path.join(s.cwd, 'src')))).toMatchObject({ file: { kind: 'directory' } });
    expect(await failure(s.run(stat(path.join(s.cwd, 'README.md'), sampleId('en', 99))))).toEqual({
      code: 'ENTRY_NOT_FOUND',
      params: {},
    });
    expect(await failure(s.run(stat(path.join(s.cwd, 'missing.md'))))).toEqual({
      code: 'FILE_NOT_FOUND',
      params: {},
    });
  });

  it('a file outside the roots is allowed once the session index lists it (access "session")', async () => {
    const s = await setup();
    const secret = path.join(s.outside, 'secret.txt');
    expect(await failure(s.run(stat(secret)))).toMatchObject({ code: 'PATH_NOT_ALLOWED' });
    s.service.observeOps(ENTRY, [upsert(tool('Read', { file_path: secret }))]);
    expect(await s.run(stat(secret))).toMatchObject({ file: { access: 'session', kind: 'text' } });
    // Its siblings stay forbidden.
    expect(await failure(s.run(stat(path.join(s.outside, 'other.txt'))))).toMatchObject({
      code: 'PATH_NOT_ALLOWED',
    });
  });

  it('a junction inside the cwd that leads out of the roots: PATH_NOT_ALLOWED', async () => {
    const s = await setup();
    await symlink(s.outside, path.join(s.cwd, 'escape'), 'junction');
    expect(await failure(s.run(stat(path.join(s.cwd, 'escape', 'secret.txt'))))).toEqual({
      code: 'PATH_NOT_ALLOWED',
      params: {},
    });
  });

  it('statMany: request order, ok:false per path, at most 8 stats at once', async () => {
    let running = 0;
    let peak = 0;
    const slowFs: FileFs = {
      ...nodeFileFs,
      stat: async (file) => {
        running += 1;
        peak = Math.max(peak, running);
        await new Promise((resolve) => setTimeout(resolve, 5));
        running -= 1;
        return nodeFileFs.stat(file);
      },
    };
    const s = await setup({ baseFs: slowFs });
    const good = path.join(s.cwd, 'README.md');
    const paths = [
      good,
      '\\\\host\\x',
      path.join(s.cwd, 'missing.txt'),
      ...Array.from({ length: 20 }, () => good),
    ];
    const { results } = commandResultSchemas['file.statMany'].parse(
      await s.run({ name: 'file.statMany', entryId: ENTRY, paths }),
    );
    expect(results.map((result) => result.path)).toEqual(paths);
    expect(results[0]?.ok).toBe(true);
    expect(results[1]).toMatchObject({ ok: false, error: { code: 'PATH_REJECTED' } });
    expect(results[2]).toMatchObject({ ok: false, error: { code: 'FILE_NOT_FOUND' } });
    expect(peak).toBeLessThanOrEqual(8);
    expect(peak).toBeGreaterThan(1);
  });

  it('a hanging drive: FILE_NOT_READABLE {reason: timeout} after the fs timeout', async () => {
    const hangingFs: FileFs = {
      ...nodeFileFs,
      realpath: () => new Promise<string>(() => undefined),
    };
    const s = await setup({ baseFs: hangingFs, fsTimeoutMs: 30 });
    expect(await failure(s.run(stat(path.join(s.cwd, 'README.md'))))).toEqual({
      code: 'FILE_NOT_READABLE',
      params: { reason: 'timeout' },
    });
  });

  it('the physical roots are cached per entry: 60 s, or until the roots change', async () => {
    const s = await setup();
    const realpaths = () => s.fs.calls.filter((call) => call === `realpath:${s.cwd}`).length;
    await s.run(stat(path.join(s.cwd, 'README.md')));
    await s.run(stat(path.join(s.cwd, 'src', 'main.ts')));
    expect(realpaths()).toBe(1);
    s.info.additionalDirectories = [s.extra, s.outside];
    await s.run(stat(path.join(s.cwd, 'README.md')));
    expect(realpaths()).toBe(2);
    s.clock.now += 60_000;
    await s.run(stat(path.join(s.cwd, 'README.md')));
    expect(realpaths()).toBe(3);
  });
});

describe('createFileService – GET /api/file (open)', () => {
  it('text content, cut at a line end over fileTextBytes; binary files are not served', async () => {
    const s = await setup();
    const big = path.join(s.cwd, 'big.log');
    await writeFile(big, `${'y'.repeat(79)}\n`.repeat(Math.ceil(LIMITS.fileTextBytes / 80) + 50));
    const content = await s.service.open(ENTRY, big);
    expect(content.bytes).toBeLessThanOrEqual(LIMITS.fileTextBytes);
    expect(content.bytes % 80).toBe(0);
    expect(content.policy).toBe('blob');
    content.stream.destroy();
    expect(await failure(s.service.open(ENTRY, path.join(s.cwd, 'data.bin')))).toEqual({
      code: 'UNSUPPORTED_MEDIA_TYPE',
      params: {},
    });
    expect(await failure(s.service.open(ENTRY, path.join(s.cwd, 'src')))).toMatchObject({
      code: 'UNSUPPORTED_MEDIA_TYPE',
    });
  });
});

describe('createFileService – file.open (ADR-144; recording opener, nothing starts)', () => {
  it('editor: the checked physical path with line/col and the current editor settings', async () => {
    const s = await setup();
    const file = path.join(s.cwd, 'src', 'main.ts');
    expect(await s.run(open(file, 'editor', 7))).toEqual({});
    expect(s.opener.calls).toEqual([
      expect.objectContaining({
        target: 'editor',
        path: file,
        directory: false,
        line: 7,
        col: null,
        editor: s.settings.current.editor,
      }),
    ]);
    expect(s.opener.calls[0]?.realPath.toLowerCase()).toBe(file.toLowerCase());
  });

  it('editor/default on a folder: VALIDATION_FAILED {reason: directory}; explorer opens folders', async () => {
    const s = await setup();
    const folder = path.join(s.cwd, 'src');
    expect(await failure(s.run(open(folder, 'editor')))).toEqual({
      code: 'VALIDATION_FAILED',
      params: { reason: 'directory' },
    });
    expect(await failure(s.run(open(folder, 'default')))).toEqual({
      code: 'VALIDATION_FAILED',
      params: { reason: 'directory' },
    });
    await s.run(open(folder, 'explorer'));
    await s.run(open(path.join(s.cwd, 'README.md'), 'explorer'));
    expect(s.opener.calls.map((call) => [call.target, call.directory])).toEqual([
      ['explorer', true],
      ['explorer', false],
    ]);
  });

  it('default: only extensions of the list, checked on the requested AND the physical path', async () => {
    const swapFs: FileFs = {
      ...nodeFileFs,
      // notes.txt is (physically) tool.ps1 – e.g. a link with a harmless name.
      realpath: (file) =>
        file.toLowerCase().endsWith('notes.txt')
          ? Promise.resolve(file.replace(/notes\.txt$/i, 'tool.ps1'))
          : nodeFileFs.realpath(file),
    };
    const s = await setup({ baseFs: swapFs });
    expect(await failure(s.run(open(path.join(s.cwd, 'tool.ps1'), 'default')))).toEqual({
      code: 'FILE_TYPE_BLOCKED',
      params: {},
    });
    expect(await failure(s.run(open(path.join(s.cwd, 'notes.txt'), 'default')))).toEqual({
      code: 'FILE_TYPE_BLOCKED',
      params: {},
    });
    await s.run(open(path.join(s.cwd, 'README.md'), 'default'));
    expect(s.opener.calls.map((call) => call.target)).toEqual(['default']);
  });

  it('preset system: "open in editor" becomes the default program (with its extension list)', async () => {
    const s = await setup();
    const system: EditorSettings = { preset: 'system', executable: null, args: [] };
    s.settings.current = settingsSchema.parse({ editor: system });
    await s.run(open(path.join(s.cwd, 'README.md'), 'editor'));
    expect(s.opener.calls[0]?.target).toBe('default');
    expect(await failure(s.run(open(path.join(s.cwd, 'tool.ps1'), 'editor')))).toEqual({
      code: 'FILE_TYPE_BLOCKED',
      params: {},
    });
  });

  it('missing files: FILE_NOT_FOUND, nothing started', async () => {
    const s = await setup();
    expect(await failure(s.run(open(path.join(s.cwd, 'gone.txt'), 'editor')))).toEqual({
      code: 'FILE_NOT_FOUND',
      params: {},
    });
    expect(s.opener.calls).toEqual([]);
  });

  it('editor.detect asks the launcher with the current editor settings', async () => {
    const s = await setup();
    expect(await s.run({ name: 'editor.detect' })).toEqual({ notepadpp: null, vscode: null, custom: null });
  });
});

describe('createFileService – files.session / files.project', () => {
  it('index entries plus attachments ("attached"), newest lastAt first; flush writes files.json', async () => {
    const s = await setup();
    const attached = path.join(attachmentsDir(s.home, ENTRY), '0123456789abcdef', 'spec.pdf');
    await mkdir(path.dirname(attached), { recursive: true });
    await writeFile(attached, '%PDF-1.7\n');
    s.service.observeOps(ENTRY, [
      upsert(tool('Read', { file_path: path.join(s.cwd, 'README.md') }, { at: sampleTime(1) })),
      upsert(tool('Edit', { file_path: path.join(s.cwd, 'src', 'main.ts') }, { at: sampleTime(2) })),
      upsert(tool('Read', { file_path: attached }, { at: sampleTime(3) })),
    ]);
    const result = commandResultSchemas['files.session'].parse(
      await s.run({ name: 'files.session', entryId: ENTRY }),
    );
    expect(result.truncated).toBe(false);
    const byPath = new Map(result.files.map((file) => [file.path.toLowerCase(), file]));
    expect(byPath.get(attached.toLowerCase())?.ops).toEqual(['attached', 'read']);
    expect(byPath.get(path.join(s.cwd, 'src', 'main.ts').toLowerCase())?.ops).toEqual(['edited']);
    expect(result.files).toHaveLength(3);
    await s.service.flush();
    const stored = sessionFilesFileSchema.parse(
      JSON.parse(await readFile(path.join(entryDir(s.home, ENTRY), SESSION_FILES_FILE), 'utf8')),
    );
    expect(stored).toMatchObject({ schemaVersion: 1, backfilled: true });
    expect(stored.files).toHaveLength(3);
  });

  it('files.project: git list of the cwd, cached; a finished Write drops the cache, a Read does not', async () => {
    const s = await setup();
    const project = { name: 'files.project', entryId: ENTRY } as const;
    expect(await s.run(project)).toEqual({
      root: s.cwd,
      files: ['README.md', 'src/main.ts'],
      truncated: false,
      source: 'git',
    });
    await s.run(project);
    expect(s.gitRuns).toEqual([s.cwd]);
    s.service.observeOps(ENTRY, [upsert(tool('Read', { file_path: path.join(s.cwd, 'README.md') }))]);
    await s.run(project);
    expect(s.gitRuns).toHaveLength(1);
    s.service.observeOps(ENTRY, [upsert(tool('Write', { file_path: path.join(s.cwd, 'new.ts') }))]);
    await s.run(project);
    expect(s.gitRuns).toHaveLength(2);
  });

  it('files.project: CWD_NOT_FOUND / CWD_NOT_DIRECTORY / PATH_REJECTED for the cwd', async () => {
    const s = await setup();
    const project = { name: 'files.project', entryId: ENTRY } as const;
    s.info.cwd = path.join(s.home, 'gone');
    expect(await failure(s.run(project))).toEqual({ code: 'CWD_NOT_FOUND', params: {} });
    s.info.cwd = path.join(s.home, 'project', 'README.md');
    expect(await failure(s.run(project))).toEqual({ code: 'CWD_NOT_DIRECTORY', params: {} });
    s.info.cwd = '\\\\server\\share\\repo';
    const before = s.fs.calls.length;
    expect(await failure(s.run(project))).toEqual({ code: 'PATH_REJECTED', params: { reason: 'unc' } });
    expect(s.fs.calls.length).toBe(before);
    expect(s.gitRuns).toEqual([]);
  });

  it('commands: the six names; ENTRY_NOT_FOUND for unknown entries', async () => {
    const s = await setup();
    expect(s.service.commands.names).toEqual([
      'file.stat',
      'file.statMany',
      'file.open',
      'files.session',
      'files.project',
      'editor.detect',
    ]);
    expect(await failure(s.run({ name: 'files.session', entryId: sampleId('en', 7) }))).toEqual({
      code: 'ENTRY_NOT_FOUND',
      params: {},
    });
    expect(await failure(s.run({ name: 'files.project', entryId: sampleId('en', 7) }))).toEqual({
      code: 'ENTRY_NOT_FOUND',
      params: {},
    });
  });
});
