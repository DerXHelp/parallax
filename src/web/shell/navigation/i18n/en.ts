import type { ConversationEndReason, RemoteControlState } from '@shared/model';
import type { LabeledLimitWindow } from '@web/lib/account-limits';

/**
 * English texts of namespace `navigation` – WP-35 (sidebar, quick switcher, header, windows).
 * Same syntax as the shell dictionaries (`{name}` placeholders, `{ one, other }` plurals); a
 * namespace object never uses the key `other` (it marks plural forms).
 */
export const en = {
  sidebar: {
    flat: 'Flat list',
    grouped: 'Group by project',
    nextWaiting: 'Next session waiting for you (Alt+N)',
    archive: { one: 'Archive ({count})', other: 'Archive ({count})' },
    archiveTitle: 'Archive',
    archiveBack: 'Back to the sessions',
    archiveEmpty: 'No archived sessions.',
    group: 'Project {name}',
    /** WP-58 (V3-14): collapses the sidebar into the rail (narrow window: closes the overlay). */
    collapse: 'Collapse the sidebar',
  },
  /** The collapsed sidebar (V3-14, WP-58): status icons of the sessions, "Show sessions". */
  rail: {
    label: 'Sessions (collapsed sidebar)',
    show: 'Show sessions',
    session: '{title} – {status}',
    sessionUnread: '{title} – {status}, unread',
  },
  /** Side panel buttons of the session header (WP-58); "…" menu items in a narrow header. */
  panels: {
    label: 'Side panel',
    plan: 'Plan',
    files: 'Files of this session',
    tasks: 'Tasks',
    tasksRunning: {
      one: 'Tasks – {count} background task running',
      other: 'Tasks – {count} background tasks running',
    },
    tasksOpen: { one: 'Tasks – {count} open to-do', other: 'Tasks – {count} open to-dos' },
    /** Counter above its maximum (R5W-06: no literal in the component). */
    countOverflow: '{max}+',
  },
  /** Drop zone over the session pane (R4W-02, WP-58). */
  drop: {
    hint: 'Drop to attach',
    unavailable: 'Files cannot be attached to this session here.',
  },
  /** Error boundary of a lazily loaded area (shell/SlotBoundary.tsx, WP-58). */
  slotError: {
    title: 'This area could not be loaded',
    render: 'Something went wrong while showing it. The rest of Parallax keeps working.',
    chunk: 'A part of the app could not be downloaded – maybe Parallax was updated meanwhile.',
    retry: 'Reload',
    confirmReload: 'Reload the whole window? Your sessions keep running on the server.',
    reloadWindow: 'Reload window',
    cancel: 'Cancel',
    /** Quiet slots in running text (R5W-02): one notice per window, the content stays as text. */
    inlineChunk:
      'A part of the app could not be downloaded – maybe Parallax was updated meanwhile. Until the window is reloaded, some content (such as file links) shows as plain text.',
    inlineRender: 'Some content (such as file links) could not be shown and appears as plain text.',
  },
  row: {
    actions: 'Actions for “{title}”',
    branch: 'Branch',
    model: 'Model',
    context: 'Context',
    /** WP-63 §1.1. */
    effort: 'Effort',
    /** WP-63 §1.4: screen-reader text of the context symbol. */
    compactSoon: 'Autocompact soon',
    /** WP-65 §1.1: screen-reader prefix of a highlighted line (open decision, error, needs_action). */
    needsYou: 'Needs you:',
  },
  /** WP-65 §1.1: Parallax's live line while no CLI sentence comes (no Remote Control). */
  activity: {
    thinking: 'Thinking…',
    run: 'Running: {target}',
    write: 'Writing {target}',
    edit: 'Editing {target}',
    read: 'Reading {target}',
    search: 'Searching: {target}',
    fetch: 'Fetching {target}',
    agent: 'Subagent: {target}',
    tool: '{tool}: {target}',
    toolOnly: 'Using {tool}',
  },
  actions: {
    menu: 'Session actions',
    rename: 'Rename',
    pin: 'Pin',
    unpin: 'Unpin',
    openWindow: 'Open in new window',
    openFolder: 'Open folder in Explorer',
    newSessionHere: 'New session in this project…',
    sleep: 'Put to sleep',
    openExternal: 'Open in external console',
    copyConsoleCommand: 'Copy console command',
    archive: 'Archive',
    restore: 'Restore',
    conversations: 'Earlier conversations…',
    sessionInfo: 'Session info…',
    /** WP-63 §1.3. */
    remove: 'Remove from Parallax…',
    /** WP-64: Remote Control. */
    remoteOn: 'Turn on Remote Control',
    remoteOff: 'Turn off Remote Control',
    openRemote: 'Open in the Claude app',
    copyRemoteLink: 'Copy Remote Control link',
    /** WP-65 §1.3. */
    regenerateTitle: 'Generate title again',
    /** WP-66: a side question from the sidebar. */
    quickAsk: 'Quick question…',
    /** WP-70: sign in from Parallax (at sign-in errors); the output style of the project. */
    signIn: 'Sign in',
    outputStyle: 'Output style…',
  },
  /** WP-66: the popover of "Quick question…" (a side question, never part of the conversation). */
  quickAsk: {
    title: 'Quick question · {title}',
    hint: 'Answered from the conversation – does not go into the context.',
    placeholder: 'Ask about this session…',
    followUp: 'Follow up…',
    ask: 'Ask',
    pending: 'asking…',
    cancel: 'Cancel',
    open: 'Open session',
    noAnswer: 'No answer available',
    busy: 'Too many side questions right now – try again in a moment',
    unavailable: 'Side question not available',
    answered: '{title}: {answer}',
  },
  /** WP-64: Remote Control (sidebar icon, header button and menu). */
  remote: {
    status: 'Remote Control: {state}',
    states: {
      off: 'off',
      connecting: 'connecting…',
      connected: 'connected – open in the Claude app',
      reconnecting: 'connection lost, reconnecting…',
      failed: 'not connected',
    } satisfies Record<RemoteControlState, string>,
    waiting: 'Remote Control: connects when the session starts',
    button: 'Remote Control of “{title}”',
    copied: 'Remote Control link copied.',
    copyFailed: 'The link could not be copied to the clipboard.',
  },
  /** WP-63 §1.3: remove a session from Parallax only (files stay). */
  remove: {
    title: 'Remove session from Parallax?',
    description:
      '“{title}” disappears from the list and from Parallax. Its files stay on disk: the Claude Code transcript, attachments and plan versions – “claude --resume” keeps working.',
    working:
      'This session is working right now. Removing it ends the running turn and the Claude Code process; open decisions are dropped.',
    running: 'The Claude Code process of this session is closed first.',
    confirm: 'Remove',
    removing: 'Removing…',
    cancel: 'Cancel',
  },
  /** WP-63 §1.3: "Clean up archive…" in the archive view. */
  cleanup: {
    open: 'Clean up archive…',
    title: 'Clean up archive',
    description:
      'Removes the selected sessions from Parallax. Their files stay on disk, “claude --resume” keeps working.',
    list: 'Archived sessions',
    selectAll: 'Select all',
    olderThan: 'Older than {days} days',
    lastActive: 'Last active {time}',
    folder: 'Folder',
    empty: 'No archived sessions.',
    remove: { one: 'Remove ({count})', other: 'Remove ({count})' },
    removing: 'Removing…',
    cancel: 'Cancel',
    failed: { one: '{count} session could not be removed:', other: '{count} sessions could not be removed:' },
    failure: '{title}: {error}',
  },
  rename: {
    label: 'Session title',
    hint: 'Enter saves, Esc cancels. Empty = automatic title.',
  },
  console: {
    copied:
      'Console command copied. Secret values of the profile are not in it – the console asks for them. Do not use this session in Parallax while claude runs in the console – two writers would mix up the conversation.',
    copyFailed: 'The console command could not be copied to the clipboard.',
  },
  switcher: {
    title: 'Switch session',
    description: 'Type to search by title, folder, branch or profile.',
    placeholder: 'Search sessions…',
    list: 'Sessions',
    empty: 'No matching session.',
    hint: 'Enter opens · Shift+Enter opens in a new window · Esc closes',
    waiting: 'Waiting for you',
  },
  shortcuts: {
    quickSwitcher: 'Quick switcher: search and open a session',
    nextWaiting: 'Next session waiting for you',
    rename: 'Rename the selected session',
  },
  conversations: {
    title: 'Earlier conversations',
    description:
      'Earlier conversations of this session. Opening one continues it here – the current one stays in this list.',
    empty: 'No earlier conversations.',
    list: 'Earlier conversations',
    untitled: 'Untitled conversation',
    started: 'Started {time}',
    ended: 'Ended {time}',
    open: 'Open',
    opening: 'Opening…',
    notStarted: 'Never sent to Claude – cannot be continued.',
    reasons: {
      clear: 'Cleared (/clear)',
      plan_mode_exit: 'Left plan mode',
      fresh_session: 'New Claude session',
      onboarding: 'Onboarding',
      fork: 'Forked',
      unknown: 'Ended',
      switched: 'Switched to another conversation',
    } satisfies Record<ConversationEndReason, string>,
  },
  info: {
    title: 'Session info',
    description: 'Facts of this session: from its last start, and in the other tabs live from Claude Code.',
    model: 'Model',
    mode: 'Mode',
    cwd: 'Working directory',
    branch: 'Git branch',
    cliVersion: 'Claude Code version',
    apiKeySource: 'Sign-in (API key source)',
    sessionId: 'Session ID',
    profile: 'Profile',
    mcpServers: 'MCP servers',
    none: 'None',
    unknown: 'Unknown',
    notStarted: 'Not started yet – the details appear after the first message.',
    /** `init.apiKeySource` (SDK `ApiKeySource`); unknown values are shown raw. */
    apiKeySources: {
      subscription: 'Subscription (claude.ai)',
      envKey: 'API key (ANTHROPIC_API_KEY)',
      helper: 'API key helper (apiKeyHelper)',
      loginManaged: 'Key managed by /login',
      user: 'API key from the user settings',
      project: 'API key from the project settings',
      org: 'API key of the organization',
      temporary: 'Temporary API key',
      oauth: 'OAuth sign-in',
    },
    /** Status of an MCP server; unknown values are shown raw. */
    mcpStatus: {
      connected: 'Connected',
      failed: 'Failed',
      needsAuth: 'Sign-in needed',
      pending: 'Starting',
      disabled: 'Disabled',
    },
  },
  pane: {
    externalTitle: 'Opened in an external console (since {time})',
    externalRunning: 'Quit claude there – Parallax then takes the session back automatically.',
    externalEnded: 'The console was closed – Parallax is taking the session back.',
    reclaim: 'Take back',
    archivedTitle: 'Archived',
    archivedDescription: 'This session is read-only until you restore it.',
    restore: 'Restore',
  },
  limits: {
    label: 'Subscription limits',
    profile: 'Profile {name}',
    /** One account shared by several profiles (same config folder, WP41-05); `names` joined by ", ". */
    profiles: 'Profiles {names}',
    windows: {
      five_hour: '5-hour limit',
      seven_day: 'Weekly limit',
      seven_day_opus: 'Weekly limit Opus',
      seven_day_sonnet: 'Weekly limit Sonnet',
      overage: 'Extra usage',
    } satisfies Record<LabeledLimitWindow, string>,
    window: 'Limit ({name})',
    resetsAt: 'Resets at {time}',
    resetsOn: 'Resets on {date}',
    /** WP-65 §1.4: tooltip of a limit bar, `when` relative ("in 2 hours"). */
    resetsIn: '{percent} used · resets {when}',
  },
  /** Actions of window hints (NotificationCenter, `ClientNotice.action`). */
  notices: {
    enableSounds: 'Enable sounds',
  },
};
