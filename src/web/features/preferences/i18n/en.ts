/**
 * English texts of namespace `preferences` – WP-38 (settings page, sounds); same syntax as the
 * shell dictionaries (`{name}` placeholders, `{ one, other }` plurals). Theme and language names
 * come from the shell namespace `settings` (the menu uses the same words).
 */
export const en = {
  /** Settings menu entry that opens the page. */
  menuItem: 'Settings…',
  title: 'Settings',
  description: 'Changes take effect right away and are saved by the Parallax server.',
  sections: {
    label: 'Settings sections',
    general: 'General',
    notifications: 'Notifications',
    sessions: 'Sessions',
    profiles: 'Profiles',
    server: 'Server',
    about: 'About',
  },
  general: {
    languageHint: 'Language of the app and of the Windows notifications.',
    themeHint: 'System follows the Windows setting. The settings menu offers the same quick choice.',
  },
  notifications: {
    events: 'Events',
    eventsHint: 'Per event: a Windows notification and a sound. Parallax shows every notification only once.',
    columns: {
      event: 'Event',
      toast: 'Windows notification',
      sound: 'Sound',
    },
    kinds: {
      permission: 'Permission needed',
      question: 'Question',
      plan: 'Plan to review',
      done: 'Done',
      error: 'Error',
      rate_limit: 'Usage limit',
    },
    toastFor: 'Windows notification: {event}',
    soundFor: 'Sound: {event}',
    soundIdFor: 'Sound choice: {event}',
    previewFor: 'Play the sound for {event}',
    volume: 'Volume',
    volumeValue: '{percent} %',
    doNotDisturb: 'Do not disturb',
    doNotDisturbHint:
      'No Windows notifications and no sounds. Hints in the window and the count in the window title stay.',
    focusedElsewhere: 'While a Parallax window is in front and shows another session',
    focusedElsewhereInApp: 'Show a hint in the window',
    focusedElsewhereSystem: 'Show a Windows notification',
    doneMinSeconds: 'Minimum turn length for “Done”',
    doneMinSecondsHint:
      'While a Parallax window is in front, “Done” is only reported for turns that took at least this long. In the background every finished turn counts.',
    seconds: 'seconds',
    openOnClick: 'Clicking a Windows notification opens the session',
    openOnClickHint:
      'Registers the link type “parallax:” for your Windows user; a click opens the session in a new app window.',
  },
  sessions: {
    idleSleep: 'Put idle sessions to sleep',
    idleSleepHint:
      'Ends the Claude process of a session that waited for nothing this long; the next prompt resumes it. A session shown in a window in front never sleeps.',
    idleMinutes: 'Idle time before sleeping',
    minutes: 'minutes',
    promptSuggestions: 'Prompt suggestions',
    promptSuggestionsHint:
      'Claude suggests the next prompt as grey text in the composer (Tab accepts it). Costs one extra request per turn. Takes effect from the next start of a session.',
  },
  server: {
    port: 'Port',
    portPlaceholder: '{port} (default)',
    portHint: 'Empty = default port {port}. Takes effect after “Stop server” and a restart of Parallax.',
    currentPort: 'Current port: {port}',
    autostart: 'Start Parallax when you sign in to Windows',
    autostartHint: 'Starts the server in the background; Windows notifications work without a window.',
    openWindow: 'Also open a window at sign-in',
  },
  profiles: {
    unavailable: 'The profile editor is not available in this view.',
  },
  /** Autostart and the protocol handler (ADR-110): only the productive server. */
  systemIntegrationOff:
    'Only available for the installed Parallax server (default data folder, real Claude Code, not in development mode).',
  validation: {
    range: 'Enter a whole number from {min} to {max}.',
    rangeOrEmpty: 'Leave empty or enter a whole number from {min} to {max}.',
  },
  sounds: {
    names: {
      chime: 'Chime',
      ping: 'Ping',
      pop: 'Pop',
      bell: 'Bell',
      alert: 'Alert',
    },
    /** Notice when a sound was blocked by the browser's autoplay rule (once per window run). */
    locked:
      'Enable sounds: click anywhere in this window or press a key – browsers only play sounds after that.',
  },
};
