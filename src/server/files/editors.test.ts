import { describe, expect, it } from 'vitest';
import type { EditorSettings } from '@shared/model';
import type { RegView } from '../lib/registry';
import { createMemoryFs } from '../lib/windows';
import { CommandError } from '../sync/ports';
import {
  createEditorFinder,
  detectEditors,
  editorArguments,
  findEditor,
  resolveEditorExecutable,
  type EditorLocatorDeps,
} from './editors';

const NPP = 'C:\\Program Files\\Notepad++\\notepad++.exe';
const NPP_X86 = 'C:\\Program Files (x86)\\Notepad++\\notepad++.exe';
const CODE_USER = 'C:\\Users\\me\\AppData\\Local\\Programs\\Microsoft VS Code\\Code.exe';
const ENV = {
  ProgramFiles: 'C:\\Program Files',
  'ProgramFiles(x86)': 'C:\\Program Files (x86)',
  LOCALAPPDATA: 'C:\\Users\\me\\AppData\\Local',
};
const APP_PATHS = 'SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\App Paths';
const UNINSTALL = 'SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\Uninstall';

const defaultValue = (value: string, type = 'REG_SZ') =>
  `\r\nHKEY\\x\r\n    (Default)    ${type}    ${value}\r\n`;
const installLocation = (value: string) =>
  `\r\nHKEY\\x\r\n    DisplayName    REG_SZ    App\r\n    InstallLocation    REG_SZ    ${value}\r\n`;

/** Registry fake: `<key>@<view>` → output; `asked` lists every query. */
function deps(
  files: Record<string, string>,
  values: Record<string, string> = {},
  keys: Record<string, string> = {},
): EditorLocatorDeps & { asked: string[]; touched: string[] } {
  const asked: string[] = [];
  const fs = createMemoryFs(files);
  const query = (table: Record<string, string>) => (key: string, view: RegView) => {
    asked.push(`${key}@${String(view)}`);
    return Promise.resolve(table[`${key}@${String(view)}`] ?? null);
  };
  return { regQuery: query(values), regKeyQuery: query(keys), fs, env: ENV, asked, touched: fs.touched };
}

const editor = (p: Partial<EditorSettings> = {}): EditorSettings => ({
  preset: 'notepadpp',
  executable: null,
  args: [],
  ...p,
});

async function errorPayload(promise: Promise<unknown>): Promise<unknown> {
  const error = await promise.catch((caught: unknown) => caught);
  return error instanceof CommandError ? error.error : error;
}

describe('findEditor (ADR-144)', () => {
  it('App Paths first (HKCU, then HKLM 64/32), expanded and checked', async () => {
    const d = deps(
      { [NPP_X86]: '' },
      {
        [`HKLM\\${APP_PATHS}\\notepad++.exe@32`]: defaultValue(
          '%ProgramFiles(x86)%\\Notepad++\\notepad++.exe',
          'REG_EXPAND_SZ',
        ),
      },
    );
    expect(await findEditor('notepadpp', d)).toBe(NPP_X86);
    // R5-04: the first hit ends the search – no Uninstall query after it.
    expect(d.asked).toEqual([
      `HKCU\\${APP_PATHS}\\notepad++.exe@64`,
      `HKLM\\${APP_PATHS}\\notepad++.exe@64`,
      `HKLM\\${APP_PATHS}\\notepad++.exe@32`,
    ]);
  });

  it('stops at the first usable candidate (R5-04): a hit in HKCU asks nothing else', async () => {
    const d = deps(
      { [NPP]: '', [NPP_X86]: '' },
      {
        [`HKCU\\${APP_PATHS}\\notepad++.exe@64`]: defaultValue(NPP),
        [`HKLM\\${APP_PATHS}\\notepad++.exe@64`]: defaultValue(NPP_X86),
      },
    );
    expect(await findEditor('notepadpp', d)).toBe(NPP);
    expect(d.asked).toEqual([`HKCU\\${APP_PATHS}\\notepad++.exe@64`]);
    expect(d.touched).toEqual([NPP]);
  });

  it('then Uninstall InstallLocation, then the usual folders', async () => {
    const viaUninstall = deps(
      { 'D:\\Tools\\Notepad++\\notepad++.exe': '', [NPP]: '' },
      {},
      { [`HKLM\\${UNINSTALL}\\Notepad++@64`]: installLocation('D:\\Tools\\Notepad++') },
    );
    expect(await findEditor('notepadpp', viaUninstall)).toBe('D:\\Tools\\Notepad++\\notepad++.exe');
    expect(await findEditor('notepadpp', deps({ [NPP]: '' }))).toBe(NPP);
    expect(await findEditor('vscode', deps({ [CODE_USER]: '' }))).toBe(CODE_USER);
    const vsUninstall = deps(
      { 'E:\\VSCode\\Code.exe': '' },
      {},
      {
        [`HKCU\\${UNINSTALL}\\{771FD6B0-FA20-440A-A002-3B3BAC16DC50}_is1@64`]:
          installLocation('E:\\VSCode\\'),
      },
    );
    expect(await findEditor('vscode', vsUninstall)).toBe('E:\\VSCode\\Code.exe');
    expect(await findEditor('vscode', deps({}))).toBeNull();
  });

  it('registry values are never trusted: wrong name, blocked, UNC – skipped without touching them', async () => {
    const d = deps(
      { 'C:\\Windows\\System32\\cmd.exe': '', [NPP]: '' },
      {
        [`HKCU\\${APP_PATHS}\\notepad++.exe@64`]: defaultValue('C:\\Windows\\System32\\cmd.exe'),
        [`HKLM\\${APP_PATHS}\\notepad++.exe@64`]: defaultValue('\\\\evil\\share\\notepad++.exe'),
      },
      { [`HKLM\\${UNINSTALL}\\Notepad++@64`]: installLocation('\\\\evil\\share') },
    );
    expect(await findEditor('notepadpp', d)).toBe(NPP);
    expect(d.touched.some((file) => file.startsWith('\\\\') || /cmd\.exe$/i.test(file))).toBe(false);
  });
});

