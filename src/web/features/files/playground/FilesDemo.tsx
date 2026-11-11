import { useEffect, useState, type ReactNode } from 'react';
import { makeError } from '@shared/errors';
import { windowsPathKey } from '@shared/paths';
import { NotificationCenter } from '@web/shell/NotificationCenter';
import { fakeFileTable, type FakeHost } from '@web/state/fake-host';
import { Button } from '@web/ui/button';
import { FileLoadError, getFileSource, setFileSource, type FileSource } from '../state/file-source';
import { statCache } from '../state/stat-cache';
import { fakeHostFileSource, startFilesScenario } from '../testing';
import { demoFileUrl } from './media';

const STATIC_TEXTS = new Map(fakeFileTable().map((file) => [windowsPathKey(file.info.path), file.text]));

/**
 * FileSource of the playground outside a FilesDemo (shell demos with the real panels): the texts of
 * the fake file table and generated media – the Vite dev server has no GET /api/file.
 */
export const staticDemoSource: FileSource = {
  text: (file) => {
    const text = STATIC_TEXTS.get(windowsPathKey(file.path))?.() ?? null;
    return text === null
      ? Promise.reject(new FileLoadError(makeError('FILE_NOT_FOUND')))
      : Promise.resolve(text);
  },
  url: (file) => demoFileUrl(file.path),
};

/**
 * Runs a files demo while mounted (dev only): the "empty" scenario plus the sample session
 * (cwd `D:\work\sample`) over the FakeHost, whose file table answers file.* / files.*, and a
 * FileSource over that table with generated media (no server behind Vite). The children mount
 * once the connection is up (their first commands need it). One instance per demo.
 */
export function FilesDemo({ children }: { children: (host: FakeHost) => ReactNode }) {
  const [host, setHost] = useState<FakeHost | null>(null);
  useEffect(() => {
    const previous = getFileSource();
    const running = startFilesScenario();
    setFileSource(fakeHostFileSource(running.host, demoFileUrl));
    let active = true;
    queueMicrotask(() => {
      if (active) setHost(running.host);
    });
    return () => {
      active = false;
      setFileSource(previous);
      statCache.clear();
      running.stop();
    };
  }, []);
  return (
    <div className="relative flex h-full min-h-0 flex-col">
      {host === null ? null : children(host)}
      <NotificationCenter />
    </div>
  );
}

/** A labelled developer control of a demo (English dev text like the demo titles). */
export function DemoButton({ label, onClick }: { label: string; onClick: () => void }) {
  return (
    <Button variant="outline" size="sm" onClick={onClick}>
      {label}
    </Button>
  );
}

/** A demo caption (English dev text). */
export function DemoNote({ text }: { text: string }) {
  return <p className="text-muted-foreground text-xs">{text}</p>;
}
