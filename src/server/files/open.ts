/**
 * Program start of `file.open` (ADR-144) behind one seam: the file service checks the path
 * (access policy, kind, extension list) and hands a checked `OpenRequest` to a `ProgramLauncher`.
 * - `createSystemLauncher`: the real one – editor via `spawnGui` (executable from the settings,
 *   App Paths, Uninstall, usual folders – the hit kept for a minute; files/editors.ts; working
 *   folder = the editor's own folder, R5-02), Explorer and the default program via
 *   `spawnExplorer` (lib/process.ts). Visible GUI programs: the approved exception from
 *   `windowsHide: true` (CLAUDE.md "Windows").
 * - `createRecordingOpener`: starts NOTHING, logs `file.open (fake): <target> <path>` and records
 *   the request – WP-60 always wires it with the FakeBackend (dev, E2E, verifier); tests use it too.
 *
 * Linux (WP-106, WP-100 §5.6): the editor from `PATH` via `spawnGui` (POSIX rules), "show in
 * folder" through the file manager's D-Bus interface (`FileManager1`, fallback `xdg-open` on the
 * folder) and the default program through `xdg-open` (system/desktop.ts). A preset Linux does not
 * offer (`notepadpp`) opens like `system` – the default program, only for the extensions of
 * `isDefaultProgramAllowed` (requested and physical path, else FILE_TYPE_BLOCKED).
 */
import path from 'node:path';
import type { Logger } from 'pino';
import { makeError } from '@shared/errors';
import { isDefaultProgramAllowed, type EditorSettings } from '@shared/model';
import { POSIX_PATHS } from '@shared/paths';
import { logger as rootLogger } from '../lib/logger';
import { spawnExplorer, spawnGui, type GuiSpawnFn, type RunFileFn } from '../lib/process';
import { regKeyQuery, regQuery, type RegKeyQuery, type RegQuery } from '../lib/registry';
import { nodeFsProbe, type FsProbe } from '../lib/windows';
import { CommandError } from '../sync/ports';
import { showInFileManager, xdgOpen } from '../system/desktop';
import {
  createEditorFinder,
  detectEditors,
  editorArguments,
  effectiveEditorPreset,
  resolveEditorExecutable,
  type EditorDetection,
  type EditorLocatorDeps,
  type FindEditor,
} from './editors';

/** What the launcher starts (already checked by the file service). */
export interface OpenRequest {
  /**
   * `editor` = the configured editor (never preset `system`: that becomes `default`), `explorer` =
   * show in Explorer (file selected or folder opened), `default` = `explorer.exe "<file>"`.
   */
  target: 'editor' | 'explorer' | 'default';
  /** As requested (logs). */
  path: string;
  /** Physical path (after links) – the one that is started or shown. */
  realPath: string;
  directory: boolean;
  line: number | null;
  col: number | null;
  /** `settings().editor` at the time of the click. */
  editor: EditorSettings;
}

export interface ProgramLauncher {
  /** Throws CommandError (EDITOR_NOT_FOUND, OPEN_FAILED). */
  open(request: OpenRequest): Promise<void>;
  /** `editor.detect`. */
  detect(editor: EditorSettings): Promise<EditorDetection>;
}

export interface SystemLauncherDeps {
  regQuery?: RegQuery;
  regKeyQuery?: RegKeyQuery;
  /** Existence checks of executables (default: the guarded real file system). */
  probe?: FsProbe;
  /** Base environment of lookups and started programs (default `process.env`). */
  env?: NodeJS.ProcessEnv;
  spawn?: GuiSpawnFn;
  readHead?: (file: string, length: number) => Promise<Uint8Array>;
  /** Linux: the target of the editor's link (`spawnGui`, default `fs.realpath`). */
  realpath?: (file: string) => Promise<string>;
  platform?: NodeJS.Platform;
  /** Clock of the editor lookup cache (R5-04; default `Date.now`). */
  now?: () => number;
  /** WP-106 (Linux): runner of `gdbus` for "show in folder" (default `runFile`). */
  run?: RunFileFn;
}

