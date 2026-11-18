/**
 * English texts of namespace `hosts` – WP-80 (several computers in the window: badge, sidebar
 * groups, "New session" per computer, banners of an unavailable computer, the header icon).
 * Neutral words: "computer", "this computer", "controlling"/"sharing computer". Same syntax as the
 * shell dictionaries (`{name}` placeholders, `{ one, other }` plurals).
 */
export const en = {
  thisComputer: 'This computer',
  /** Badge of a computer (sidebar row, session header, folder group). */
  badge: {
    label: 'Computer {name}',
  },
  /** Whether a computer can be used now. */
  status: {
    available: 'Connected',
    connecting: 'Connecting…',
    unreachable: 'Not reachable',
    incompatible: 'Other version',
    revoked: 'Pairing removed',
  },
  /** "Group by" menu of the sidebar (only with other computers). */
  groupBy: {
    label: 'Group by',
    host: 'Computer',
    folder: 'Folder',
  },
  /** Header of a computer group in the sidebar. */
  group: {
    label: 'Computer {name}',
    count: { one: '{count} session', other: '{count} sessions' },
    waiting: { one: '{count} waiting', other: '{count} waiting' },
    selectedInside: 'Contains the selected session',
    empty: 'No sessions',
    newSession: 'New session on {name}…',
    expand: 'Expand {name}',
    collapse: 'Collapse {name}',
  },
  /** Grey rows and the banner of a session whose computer cannot be used. */
  unavailable: {
    row: 'Computer {name}: {status}',
    unreachable: '{name} is not reachable. The sessions there come back once it can be reached again.',
    connecting: 'Connecting to {name}…',
    incompatible: 'Parallax on {name} has another version ({version}). Update Parallax on {name} to {own}.',
    incompatibleUnknown: 'Parallax on {name} has another version. Update Parallax on {name} to {own}.',
    revoked: 'The pairing with {name} was removed. Pair again under Settings → Several computers.',
    reconnect: 'Reconnect',
    settings: 'Several computers…',
  },
  /** "New session": the computer to start it on. */
  newSession: {
    host: 'Computer',
    hostHint: 'Folders, profiles and recent folders come from this computer.',
    signInThere: 'Sign in on {name} itself – signing in does not work from here.',
    unavailable: '{name} cannot be used right now ({status}).',
  },
  /** Session header: the computer the session runs on. */
  session: {
    host: 'Runs on {name}',
  },
  /** Icon in the sidebar header (role "share" or "control"). */
  indicator: {
    open: 'Several computers – open settings',
    shareListening: 'Sharing: waiting for connections',
    shareOff: 'Sharing: not listening',
    shareConnected: 'Sharing: {name} is connected',
    shareError: 'Sharing: listener failed',
    rejected: { one: '{count} rejected attempt', other: '{count} rejected attempts' },
    controlAll: { one: '{count} computer connected', other: 'All {count} computers connected' },
    controlSome: '{connected} of {total} computers connected',
    controlNone: 'No computer added',
  },
};
