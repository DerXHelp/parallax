import type { ConversationEndReason } from '@shared/model';

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
  },
  row: {
    actions: 'Actions for “{title}”',
    branch: 'Branch',
    model: 'Model',
    context: 'Context',
  },
  actions: {
    menu: 'Session actions',
    rename: 'Rename',
    pin: 'Pin',
    unpin: 'Unpin',
    openWindow: 'Open in new window',
    newSessionHere: 'New session in this project…',
    sleep: 'Put to sleep',
    openExternal: 'Open in external console',
    copyConsoleCommand: 'Copy console command',
    archive: 'Archive',
    restore: 'Restore',
    conversations: 'Earlier conversations…',
    sessionInfo: 'Session info…',
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
      'Conversations of this session before “/clear”. Opening one continues it here – the current one stays in this list.',
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
    description: 'Facts of this session as reported by Claude Code at its last start.',
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
    },
    window: 'Limit ({name})',
    resetsAt: 'Resets at {time}',
    resetsOn: 'Resets on {date}',
  },
  /** Actions of window hints (NotificationCenter, `ClientNotice.action`). */
  notices: {
    enableSounds: 'Enable sounds',
  },
};