/** Linux (WP-106): editor, file manager and default program (see the file comment). */
function linuxOpen(
  request: OpenRequest,
  deps: SystemLauncherDeps,
  locator: EditorLocatorDeps,
  find: FindEditor,
): Promise<void> {
  const desktop = {
    ...(deps.env === undefined ? {} : { env: deps.env }),
    ...(deps.spawn === undefined ? {} : { spawn: deps.spawn }),
    ...(deps.run === undefined ? {} : { run: deps.run }),
  };
  if (request.target === 'explorer') return showInFileManager(request.realPath, request.directory, desktop);
  const asSystem =
    request.target === 'editor' && effectiveEditorPreset(request.editor.preset, 'linux') === 'system';
  if (request.target === 'default' || asSystem) {
    if (
      !isDefaultProgramAllowed(request.path, POSIX_PATHS) ||
      !isDefaultProgramAllowed(request.realPath, POSIX_PATHS)
    ) {
      return Promise.reject(new CommandError(makeError('FILE_TYPE_BLOCKED')));
    }
    return xdgOpen(request.realPath, desktop);
  }
  return (async () => {
    const executable = await resolveEditorExecutable(request.editor, locator, find);
    const args = editorArguments(request.editor, request.realPath, request.line, request.col);
    await spawnGui(executable, args, {
      ...(deps.env === undefined ? {} : { env: deps.env }),
      ...(deps.spawn === undefined ? {} : { spawn: deps.spawn }),
      ...(deps.realpath === undefined ? {} : { realpath: deps.realpath }),
      platform: 'linux',
      cwd: path.posix.dirname(executable),
    });
  })();
}

export function createSystemLauncher(deps: SystemLauncherDeps = {}): ProgramLauncher {
  const env = deps.env ?? process.env;
  const platform = deps.platform ?? process.platform;
  const locator: EditorLocatorDeps = {
    regQuery: deps.regQuery ?? regQuery(),
    regKeyQuery: deps.regKeyQuery ?? regKeyQuery(),
    fs: deps.probe ?? nodeFsProbe,
    env,
    platform,
  };
  // R5-04: a click reuses the editor found within the last minute; `editor.detect` looks afresh.
  const editorFinder = createEditorFinder({ now: deps.now });
  const gui = { env, spawn: deps.spawn, platform: deps.platform };
  return {
    async open(request) {
      if (platform === 'linux') {
        await linuxOpen(request, deps, locator, editorFinder.find);
        return;
      }
      if (request.target === 'editor') {
        const executable = await resolveEditorExecutable(request.editor, locator, editorFinder.find);
        const args = editorArguments(request.editor, request.realPath, request.line, request.col);
        await spawnGui(executable, args, {
          ...gui,
          // R5-02: the editor's own folder, never the (possibly foreign) project folder – Windows
          // also searches the working folder for DLLs. The file goes along as an absolute argument.
          cwd: path.win32.dirname(executable),
          readHead: deps.readHead,
        });
        return;
      }
      if (request.target === 'explorer') {
        await spawnExplorer(request.realPath, request.directory ? 'open' : 'select', gui);
        return;
      }
      await spawnExplorer(request.realPath, 'open', gui);
    },
    detect: (editor) => detectEditors(editor, locator, editorFinder.refresh),
  };
}

export interface RecordingOpenerOptions {
  logger?: Logger;
  /** Answer of `editor.detect` (default: nothing installed, a configured executable missing). */
  detection?: EditorDetection;
}

export interface RecordingOpener extends ProgramLauncher {
  /** Every request, in order. */
  readonly calls: OpenRequest[];
}

/** Fake launcher: records and logs, never starts a program (see the file comment). */
export function createRecordingOpener(options: RecordingOpenerOptions = {}): RecordingOpener {
  const log = (options.logger ?? rootLogger).child({ module: 'files.open' });
  const calls: OpenRequest[] = [];
  return {
    calls,
    open(request) {
      calls.push(request);
      log.info(`file.open (fake): ${request.target} ${request.path}`);
      return Promise.resolve();
    },
    detect(editor) {
      return Promise.resolve(
        options.detection ?? {
          notepadpp: null,
          vscode: null,
          custom: editor.executable === null ? null : { executable: editor.executable, exists: false },
        },
      );
    },
  };
}
