/**
 * Editor presets of "Open in editor" (ADR-144; Notepad++ is the default, F3): where the program
 * is installed and with which arguments it opens a file at a line. Lookup order per preset:
 * override path from the settings → App Paths (HKCU, then HKLM 64/32 bit) → Uninstall
 * `InstallLocation` → the usual install folders. Every candidate must be an existing, absolute,
 * safe `.exe` with the preset's file name and not on the block list (`editorExecutableIssue`);
 * registry values are never trusted beyond that. Reads only (reg.exe query, file stat). Each
 * candidate is checked as soon as it is known (no query after the first hit); a launcher keeps
 * the hit per preset for a minute (`createEditorFinder`, R5-04).
 *
 * Linux (WP-106, WP-100 §5.6): the presets of `editorPresetsFor('posix')` are found on `PATH`
 * (`LINUX_EDITOR_NAMES`: `code`, `codium`, `zed`/`zeditor`, `subl`, `kate`, `gnome-text-editor`,
 * `gedit`) – absolute executable files after the POSIX rules, never a bare name. A preset the
 * platform does not offer (`notepadpp` on Linux) counts as `system` (`effectiveEditorPreset`, the
 * default program). `editor.detect` (contract: Notepad++, VS Code, custom) answers `notepadpp: null`.
 */
import path from 'node:path';
import { makeError } from '@shared/errors';
import {
  EDITOR_PRESET_ARGS,
  editorExecutableIssue,
  editorPresetsFor,
  type EditorPreset,
  type EditorProgramPreset,
  type EditorSettings,
} from '@shared/model';
import { POSIX_PATHS, WIN32_PATHS, pathFlavorOf, windowsBaseName, type PathRules } from '@shared/paths';
import type { CommandResult } from '@shared/protocol';
import { searchPosixPath } from '../lib/executables';
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
/** The presets of the Windows lookup (registry, install folders). */
export type DetectablePreset = 'notepadpp' | 'vscode';

/** WP-106: program names of each preset on a Linux `PATH`, in lookup order (none: not offered). */
export const LINUX_EDITOR_NAMES: Readonly<Record<EditorProgramPreset, readonly string[]>> = {
  notepadpp: [],
  vscode: ['code'],
  vscodium: ['codium'],
  zed: ['zed', 'zeditor'],
  sublime: ['subl'],
  kate: ['kate'],
  gnome_text_editor: ['gnome-text-editor'],
  gedit: ['gedit'],
};

/** The preset that applies on `platform`: one the platform does not offer counts as `system`. */
export function effectiveEditorPreset(preset: EditorPreset, platform: NodeJS.Platform): EditorPreset {
  return editorPresetsFor(pathFlavorOf(platform)).includes(preset) ? preset : 'system';
}

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
  /** WP-106: which lookup (default `process.platform`; Linux: `PATH`). */
  platform?: NodeJS.Platform;
}

function isWindows(deps: EditorLocatorDeps): boolean {
  return (deps.platform ?? process.platform) === 'win32';
}

function rulesOf(deps: EditorLocatorDeps): PathRules {
  return isWindows(deps) ? WIN32_PATHS : POSIX_PATHS;
}

/**
 * An acceptable, existing executable (any name; the preset lookup also checks the name). POSIX: an
 * executable file after the POSIX rules.
 */
async function usableExecutable(candidate: string, deps: EditorLocatorDeps): Promise<boolean> {
  const rules = rulesOf(deps);
  if (editorExecutableIssue(candidate, rules) !== null) return false;
  if (rules === POSIX_PATHS && deps.fs.isExecutable !== undefined) return deps.fs.isExecutable(candidate);
  return deps.fs.isFile(candidate);
}

async function presetCandidate(
  candidate: string,
  preset: EditorProgramPreset,
  deps: EditorLocatorDeps,
): Promise<boolean> {
  if (!isWindows(deps)) {
    if (!LINUX_EDITOR_NAMES[preset].includes(path.posix.basename(candidate))) return false;
    return usableExecutable(candidate, deps);
  }
  if (preset !== 'notepadpp' && preset !== 'vscode') return false;
  if (windowsBaseName(candidate).toLowerCase() !== EDITOR_EXE_NAMES[preset].toLowerCase()) return false;
  return usableExecutable(candidate, deps);
}

/**
 * Candidates of a preset in lookup order, produced lazily: the caller checks each one at once, so
 * no further `reg.exe` starts after the first hit (R5-04).
 */
async function* editorCandidates(preset: DetectablePreset, deps: EditorLocatorDeps): AsyncGenerator<string> {
  const exe = EDITOR_EXE_NAMES[preset];
  for (const [hive, view] of HIVES) {
    const output = await deps.regQuery(`${hive}\\${APP_PATHS_KEY}\\${exe}`, view);
    const value = output === null ? null : parseRegDefaultValue(output, deps.env);
    if (value !== null) yield value;
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
      if (folder !== '') yield path.win32.join(folder, exe);
    }
  }
  for (const [variable, folder] of STANDARD_PATHS[preset]) {
    const root = getEnvVar(deps.env, variable, 'win32');
    if (root !== undefined && root !== '') yield path.win32.join(root, folder, exe);
  }
}