describe('createEditorFinder (R5-04)', () => {
  const appPath = { [`HKLM\\${APP_PATHS}\\notepad++.exe@64`]: defaultValue(NPP) };

  it('keeps a hit per preset for the TTL, re-checked by one stat; misses are not cached', async () => {
    let now = 1_000;
    const finder = createEditorFinder({ ttlMs: 60_000, now: () => now });
    const d = deps({ [NPP]: '' }, appPath);
    expect(await finder.find('notepadpp', d)).toBe(NPP);
    const asked = d.asked.length;
    now += 59_999;
    expect(await finder.find('notepadpp', d)).toBe(NPP);
    expect(d.asked).toHaveLength(asked);
    expect(d.touched.at(-1)).toBe(NPP);
    // Another preset has its own entry; a miss is searched again each time.
    expect(await finder.find('vscode', d)).toBeNull();
    const afterMiss = d.asked.length;
    expect(await finder.find('vscode', d)).toBeNull();
    expect(d.asked.length).toBeGreaterThan(afterMiss);
    // Expired → searched again.
    now += 1;
    const beforeExpiry = d.asked.length;
    expect(await finder.find('notepadpp', d)).toBe(NPP);
    expect(d.asked.length).toBeGreaterThan(beforeExpiry);
  });

  it('a cached executable that vanished is searched again; refresh always searches and replaces the hit', async () => {
    const finder = createEditorFinder({ now: () => 0 });
    expect(await finder.find('notepadpp', deps({ [NPP]: '' }, appPath))).toBe(NPP);
    // Uninstalled (other file system): the stale hit is not returned.
    const moved = deps({ [NPP_X86]: '' }, {}, {});
    expect(await finder.find('notepadpp', moved)).toBe(NPP_X86);
    expect(moved.asked.length).toBeGreaterThan(0);
    const fresh = deps({ [NPP]: '' }, appPath);
    expect(await finder.refresh('notepadpp', fresh)).toBe(NPP);
    expect(fresh.asked.length).toBeGreaterThan(0);
    const cached = deps({ [NPP]: '' }, appPath);
    expect(await finder.find('notepadpp', cached)).toBe(NPP);
    expect(cached.asked).toEqual([]);
    // A refresh that finds nothing drops the hit.
    expect(await finder.refresh('notepadpp', deps({}))).toBeNull();
    const after = deps({ [NPP]: '' }, appPath);
    expect(await finder.find('notepadpp', after)).toBe(NPP);
    expect(after.asked.length).toBeGreaterThan(0);
  });

  it('resolveEditorExecutable and detectEditors take the finder', async () => {
    const finder = createEditorFinder({ now: () => 0 });
    const d = deps({ [NPP]: '' }, appPath);
    expect(await resolveEditorExecutable(editor(), d, finder.find)).toBe(NPP);
    const asked = d.asked.length;
    expect(await resolveEditorExecutable(editor(), d, finder.find)).toBe(NPP);
    expect(d.asked).toHaveLength(asked);
    expect(await detectEditors(editor(), d, finder.refresh)).toEqual({ notepadpp: NPP, vscode: null, custom: null });
    expect(d.asked.length).toBeGreaterThan(asked);
  });
});

