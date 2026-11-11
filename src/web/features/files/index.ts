import { createElement, lazy, memo, Suspense } from 'react';
import type { FeatureSlots, FileLinkSlotProps, FilePanelSlotProps } from '@web/shell/slots';
import { defaultFileLinkLabel, PlainReference } from './components/PlainReference';

/**
 * Feature `files` (WP-54): the slots `FileLink`, `FilePanel` (viewer) and `FilesPanel` ("Files of
 * this session"). All three are lazy chunks (WP-54 §7, Phase 3 start-chunk budget); WP-60 wires
 * them in App.tsx (`...FILES_SLOTS`). Only types are re-exported – a value export here would pull
 * its module into the start chunk (tests and the playground import the modules directly).
 */

const LazyFileLink = lazy(() => import('./FileLink'));
const LazyFilePanel = lazy(() => import('./FilePanel'));
const LazyFilesPanel = lazy(() => import('./FilesPanel'));

/**
 * Until the FileLink chunk is there, a reference is plain text – exactly what a `verify` link shows
 * while its stat check runs (no layout jump; the menu variant has nothing to show yet).
 */
function FileLinkFallback({ path, line = null, variant = 'inline', children }: FileLinkSlotProps) {
  if (variant === 'menu') return null;
  return createElement(PlainReference, {
    state: 'checking',
    label: children ?? defaultFileLinkLabel(path, line),
    tooltip: null,
  });
}

const FileLinkSlot = memo(function FileLinkSlot(props: FileLinkSlotProps) {
  return createElement(
    Suspense,
    { fallback: createElement(FileLinkFallback, props) },
    createElement(LazyFileLink, props),
  );
});

/** No fallback: the panel tab is empty for the moment the chunk loads (no layout jump). */
const FilePanelSlot = memo(function FilePanelSlot(props: FilePanelSlotProps) {
  return createElement(Suspense, { fallback: null }, createElement(LazyFilePanel, props));
});

const FilesPanelSlot = memo(function FilesPanelSlot(props: { sessionKey: string }) {
  return createElement(Suspense, { fallback: null }, createElement(LazyFilesPanel, props));
});

export type { FileRef, FileSource } from './state/file-source';

export const FILES_SLOTS: Pick<FeatureSlots, 'FileLink' | 'FilePanel' | 'FilesPanel'> = {
  FileLink: FileLinkSlot,
  FilePanel: FilePanelSlot,
  FilesPanel: FilesPanelSlot,
};
