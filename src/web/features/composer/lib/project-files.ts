import type { EntryId } from '@shared/common';
import { sendCommand } from '@web/state/hooks';

/**
 * Source of the @ picker (ADR-151): `files.project` of the session's host – the files below the
 * cwd, relative with `/`, at most `LIMITS.projectFilesMax` (`truncated`). Asked once per opening of
 * the picker (the server caches 30 s). Rejects with the `ClientCommandError` of the command
 * (`errorPayloadOf`). The loader is replaceable (playground: delays and failures without a server).
 */

export interface ProjectFiles {
  files: readonly string[];
  truncated: boolean;
}

export type ProjectFilesLoader = (sessionKey: string, entryId: EntryId) => Promise<ProjectFiles>;

export const commandLoader: ProjectFilesLoader = async (sessionKey, entryId) => {
  const result = await sendCommand(sessionKey, { name: 'files.project', entryId });
  return { files: result.files, truncated: result.truncated };
};

let loader: ProjectFilesLoader = commandLoader;

/** Replaces the loader (playground); `null` restores the command. */
export function setProjectFilesLoader(next: ProjectFilesLoader | null): void {
  loader = next ?? commandLoader;
}

export function loadProjectFiles(sessionKey: string, entryId: EntryId): Promise<ProjectFiles> {
  return loader(sessionKey, entryId);
}
