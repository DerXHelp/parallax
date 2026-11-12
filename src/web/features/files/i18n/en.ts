/**
 * English texts of namespace `files` – viewer, file links and "Files of this session" (Phase 3,
 * WP-54; WP-50 registered the namespace as a stub).
 */
export const en = {
  title: 'Files',
  kind: {
    text: 'Text',
    markdown: 'Markdown',
    image: 'Image',
    pdf: 'PDF',
    binary: 'Binary file',
    directory: 'Folder',
  },
  actions: {
    viewer: 'Open in viewer',
    editor: 'Open in editor',
    explorer: 'Show in Explorer',
    default: 'Open with default program',
    copyPath: 'Copy path',
    /** Button of the action menu of one file. */
    menu: 'Actions for {name}',
    refresh: 'Refresh',
    download: 'Download',
  },
  notice: {
    copied: 'Path copied',
    copyFailed: 'The path could not be copied',
  },
  link: {
    /** Tooltip of a reference the server refused (PATH_NOT_ALLOWED). */
    notAllowed: 'Not shared with this session',
    /** Tooltip of a reference with a line (without one, the tooltip is the bare path). */
    tooltip: '{path} – line {line}',
  },
  viewer: {
    label: 'File viewer',
    loading: 'Loading file…',
    modified: 'Modified {time}',
    view: 'View',
    rendered: 'Rendered',
    source: 'Source',
    truncated: 'Shortened – only the first {size} are shown. Open the file in the editor to see all of it.',
    error: 'The file could not be shown',
    /** Metadata and content below an error are from the last successful load (deleted file). */
    stale: 'Last known state',
    retry: 'Try again',
    noPreview: 'No preview for this file.',
    folder: 'This is a folder.',
    code: 'Content of {name}',
    fit: 'Fit to panel',
    actualSize: 'Actual size (100 %)',
    enlarge: 'Open {name} in the lightbox',
    imageFailed: 'The image could not be loaded.',
    pdf: 'PDF {name}',
    pdfFallback: 'Not shown? Download the PDF or open it with the default program.',
    lightbox: {
      zoomIn: 'Zoom in',
      zoomOut: 'Zoom out',
      fit: 'Fit to window',
      actualSize: 'Actual size',
      save: 'Save as',
      close: 'Close',
      zoom: '{percent} %',
    },
  },
  panel: {
    title: 'Files of this session',
    filter: 'Filter files',
    list: 'Files Claude read or wrote',
    count: { one: '{count} file', other: '{count} files' },
    empty: 'No files yet. Files Claude reads or writes in this session appear here.',
    noMatch: 'No file matches “{query}”.',
    truncated: 'Only the newest files are listed.',
    error: 'The list could not be loaded',
  },
  ops: {
    read: 'read',
    written: 'written',
    edited: 'edited',
    plan: 'plan',
    output: 'output',
    attached: 'attached',
  },
};
