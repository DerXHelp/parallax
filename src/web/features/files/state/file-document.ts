import { useEffect, useRef, useState, useSyncExternalStore } from 'react';
import { parseSessionKey } from '@shared/common';
import { makeError, type ErrorPayload } from '@shared/errors';
import type { FileInfo } from '@shared/model';
import { errorPayloadOf } from '@web/state/connection';
import { sendCommand } from '@web/state/hooks';
import { getFileSource, loadErrorOf, type FileRef, type FileSource } from './file-source';
import { useFileWriteStamp } from './file-tools';

/**
 * One file in the viewer (WP-54, ADR-142/143): metadata through `file.stat` (WebSocket), the text of
 * text/Markdown files through the `FileSource` (GET /api/file). Live: `poll()` every 2 s while the
 * viewer tab and the page are visible – content is fetched again only when `mtimeMs`/`bytes`/`kind`
 * changed; `reload()` right after a finished write tool on the same file. Images and PDFs are not
 * fetched here (`<img>`/`<iframe>` load the URL); `version` changes with every new content, the
 * viewer remounts them with it as `key`.
 */

export const FILE_POLL_MS = 2000;

export interface FileDocument {
  /** Last answer of file.stat; null before the first one (and when it failed at once). */
  info: FileInfo | null;
  /** Text of a previewable text/Markdown file (maybe cut, see `info.truncated`); null otherwise. */
  text: string | null;
  /** Failure of the last stat/load (shown above an older content when there is one). */
  error: ErrorPayload | null;
  /**
   * The shown metadata/content are the last known state, not the current one: the last stat or
   * load failed after an earlier success (e.g. the file was deleted; V4-06 c).
   */
  stale: boolean;
  /** True until the first load finished (successfully or not). */
  loading: boolean;
  /** A load is under way (refresh button, `aria-busy`). */
  busy: boolean;
  /** +1 for every new content (key of `<img>`/`<iframe>`; text views keep their scroll position). */
  version: number;
}

const INITIAL: FileDocument = {
  info: null,
  text: null,
  error: null,
  stale: false,
  loading: true,
  busy: false,
  version: 0,
};

/** Reads metadata; rejects with the server's ErrorPayload wrapped in ClientCommandError. */
export type FileStatter = (file: FileRef) => Promise<FileInfo>;

const statOverHost: FileStatter = async (file) => {
  const { file: info } = await sendCommand(file.sessionKey, {
    name: 'file.stat',
    entryId: file.entryId,
    path: file.path,
  });
  return info;
};

function needsText(info: FileInfo): boolean {
  return (info.kind === 'text' || info.kind === 'markdown') && info.previewable;
}

function sameContent(a: FileInfo, b: FileInfo): boolean {
  return (
    a.mtimeMs === b.mtimeMs && a.bytes === b.bytes && a.kind === b.kind && a.previewable === b.previewable
  );
}

function sameError(a: ErrorPayload | null, b: ErrorPayload): boolean {
  return a !== null && a.code === b.code && JSON.stringify(a.params) === JSON.stringify(b.params);
}

export interface FileDocumentDeps {
  stat?: FileStatter;
  /** Read per load, so `setFileSource` takes effect without a remount. */
  source?: () => FileSource;
}

export class FileDocumentLoader {
  private state: FileDocument = INITIAL;
  private readonly listeners = new Set<() => void>();
  private readonly stat: FileStatter;
  private readonly source: () => FileSource;
  /** Identifies the current load; answers of older loads are dropped. */
  private sequence = 0;
  private inFlight = false;
  private abort: AbortController | null = null;

  constructor(
    readonly file: FileRef,
    deps: FileDocumentDeps = {},
  ) {
    this.stat = deps.stat ?? statOverHost;
    this.source = deps.source ?? getFileSource;
  }

