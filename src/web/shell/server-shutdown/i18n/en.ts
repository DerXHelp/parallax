/**
 * English texts of "Stop server" (WP-21; namespace `serverShutdown`). Same syntax as the shell
 * dictionaries (`{name}` placeholders, `{ one, other }` plurals); `de.ts` has exactly this shape.
 */
export const en = {
  menuItem: 'Stop server…',
  title: 'Stop the Parallax server?',
  description:
    'All Claude sessions of this server are stopped and every Parallax window loses its connection. ' +
    'Start Parallax again to continue – the sessions can then be resumed.',
  working: 'Working ({count})',
  waiting: 'Waiting for you ({count})',
  waitingHint:
    'Open permissions, questions and plans expire; a plan can be approved after the restart (“Resume”).',
  /** V3-13: reads on its own – also when no working/waiting list precedes it (no "more"). */
  idle: {
    one: '{count} idle session (no running work) will be closed.',
    other: '{count} idle sessions (no running work) will be closed.',
  },
  nothingRunning: 'No session is running – nothing will be interrupted.',
  confirm: 'Stop server',
  stopping: 'Stopping…',
  notConnected: 'Not connected to the server – it may already be stopped.',
  failed: 'The server could not be stopped.',
  /** From the "Parallax was updated" view (V2-04): no session list there. */
  outdatedDescription:
    'Every Claude session of this server is stopped too – they can be resumed after the restart. Then start Parallax again (parallax.cmd or pnpm start).',
  manualHint:
    'If that does not help: end the Parallax server (node.exe) in the Task Manager and start Parallax again.',
};
