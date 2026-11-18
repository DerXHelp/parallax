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
    /** WP-78b. */
    multiHost: 'Several computers',
    updates: 'Updates',
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
    /** WP-63 §1.5. */
    transcript: 'Transcript',
    transcriptHint:
      'Compact: the work steps between two messages form one line (click to open), pictures stay visible as a gallery. All steps: every step on its own line. Applies to every window and browser.',
    transcriptViews: { compact: 'Compact', all: 'All steps' },
    /** WP-69: hook runs in the transcript. */
    hooks: 'Hook runs',
    hooksHint:
      'Failed runs show as errors with their output. All: successful ones too, as steps. Off: none – a failed start hook still shows.',
    hookDisplays: { all: 'All', failed: 'Failed and blocking only', off: 'Off' },
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
    /** WP-64. */
    remoteControl: 'Remote Control for new sessions',
    remoteControlHint:
      'Opens a new session in the Claude app (phone or claude.ai) as well, so you can follow and answer it there. Existing sessions keep their own choice (header menu).',
    remoteFollow: 'Like the Claude setting ({detected})',
    remoteDetectedOn: 'currently on',
    remoteDetectedOff: 'currently off',
    remoteDetectedUnknown: 'not read yet – known after the first session start',
    remoteOptions: {
      on: 'Always on',
      off: 'Off',
    },
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
  updates: {
    unavailable: 'Updates are not available in this view.',
  },
  /** Section "Several computers" (WP-78b; part "Control others" follows with WP-80). */
  multiHost: {
    role: {
      label: 'Role of this computer',
      hint: 'Computers in the same network can work together: a sharing computer lets one paired computer control its sessions; a controlling computer shows the sessions of sharing computers. One role at a time.',
      options: {
        off: 'Off',
        share: 'Share',
        control: 'Control others',
      },
      descriptions: {
        off: 'This computer cannot be reached from the network. Pairings are kept.',
        share: 'One paired computer in the same network may control the sessions of this computer.',
        control: 'This computer shows and controls the sessions of sharing computers in the same network.',
      },
      saving: 'Switching the role…',
      failed: 'The role was not changed.',
      conflictShare: 'Remove the pairing first – after that this computer can control others.',
      conflictControl:
        'Remove all computers under “Control others” first – after that this computer can share.',
      unpairAction: 'Remove pairing…',
    },
    off: 'Turn on “Share” to let another computer in the same network control this one, or “Control others” to control a sharing computer from here.',
    share: {
      starting: 'Sharing is being set up…',
      status: {
        heading: 'Remote access',
        listening: 'Reachable',
        stopped: 'Not reachable',
        listeningOn: 'Listening on port {port}.',
        addresses: 'Addresses of this computer: {addresses}',
        noAddresses: 'No network address of this computer was found.',
        hostName: 'Computer name: {name}',
        failedReasons: {
          port_in_use: 'Another program uses port {port}. Choose another port below.',
          bind: 'The chosen address does not belong to this computer. Choose another address below.',
          tls_unsupported:
            'This Node.js lacks the required encryption (ML-KEM, ML-DSA). Update Node.js to use sharing.',
          listen: 'Windows did not allow listening on the port.',
          store: 'The pairing file could not be written. Remote access stays off until that works.',
        },
      },
      checks: {
        label: 'Checks',
        recheck: 'Check again',
        checking: 'Checking…',
        failed: 'The checks could not run.',
        status: { ok: 'OK', warning: 'Note', error: 'Problem' },
        names: {
          port: 'Port',
          keys: 'Key and certificate',
          keystore: 'Windows key store',
          tls: 'Encryption (TLS 1.3, ML-KEM, ML-DSA)',
          addresses: 'Network addresses',
          firewall: 'Windows Firewall',
        },
        details: {
          port: { warning: 'The port could not be checked.', error: 'Another program uses the port.' },
          keys: {
            warning: 'The key was created anew – pair the controlling computer again.',
            error: 'The key or its certificate could not be created or loaded.',
          },
          keystore: {
            warning: 'The Windows key store answered slowly.',
            error: 'The Windows key store is not available, so keys cannot be stored safely.',
          },
          tls: {
            warning: 'The encryption self-test reported a problem.',
            error: 'The encryption self-test failed.',
          },
          addresses: {
            warning: 'No address in a local network was found.',
            error: 'No network address of this computer was found.',
          },
          firewall: {
            warning: 'No firewall rule for Node.js was found yet – Windows asks when remote access starts.',
            error: 'The firewall blocks connections to the port.',
          },
        },
      },
      firewall: {
        title: 'Windows Firewall',
        body: 'When remote access starts for the first time, Windows may ask whether Node.js may communicate in networks. Allow it for private networks only. Without this permission the other computer cannot connect; depending on the computer, allowing it needs administrator rights.',
      },
      pairing: {
        heading: 'Pair a computer',
        hint: 'Shows a one-time code. Type it on the controlling computer under “Control others” within {minutes} minutes; after {failures} wrong entries the code is void.',
        start: 'Pair a computer',
        starting: 'Creating the code…',
        codeLabel: 'Pairing code',
        validFor: 'Valid for {time}',
        minutesLeft: {
          one: 'The pairing code is valid for {count} more minute.',
          other: 'The pairing code is valid for {count} more minutes.',
        },
        computer: 'Computer name',
        addresses: 'Address',
        port: 'Port',
        cancel: 'Cancel pairing',
        cancelled: 'Pairing was cancelled.',
        expired: 'The code expired. Start pairing again if needed.',
        closed: 'The pairing window was closed (for example after too many wrong codes).',
        paired: 'Paired with {name}.',
        openElsewhere: 'A pairing window is open until {time}. Its code was shown in another window.',
        newCode: 'Show a new code',
        replaceTitle: 'Replace the pairing with {name}?',
        replaceBody:
          'Only one computer can be paired. The current pairing stays until the new computer has paired successfully.',
        replaceConfirm: 'Pair a new computer',
        keep: 'Keep the pairing',
        failed: 'Pairing could not start.',
      },
      peer: {
        heading: 'Paired computer',
        none: 'No computer is paired yet.',
        connected: {
          one: 'Connected ({count} connection)',
          other: 'Connected ({count} connections)',
        },
        disconnected: 'Not connected',
        incompatible: 'Other Parallax version',
        incompatibleHint:
          'The controlling computer runs Parallax {version}. It is refused until both computers run the same version.',
        unknownVersion: 'unknown',
        pairedAt: 'Paired since',
        lastSeen: 'Last contact',
        never: 'Not yet',
        lastAddress: 'Last address',
        noAddress: 'Unknown',
        unpair: 'Remove pairing…',
        unpairTitle: 'Remove the pairing with {name}?',
        unpairBody: 'Its connections close at once. To control this computer again it has to be paired anew.',
        unpairConfirm: 'Remove pairing',
        unpaired: 'The pairing was removed.',
        renew: 'Renew key…',
        renewTitle: 'Renew the key of this computer?',
        renewBodyPaired:
          'A new key also removes the pairing with {name}; its connections close at once. Pair again afterwards.',
        renewBody: 'This computer gets a new key. Computers that were paired before can no longer connect.',
        renewConfirm: 'Renew key',
        renewed: 'The key was renewed.',
        cancel: 'Cancel',
        failed: 'The action failed.',
      },
      listener: {
        heading: 'Port and address',
        port: 'Port',
        portHint:
          'The controlling computer connects to this port. After a change, enter the new port there as well.',
        bindAddress: 'Address',
        bindAddressHint: 'All addresses, or only one network of this computer.',
        allAddresses: 'All addresses ({address})',
        failed: 'The setting was not saved.',
      },
      log: {
        heading: 'Connection log',
        hint: 'Every attempt to connect to this computer, merged per address and minute. Entries are kept for {days} days.',
        onlyRejected: 'Only rejected attempts',
        refresh: 'Refresh',
        loading: 'Loading the log…',
        failed: 'The log could not be loaded.',
        retry: 'Try again',
        empty: 'No entries yet.',
        emptyRejected: 'No rejected attempts.',
        columns: { time: 'Time', address: 'IP address', kind: 'Event', count: 'Count', name: 'Name' },
        count: '{count}×',
        rejected: 'rejected',
        noName: '–',
        unverified: 'unverified',
        unverifiedHint: 'The other side gave this name itself; it is not checked.',
        kinds: {
          pair_ok: 'Paired',
          pair_failed: 'Pairing failed',
          pair_expired: 'Pairing window not open',
          pair_rate_limited: 'Too many pairing attempts',
          unknown_key: 'Unknown key',
          revoked_key: 'Key of a removed pairing',
          bad_certificate: 'Unusable certificate',
          proof_failed: 'Connection proof failed',
          tls_failed: 'Encryption aborted',
          rate_limited: 'Too many connections',
          browser_rejected: 'Browser request refused',
          version_mismatch: 'Other Parallax version',
          connected: 'Connected',
          disconnected: 'Disconnected',
          unpaired: 'Pairing removed',
        },
      },
    },
    control: {
      placeholder:
        'Here you will add sharing computers in the same network with their pairing code and see their state. This part follows in a later version.',
    },
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
    pathOptionalHint:
      'Empty = the installation Parallax found. Enter the full path of an .exe to use another one.',
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
