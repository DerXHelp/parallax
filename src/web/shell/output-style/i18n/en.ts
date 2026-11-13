/**
 * Lazy namespace of the output style (WP-70): the texts come with the lazy chunks of the dialog
 * (header "…" menu) and the session info, never with the start chunk (start-chunk budget). The
 * menu item itself is `navigation.actions.outputStyle` (start chunk). Keys without a namespace
 * prefix: `st('hint')`.
 */
export const en = {
  title: 'Output style',
  hint: 'Applies to all sessions in this project (.claude\\settings.local.json) – from the next turn on.',
  current: 'current',
  choose: 'Use output style “{style}”',
  saving: 'Saving…',
  failed: 'The output style could not be changed',
  none: 'This Claude Code reports no output styles.',
  notRunning: 'The styles show once the session runs.',
  start: 'Start session',
  archived: 'Archived sessions keep their output style.',
  external: 'The session is open in an external console.',
  close: 'Close',
};
