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
 */
import path from 'node:path';
import type { Logger } from 'pino';
import type { EditorSettings } from '@shared/model';
import { logger as rootLogger } from '../lib/logger';
import { spawnExplorer, spawnGui, type GuiSpawnFn } from '../lib/process';
import { regKeyQuery, regQuery, type RegKeyQuery, type RegQuery } from '../lib/registry';
import { nodeFsProbe, type FsProbe } from '../lib/windows';
import {
  createEditorFinder,
  detectEditors,
  editorArguments,
  resolveEditorExecutable,
  type EditorDetection,
  type EditorLocatorDeps,
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
  platform?: NodeJS.Platform;
  /** Clock of the editor lookup cache (R5-04; default `Date.now`). */
  now?: () => number;
}

export function createSystemLauncher(deps: SystemLauncherDeps = {}): ProgramLauncher {
  const env = deps.env ?? process.env;
  const locator: EditorLocatorDeps = {
    regQuery: deps.regQuery ?? regQuery(),
    regKeyQuery: deps.regKeyQuery ?? regKeyQuery(),
    fs: deps.probe ?? nodeFsProbe,
    env,
  };
  // R5-04: a click reuses the editor found within the last minute; `editor.detect` looks afresh.
  const editorFinder = createEditorFinder({ now: deps.now });
  const gui = { env, spawn: deps.spawn, platform: deps.platform };
  return {
    async open(request) {
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
