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
    files: 'Files',
    profiles: 'Profiles',
    server: 'Server',
    about: 'About',
    /** Screen reader text of the dot on "Profiles" while the profile editor holds unsaved changes. */
    unsaved: 'unsaved changes',
  },
  /** Inline question when the page should close while the profile editor holds unsaved changes. */
  closeConfirm: {
    title: 'Discard the unsaved profile changes?',
    description: 'The profile editor has changes that are not saved yet. Closing the settings discards them.',
    keep: 'Keep editing',
    discard: 'Discard and close',
  },
  /** Hides the error of a refused change (the value already went back). */
  dismissError: 'Dismiss',
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
    openOnClickForeign:
      'Another program is already registered for “parallax:” links on your Windows user. Parallax does not replace it.',
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
    openWindowNeedsAutostart: 'Only while “Start Parallax when you sign in to Windows” is on.',
    autostartForeign:
      'Your Startup folder already has a “Parallax.lnk” that Parallax did not create. Parallax does not replace it – rename or delete it to use this setting.',
  },
  profiles: {
    unavailable: 'The profile editor is not available in this view.',
  },
  /** Section "Files" (WP-58, ADR-144): the editor for "Open in editor". */
  files: {
    editor: 'Editor for “Open in editor”',
    editorHint:
      'Parallax opens a file in this program at the referenced line. Notepad++ is the default; the change applies to the next file you open.',
    presets: {
      notepadpp: 'Notepad++',
      vscode: 'Visual Studio Code',
      custom: 'Own program',
      system: 'Windows default program',
    },
    defaultBadge: 'Default',
    detecting: 'Looking for the program…',
    found: 'Found: {path}',
    notFound: 'Not found on this computer',
    detectFailed: 'Could not check which editors are installed.',
    systemHint:
      'Opens a file with the program Windows assigns to its type – only for harmless types ({extensions}). Other files cannot be opened this way.',
    path: 'Program (.exe)',
    pathOptional: 'Own path (optional)',
    pathOptionalHint: 'Empty = the installation Parallax found. Enter the full path of an .exe to use another one.',
    customHint: 'The full local path of the program’s .exe file.',
    pathPlaceholder: 'C:\\Program Files\\Editor\\editor.exe',
    pathExists: 'The program exists.',
    pathMissing: 'There is no program at this path (any more).',
    args: 'Arguments',
    argsHint: 'One argument per line. Placeholders: {file} (required), {line} and {col} (1 when unknown).',
    preview: 'Command line (example)',
    previewHint: 'For line {line}, column {col} of {sample}.',
    save: 'Save editor',
    unsaved: 'Not saved yet',
    issues: {
      path: 'Enter a full local path (like C:\\…) – no network path, no relative path.',
      not_exe: 'The program must be an .exe file.',
      blocked: 'This program cannot be the editor (shells, script hosts and Explorer are blocked).',
      required: 'Enter the path of the program.',
      file_placeholder: 'One argument must contain {placeholder}.',
      too_long: 'This entry is too long.',
      too_many: 'At most {max} arguments.',
      invalid: 'This entry is not valid.',
    },
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