  readonly subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };

  readonly getSnapshot = (): FileDocument => this.state;

  /** Live check: stat, content only when it changed. Skipped while a load is under way. */
  poll(): Promise<void> {
    if (this.inFlight) return Promise.resolve();
    return this.load(false);
  }

  /** Stat and content now (refresh button, finished write tool); replaces a running load. */
  reload(): Promise<void> {
    return this.load(true);
  }

  /** Drops the running load (unmount); a later poll/reload starts a new one. */
  stop(): void {
    this.sequence++;
    this.abort?.abort();
    this.abort = null;
    this.inFlight = false;
  }

  private async load(force: boolean): Promise<void> {
    this.stop();
    const sequence = this.sequence;
    this.inFlight = true;
    if (force) this.update({ busy: true });
    const current = () => sequence === this.sequence;
    let info: FileInfo;
    try {
      info = await this.stat(this.file);
    } catch (error) {
      if (!current()) return;
      this.inFlight = false;
      const payload = errorPayloadOf(error);
      const stale = this.state.info !== null;
      const { state } = this;
      // The same failure again (poll every 2 s on a deleted file): no new state, no re-render (R5W-10).
      if (sameError(state.error, payload) && !state.loading && !state.busy && state.stale === stale) return;
      this.update({ error: payload, stale, loading: false, busy: false });
      return;
    }
    if (!current()) return;
    const previous = this.state.info;
    const changed = previous === null || !sameContent(previous, info);
    if (!force && !changed) {
      this.inFlight = false;
      // Unchanged: no new state (no re-render every 2 s), except to clear an earlier failure.
      if (this.state.error !== null || this.state.loading) {
        this.update({ info, error: null, stale: false, loading: false });
      }
      return;
    }
    if (!needsText(info)) {
      this.inFlight = false;
      this.update({
        info,
        text: null,
        error: null,
        stale: false,
        loading: false,
        busy: false,
        version: this.state.version + 1,
      });
      return;
    }
    const controller = new AbortController();
    this.abort = controller;
    if (!force) this.update({ busy: true });
    try {
      const text = await this.source().text(this.file, controller.signal);
      if (!current()) return;
      this.update({
        info,
        text,
        error: null,
        stale: false,
        loading: false,
        busy: false,
        version: this.state.version + 1,
      });
    } catch (error) {
      if (!current()) return;
      // Metadata are current; an older text stays visible as the last known state.
      this.update({
        info,
        error: loadErrorOf(error),
        stale: this.state.text !== null,
        loading: false,
        busy: false,
      });
    } finally {
      if (current()) {
        this.inFlight = false;
        this.abort = null;
      }
    }
  }

  private update(patch: Partial<FileDocument>): void {
    this.state = { ...this.state, ...patch };
    for (const listener of [...this.listeners]) listener();
  }
}

function subscribeVisibility(listener: () => void): () => void {
  document.addEventListener('visibilitychange', listener);
  return () => {
    document.removeEventListener('visibilitychange', listener);
  };
}

/** `document.visibilityState === 'visible'` as a reactive value. */
export function usePageVisible(): boolean {
  return useSyncExternalStore(subscribeVisibility, () => document.visibilityState === 'visible');
}

export interface UseFileDocumentOptions {
  /** The viewer is visible (its tab is open); polling also needs a visible page. */
  active?: boolean;
  deps?: FileDocumentDeps;
}

export interface FileDocumentHandle extends FileDocument {
  /** The resolved reference (null: the session key cannot be parsed). */
  file: FileRef | null;
  refresh: () => void;
  /** URL of the content for `<img>`, `<iframe>` and "Download". */
  url: string | null;
}

const NO_FILE: FileDocument = {
  ...INITIAL,
  loading: false,
  error: makeError('VALIDATION_FAILED', { path: 'sessionKey' }),
};

/**
 * The viewer's file: loads on mount, polls every FILE_POLL_MS while `active` and the page is
 * visible (one poll right away when it becomes visible again), reloads after a finished
 * Write/Edit/MultiEdit/NotebookEdit on the same path. Mount it per path (`key`).
 */
export function useFileDocument(
  sessionKey: string,
  path: string,
  { active = true, deps }: UseFileDocumentOptions = {},
): FileDocumentHandle {
  const [loader] = useState(() => {
    const entryId = parseSessionKey(sessionKey)?.entryId;
    return entryId === undefined ? null : new FileDocumentLoader({ sessionKey, entryId, path }, deps);
  });
  const state = useSyncExternalStore(loader?.subscribe ?? noopSubscribe, loader?.getSnapshot ?? noFile);
  const visible = usePageVisible();
  const live = active && visible && loader !== null;

  useEffect(() => {
    if (loader === null) return undefined;
    void loader.poll();
    return () => {
      loader.stop();
    };
  }, [loader]);

  useEffect(() => {
    if (!live) return undefined;
    void loader.poll();
    const timer = setInterval(() => {
      void loader.poll();
    }, FILE_POLL_MS);
    return () => {
      clearInterval(timer);
    };
  }, [loader, live]);

  const written = useFileWriteStamp(sessionKey, path);
  const handled = useRef(written);
  useEffect(() => {
    if (loader === null || written === null || written === handled.current) return;
    handled.current = written;
    void loader.reload();
  }, [loader, written]);

  const file = loader?.file ?? null;
  return {
    ...state,
    file,
    url: file === null ? null : getFileSource().url(file),
    refresh: () => {
      void loader?.reload();
    },
  };
}

function noopSubscribe(): () => void {
  return () => undefined;
}

function noFile(): FileDocument {
  return NO_FILE;
}
