/**
 * Real files of the FakeBackend (Phase 3, WP-52): the plan file of `fake:plan`, the output file of
 * `fake:background` and the workspace of `fake:files` exist on disk, so the file viewer, the
 * Dateien-Panel and the `/api/file` route can open what the fake transcript names. They live ONLY
 * under `<filesRoot>\<sessionId>\` – default `%TEMP%\parallax-fake-files\` – never in a project.
 * Every target is resolved with `@shared/paths` and checked to stay inside that folder before any
 * file system access.
 *
 * WP-103: with the rules of this host (`HOST_PATH_RULES`; a constructor parameter for tests). The
 * scenarios name files Windows-style (`plans\fake-plan.md`); on POSIX a `\` in such a relative path
 * is a separator, too.
 */
import { appendFile, mkdir, readFile, stat, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { structuredPatch } from 'diff';
import type { PathRules } from '@shared/paths';
import { HOST_PATH_RULES } from '../../lib/paths';

export const FAKE_FILES_DIR_NAME = 'parallax-fake-files';

/** The CLI's `structuredPatch` hunks (Write update / Edit results) of old → new text. */
export function patchHunks(oldText: string, newText: string): unknown[] {
  const patch = structuredPatch('a', 'b', oldText, newText, undefined, undefined, { context: 3 });
  return patch.hunks.map((h) => ({
    oldStart: h.oldStart,
    oldLines: h.oldLines,
    newStart: h.newStart,
    newLines: h.newLines,
    lines: h.lines,
  }));
}

/** `%TEMP%\parallax-fake-files` (FakeBackendOptions.filesRoot overrides it, e.g. in tests). */
export function defaultFakeFilesRoot(): string {
  return path.join(os.tmpdir(), FAKE_FILES_DIR_NAME);
}

/** Session ids are UUIDs; anything else must not become a folder name. */
const SESSION_SEGMENT = /^[A-Za-z0-9][A-Za-z0-9_-]{0,99}$/;

/** The real files of one fake session. */
export class FakeFiles {
  /** `<root>\<sessionId>` – every file of the session lies below it. */
  readonly dir: string;

  constructor(
    private readonly root: string,
    sessionId: string,
    private readonly rules: PathRules = HOST_PATH_RULES,
  ) {
    const rootIssue = rules.issue(root);
    if (rootIssue !== null) throw new Error(`fake files root rejected (${rootIssue})`);
    if (!SESSION_SEGMENT.test(sessionId)) throw new Error('fake files: session id is no folder name');
    const dir = rules.resolve(root, sessionId);
    if (dir === null) throw new Error('fake files: session folder rejected');
    this.dir = dir;
  }

  /** Absolute path of `relative` (`plans\fake-plan.md`); throws if it would leave the session folder. */
  path(relative: string): string {
    const rules = this.rules;
    const spelled = rules.flavor === 'win32' ? relative : relative.replaceAll('\\', '/');
    const target = rules.resolve(this.dir, spelled);
    if (target === null || rules.equal(target, this.dir) || !rules.isInside(target, this.dir)) {
      throw new Error(`fake files: ${JSON.stringify(relative)} leaves the session folder`);
    }
    // Defense in depth: the session folder itself must stay inside the root.
    if (!rules.isInside(target, this.root)) throw new Error('fake files: outside the root');
    return target;
  }

  /** Writes (creates or replaces) the file; returns its absolute path. */
  async write(relative: string, content: string): Promise<string> {
    const target = this.path(relative);
    await mkdir(path.dirname(target), { recursive: true });
    await writeFile(target, content, 'utf8');
    return target;
  }

  /** Appends to the file (creates it); returns its absolute path. */
  async append(relative: string, content: string): Promise<string> {
    const target = this.path(relative);
    await mkdir(path.dirname(target), { recursive: true });
    await appendFile(target, content, 'utf8');
    return target;
  }

  async read(relative: string): Promise<string> {
    return readFile(this.path(relative), 'utf8');
  }

  async exists(relative: string): Promise<boolean> {
    try {
      return (await stat(this.path(relative))).isFile();
    } catch {
      return false;
    }
  }
}