/** WP-106: the preset's programs on `PATH` (executable, POSIX rules), in name and `PATH` order. */
async function* linuxEditorCandidates(
  preset: EditorProgramPreset,
  deps: EditorLocatorDeps,
): AsyncGenerator<string> {
  for (const name of LINUX_EDITOR_NAMES[preset]) yield* await searchPosixPath(name, deps.env, deps.fs);
}

/**
 * The installed executable of a preset (Windows: registry, then the usual folders; Linux: `PATH`),
 * or null – also for a preset the platform does not offer.
 */
export async function findEditor(
  preset: EditorProgramPreset,
  deps: EditorLocatorDeps,
): Promise<string | null> {
  if (!isWindows(deps)) {
    for await (const candidate of linuxEditorCandidates(preset, deps)) {
      if (await presetCandidate(candidate, preset, deps)) return candidate;
    }
    return null;
  }
  if (preset !== 'notepadpp' && preset !== 'vscode') return null;
  for await (const candidate of editorCandidates(preset, deps)) {
    if (await presetCandidate(candidate, preset, deps)) return candidate;
  }
  return null;
}

export type FindEditor = (preset: EditorProgramPreset, deps: EditorLocatorDeps) => Promise<string | null>;

/** How long a found editor is reused without a new lookup (R5-04). */
export const EDITOR_CACHE_MS = 60_000;

export interface EditorFinder {
  /**
   * `findEditor` with the last hit per preset for `ttlMs` – reused only while it is still an
   * acceptable existing `.exe` (one stat); a miss is never cached (a fresh install is found at once).
   */
  find: FindEditor;
  /** Always a fresh lookup (`editor.detect`, the settings dialog); its result replaces the cached one. */
  refresh: FindEditor;
}

/** The editor lookup of one launcher (R5-04: at most one registry search per preset and minute). */
export function createEditorFinder(options: { ttlMs?: number; now?: () => number } = {}): EditorFinder {
  const ttlMs = options.ttlMs ?? EDITOR_CACHE_MS;
  const now = options.now ?? Date.now;
  const hits = new Map<EditorProgramPreset, { executable: string; at: number }>();
  const refresh: FindEditor = async (preset, deps) => {
    const found = await findEditor(preset, deps);
    if (found === null) hits.delete(preset);
    else hits.set(preset, { executable: found, at: now() });
    return found;
  };
  return {
    refresh,
    async find(preset, deps) {
      const hit = hits.get(preset);
      if (
        hit !== undefined &&
        now() - hit.at < ttlMs &&
        (await presetCandidate(hit.executable, preset, deps))
      )
        return hit.executable;
      return refresh(preset, deps);
    },
  };
}

/**
 * Executable for "Open in editor" (a program preset or `custom`; `system` never gets here):
 * an existing override wins, otherwise the detected install (`find`, default an uncached lookup);
 * `custom` needs its own `.exe` (Linux: an executable file). A preset the platform does not offer →
 * EDITOR_NOT_FOUND (the launcher opens it as `system` before, `effectiveEditorPreset`). Missing →
 * EDITOR_NOT_FOUND {preset}.
 */
export async function resolveEditorExecutable(
  editor: EditorSettings,
  deps: EditorLocatorDeps,
  find: FindEditor = findEditor,
): Promise<string> {
  const notFound = (): CommandError =>
    new CommandError(makeError('EDITOR_NOT_FOUND', { preset: editor.preset }));
  if (editor.preset === 'system') throw notFound();
  if (editor.executable !== null && (await usableExecutable(editor.executable, deps)))
    return editor.executable;
  if (editor.preset === 'custom') throw notFound();
  if (effectiveEditorPreset(editor.preset, deps.platform ?? process.platform) !== editor.preset)
    throw notFound();
  const found = await find(editor.preset, deps);
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
    editor.preset === 'custom' || editor.preset === 'system'
      ? editor.args
      : EDITOR_PRESET_ARGS[editor.preset];
  const lineText = String(line ?? 1);
  const colText = String(col ?? 1);
  return template.map((arg) =>
    arg.replace(/\{(file|line|col)\}/g, (_whole, name: string) =>
      name === 'file' ? file : name === 'line' ? lineText : colText,
    ),
  );
}

/**
 * `editor.detect`: both presets searched (`find`, default an uncached lookup); a configured
 * executable (custom or override) checked. Linux: no Notepad++ (`null`), VS Code on `PATH`.
 */
export async function detectEditors(
  editor: EditorSettings,
  deps: EditorLocatorDeps,
  find: FindEditor = findEditor,
): Promise<EditorDetection> {
  const [notepadpp, vscode] = await Promise.all([find('notepadpp', deps), find('vscode', deps)]);
  const custom =
    editor.executable === null
      ? null
      : { executable: editor.executable, exists: await usableExecutable(editor.executable, deps) };
  return { notepadpp, vscode, custom };
}
