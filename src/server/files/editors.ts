/**
 * Editor presets of "Open in editor" (ADR-144; Notepad++ is the default, F3): where the program
 * is installed and with which arguments it opens a file at a line. Lookup order per preset:
 * override path from the settings → App Paths (HKCU, then HKLM 64/32 bit) → Uninstall
 * `InstallLocation` → the usual install folders. Every candidate must be an existing, absolute,
 * safe `.exe` with the preset's file name and not on the block list (`editorExecutableIssue`);
 * registry values are never trusted beyond that. Reads only (reg.exe query, file stat).
 */
import path from 'node:path';
import { makeError } from '@shared/errors';
import { EDITOR_PRESET_ARGS, editorExecutableIssue, type EditorSettings } from '@shared/model';
import { windowsBaseName } from '@shared/paths';
import type { CommandResult } from '@shared/protocol';
import {
  expandRegValue,
  parseRegDefaultValue,
  parseRegValues,
  type RegKeyQuery,
  type RegQuery,
} from '../lib/registry';
import { getEnvVar, type FsProbe } from '../lib/windows';
import { CommandError } from '../sync/ports';

export type EditorDetection = CommandResult<'editor.detect'>;
export type DetectablePreset = 'notepadpp' | 'vscode';

/** File name of each preset's executable. */
export const EDITOR_EXE_NAMES: Readonly<Record<DetectablePreset, string>> = {
  notepadpp: 'notepad++.exe',
  vscode: 'Code.exe',
};

const APP_PATHS_KEY = 'SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\App Paths';
const UNINSTALL_KEY = 'SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\Uninstall';

/** Uninstall keys of the installers (VS Code: user and system setup, x64). */
const UNINSTALL_NAMES: Readonly<Record<DetectablePreset, readonly string[]>> = {
  notepadpp: ['Notepad++'],
  vscode: ['{771FD6B0-FA20-440A-A002-3B3BAC16DC50}_is1', '{EA457B21-F73E-494C-ACAB-524FDE069978}_is1'],
};

/** Usual install folders: [environment variable, folders below it]. */
const STANDARD_PATHS: Readonly<Record<DetectablePreset, readonly (readonly [string, string])[]>> = {
  notepadpp: [
    ['ProgramFiles', 'Notepad++'],
    ['ProgramFiles(x86)', 'Notepad++'],
  ],
  vscode: [
    ['LOCALAPPDATA', 'Programs\\Microsoft VS Code'],
    ['ProgramFiles', 'Microsoft VS Code'],
  ],
};

const HIVES = [
  ['HKCU', 64],
  ['HKLM', 64],
  ['HKLM', 32],
] as const;

export interface EditorLocatorDeps {
  regQuery: RegQuery;
  regKeyQuery: RegKeyQuery;
  fs: FsProbe;
  env: Readonly<Record<string, string | undefined>>;
}

/** An acceptable, existing executable (any name; the preset lookup also checks the name). */
async function usableExecutable(candidate: string, fs: FsProbe): Promise<boolean> {
  if (editorExecutableIssue(candidate) !== null) return false;
  return fs.isFile(candidate);
}

async function presetCandidate(candidate: string, preset: DetectablePreset, fs: FsProbe): Promise<boolean> {
  if (windowsBaseName(candidate).toLowerCase() !== EDITOR_EXE_NAMES[preset].toLowerCase()) return false;
  return usableExecutable(candidate, fs);
}

/** The installed executable of a preset (registry, then the usual folders), or null. */
export async function findEditor(preset: DetectablePreset, deps: EditorLocatorDeps): Promise<string | null> {
  const exe = EDITOR_EXE_NAMES[preset];
  const candidates: string[] = [];
  for (const [hive, view] of HIVES) {
    const output = await deps.regQuery(`${hive}\\${APP_PATHS_KEY}\\${exe}`, view);
    const value = output === null ? null : parseRegDefaultValue(output, deps.env);
    if (value !== null) candidates.push(value);
  }
  for (const name of UNINSTALL_NAMES[preset]) {
    for (const [hive, view] of HIVES) {
      const output = await deps.regKeyQuery(`${hive}\\${UNINSTALL_KEY}\\${name}`, view);
      if (output === null) continue;
      const location = parseRegValues(output).find(
        (value) =>
          value.name.toLowerCase() === 'installlocation' &&
          (value.type === 'REG_SZ' || value.type === 'REG_EXPAND_SZ'),
      );
      if (location === undefined) continue;
      const raw = location.data.trim().replace(/^"(.*)"$/, '$1');
      const folder = location.type === 'REG_EXPAND_SZ' ? expandRegValue(raw, deps.env) : raw;
      // path.win32.join on an unsafe folder would only give an unsafe candidate: the check drops it.
      if (folder !== '') candidates.push(path.win32.join(folder, exe));
    }
  }
  for (const [variable, folder] of STANDARD_PATHS[preset]) {
    const root = getEnvVar(deps.env, variable);
    if (root !== undefined && root !== '') candidates.push(path.win32.join(root, folder, exe));
  }
  for (const candidate of candidates) {
    if (await presetCandidate(candidate, preset, deps.fs)) return candidate;
  }
  return null;
}

/**
 * Executable for "Open in editor" (preset `notepadpp`/`vscode`/`custom`; `system` never gets here):
 * an existing override wins, otherwise the detected install; `custom` needs its own `.exe`.
 * Missing → EDITOR_NOT_FOUND {preset}.
 */
export async function resolveEditorExecutable(
  editor: EditorSettings,
  deps: EditorLocatorDeps,
): Promise<string> {
  const notFound = (): CommandError =>
    new CommandError(makeError('EDITOR_NOT_FOUND', { preset: editor.preset }));
  if (editor.preset === 'system') throw notFound();
  if (editor.executable !== null && (await usableExecutable(editor.executable, deps.fs)))
    return editor.executable;
  if (editor.preset === 'custom') throw notFound();
  const found = await findEditor(editor.preset, deps);
  if (found === null) throw notFound();
  return found;
}

/**
 * Arguments of the editor: the preset template or `custom.args`, placeholders replaced PER
 * ARGUMENT (`{file}`, `{line}`, `{col}`; a missing line/col is 1) – never joined into one command
 * line, so a path with spaces stays one argument.
 */
export function editorArguments(
  editor: EditorSettings,
  file: string,
  line: number | null,
  col: number | null,
): string[] {
  const template: readonly string[] =
    editor.preset === 'notepadpp' || editor.preset === 'vscode'
      ? EDITOR_PRESET_ARGS[editor.preset]
      : editor.args;
  const lineText = String(line ?? 1);
  const colText = String(col ?? 1);
  return template.map((arg) =>
    arg.replace(/\{(file|line|col)\}/g, (_whole, name: string) =>
      name === 'file' ? file : name === 'line' ? lineText : colText,
    ),
  );
}

/** `editor.detect`: both presets searched; a configured executable (custom or override) checked. */
export async function detectEditors(
  editor: EditorSettings,
  deps: EditorLocatorDeps,
): Promise<EditorDetection> {
  const [notepadpp, vscode] = await Promise.all([findEditor('notepadpp', deps), findEditor('vscode', deps)]);
  const custom =
    editor.executable === null
      ? null
      : { executable: editor.executable, exists: await usableExecutable(editor.executable, deps.fs) };
  return { notepadpp, vscode, custom };
}
