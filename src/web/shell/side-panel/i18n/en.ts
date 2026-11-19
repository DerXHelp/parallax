/**
 * English texts of namespace `sidePanel` – the side panel host of a session pane (Phase 3,
 * ADR-150; WP-50 scaffold, then WP-54). Same syntax as the shell dictionaries.
 */
export const en = {
  tabs: 'Side panel',
  close: 'Close panel',
  /** WP-93: as wide as the panel may be (70 % of the session area) – and back. */
  wide: 'Make panel wide',
  narrow: 'Normal panel width',
  tab: {
    plan: 'Plan',
    file: 'File',
    files: 'Files',
    tasks: 'Tasks',
    subagent: 'Agent',
  },
  /** Splitter between transcript and panel. */
  resize: 'Resize panel',
  width: '{width} px',
  /** Accessible name of the viewer tab with an open file. */
  fileTab: 'File: {name}',
  /** WP-74: × next to the file tab (closes the file, back to the tab it came from). */
  closeFile: 'Close {name}',
  /** WP-69: accessible name of the subagent tab. */
  subagentTab: 'Agent transcript: {title}',
  closeSubagent: 'Close the agent transcript “{title}”',
  /** Viewer tab: back to the previous file. */
  back: 'Back to {name}',
  history: 'Recently opened files',
};