describe('resolveEditorExecutable', () => {
  it('an existing override wins (no registry lookup); a missing one falls back to the detection', async () => {
    const override = 'D:\\Portable\\Notepad++\\notepad++.exe';
    const d = deps({ [override]: '', [NPP]: '' });
    expect(await resolveEditorExecutable(editor({ executable: override }), d)).toBe(override);
    expect(d.asked).toEqual([]);
    expect(await resolveEditorExecutable(editor({ executable: 'D:\\gone\\notepad++.exe' }), d)).toBe(NPP);
  });

  it('custom needs its own existing .exe; EDITOR_NOT_FOUND {preset} otherwise', async () => {
    const custom = 'D:\\Tools\\sublime_text.exe';
    expect(
      await resolveEditorExecutable(
        editor({ preset: 'custom', executable: custom, args: ['{file}'] }),
        deps({ [custom]: '' }),
      ),
    ).toBe(custom);
    expect(
      await errorPayload(
        resolveEditorExecutable(editor({ preset: 'custom', executable: custom, args: ['{file}'] }), deps({})),
      ),
    ).toEqual({
      code: 'EDITOR_NOT_FOUND',
      params: { preset: 'custom' },
    });
    expect(await errorPayload(resolveEditorExecutable(editor(), deps({})))).toEqual({
      code: 'EDITOR_NOT_FOUND',
      params: { preset: 'notepadpp' },
    });
    expect(await errorPayload(resolveEditorExecutable(editor({ preset: 'vscode' }), deps({})))).toEqual({
      code: 'EDITOR_NOT_FOUND',
      params: { preset: 'vscode' },
    });
    expect(
      await errorPayload(resolveEditorExecutable(editor({ preset: 'system' }), deps({ [NPP]: '' }))),
    ).toEqual({
      code: 'EDITOR_NOT_FOUND',
      params: { preset: 'system' },
    });
  });
});

describe('editorArguments', () => {
  const file = 'C:\\My Project\\src\\a $& b.ts';

  it('replaces the placeholders per argument (missing line/col → 1), never joining them', () => {
    expect(editorArguments(editor(), file, 12, 3)).toEqual(['-n12', '-c3', file]);
    expect(editorArguments(editor(), file, null, null)).toEqual(['-n1', '-c1', file]);
    expect(editorArguments(editor({ preset: 'vscode' }), file, 7, null)).toEqual(['--goto', `${file}:7:1`]);
    expect(
      editorArguments(
        editor({
          preset: 'custom',
          executable: 'D:\\x.exe',
          args: ['--line={line}', '{file}', '{col}{col}', 'plain'],
        }),
        file,
        5,
        9,
      ),
    ).toEqual(['--line=5', file, '99', 'plain']);
  });
});

describe('detectEditors (editor.detect)', () => {
  it('both presets and the configured executable', async () => {
    const custom = 'D:\\Tools\\sublime_text.exe';
    expect(
      await detectEditors(
        editor({ preset: 'custom', executable: custom, args: ['{file}'] }),
        deps({ [NPP]: '', [custom]: '' }),
      ),
    ).toEqual({
      notepadpp: NPP,
      vscode: null,
      custom: { executable: custom, exists: true },
    });
    expect(
      await detectEditors(editor({ executable: 'D:\\gone\\notepad++.exe' }), deps({ [CODE_USER]: '' })),
    ).toEqual({
      notepadpp: null,
      vscode: CODE_USER,
      custom: { executable: 'D:\\gone\\notepad++.exe', exists: false },
    });
    expect(await detectEditors(editor(), deps({}))).toEqual({ notepadpp: null, vscode: null, custom: null });
  });
});
