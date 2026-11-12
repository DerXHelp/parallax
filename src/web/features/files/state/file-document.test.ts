import { describe, expect, it, vi } from 'vitest';
import { makeError } from '@shared/errors';
import type { FileInfo } from '@shared/model';
import { SAMPLE_IDS, sampleFileInfo } from '@shared/samples';
import { ClientCommandError } from '@web/state/connection';
import { FileDocumentLoader, type FileStatter } from './file-document';
import { FileLoadError, type FileRef, type FileSource } from './file-source';
import { FILES_SESSION_KEY } from '../testing';

const FILE: FileRef = {
  sessionKey: FILES_SESSION_KEY,
  entryId: SAMPLE_IDS.entry,
  path: sampleFileInfo().path,
};

/** A loader over a switchable stat answer and text (no host, no server). */
function setup() {
  let info: FileInfo | null = sampleFileInfo();
  let text: string | null = 'export const a = 1;';
  const stat = vi.fn<FileStatter>(() =>
    info === null
      ? Promise.reject(new ClientCommandError(makeError('FILE_NOT_FOUND')))
      : Promise.resolve(info),
  );
  const source: FileSource = {
    text: () =>
      text === null ? Promise.reject(new FileLoadError(makeError('FILE_NOT_FOUND'))) : Promise.resolve(text),
    url: () => 'fake:///file',
  };
  const loader = new FileDocumentLoader(FILE, { stat, source: () => source });
  const listener = vi.fn();
  loader.subscribe(listener);
  return {
    loader,
    listener,
    stat,
    setInfo: (next: FileInfo | null) => {
      info = next;
    },
    setText: (next: string | null) => {
      text = next;
    },
  };
}

describe('FileDocumentLoader (WP-54, R5W-10, V4-06 c)', () => {
  it('a deleted file: the error marks the shown state as stale; the same failure again changes nothing', async () => {
    const { loader, listener, setInfo, stat } = setup();
    await loader.poll();
    expect(loader.getSnapshot()).toMatchObject({ text: 'export const a = 1;', error: null, stale: false });

    setInfo(null);
    await loader.poll();
    const failed = loader.getSnapshot();
    expect(failed).toMatchObject({
      error: { code: 'FILE_NOT_FOUND' },
      stale: true,
      text: 'export const a = 1;',
    });
    expect(failed.info).not.toBeNull();
    const calls = listener.mock.calls.length;

    // The 2 s poll keeps failing the same way: no new state, no notification (no re-render).
    await loader.poll();
    await loader.poll();
    expect(stat).toHaveBeenCalledTimes(4);
    expect(listener).toHaveBeenCalledTimes(calls);
    expect(loader.getSnapshot()).toBe(failed);

    // Back again: current state, no longer stale.
    setInfo(sampleFileInfo({ mtimeMs: sampleFileInfo().mtimeMs + 1000 }));
    await loader.poll();
    expect(loader.getSnapshot()).toMatchObject({ error: null, stale: false });
  });

  it('a failure without an earlier answer is not stale; another failure is a new state', async () => {
    const { loader, listener, setInfo, stat } = setup();
    setInfo(null);
    await loader.poll();
    expect(loader.getSnapshot()).toMatchObject({
      info: null,
      error: { code: 'FILE_NOT_FOUND' },
      stale: false,
    });
    const calls = listener.mock.calls.length;
    stat.mockImplementationOnce(() =>
      Promise.reject(new ClientCommandError(makeError('PATH_NOT_ALLOWED', { path: FILE.path }))),
    );
    await loader.poll();
    expect(loader.getSnapshot().error?.code).toBe('PATH_NOT_ALLOWED');
    expect(listener).toHaveBeenCalledTimes(calls + 1);
  });

  it('a failed text load keeps an older text as the last known state', async () => {
    const { loader, setInfo, setText } = setup();
    await loader.poll();
    setInfo(sampleFileInfo({ bytes: 99 }));
    setText(null);
    await loader.poll();
    expect(loader.getSnapshot()).toMatchObject({
      info: { bytes: 99 },
      text: 'export const a = 1;',
      error: { code: 'FILE_NOT_FOUND' },
      stale: true,
    });
  });
});
