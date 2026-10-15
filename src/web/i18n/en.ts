import type { PermissionMode } from '@shared/common';
import type { DisplayStatusKind, NotificationKind } from '@shared/status';
import type { ConnectionStatus } from '@web/state/store';

/**
 * English shell dictionary (default language). Namespaces: common, shell, status, auth,
 * connection, settings. Feature namespaces live in src/web/features/<f>/i18n (registered in
 * index.ts), error texts in errors.en.ts. `de.ts` must have exactly this shape (`typeof en`).
 * Placeholders: `{name}`; plural forms: `{ one, other }` selected by `params.count`.
 */
export const en = {
  common: {
    close: 'Close',
    cancel: 'Cancel',
    retry: 'Retry',
    retryNow: 'Retry now',
    reload: 'Reload',
    loading: 'Loading…',
    dismiss: 'Dismiss',
    show: 'Show',
    unknown: 'Unknown',
    keys: {
      ctrl: 'Ctrl',
      alt: 'Alt',
      shift: 'Shift',
      meta: 'Win',
      escape: 'Esc',
      enter: 'Enter',
      space: 'Space',
      tab: 'Tab',
      backspace: 'Backspace',
      arrowUp: '↑',
      arrowDown: '↓',
      arrowLeft: '←',
      arrowRight: '→',
    },
  },
  shell: {
    /** Window title with sessions waiting for the user (Plan "Fenstertitel"). */
    windowTitle: '({count}) {product}',
    sidebar: {
      label: 'Sessions',
      count: { one: '{count} session', other: '{count} sessions' },
      empty: 'No sessions yet.',
      waiting: 'Waiting for you ({count})',
      waitingAction: 'Go to the next session waiting for you',
      unread: 'Unread',
      lastActivity: 'Last activity {time}',
      pinned: 'Pinned',
    },
    session: {
      loading: 'Loading session…',
      notFound: 'This session no longer exists.',
      backToOverview: 'Back to overview',
      unavailable: 'The session could not be loaded.',
      cwd: 'Working directory',
      model: 'Model',
      modelDefault: 'Default model',
      permissionMode: 'Mode',
      sessionId: 'Session ID',
      profile: 'Profile',
      details: 'Session details',
    },
    badges: {
      background: 'Background tasks',
      compacting: 'Compacting',
      retrying: 'Retrying',
      queued: { one: '{count} queued', other: '{count} queued' },
      expiredDecisions: { one: '{count} expired decision', other: '{count} expired decisions' },
    },
    permissionMode: {
      default: 'Ask',
      acceptEdits: 'Accept edits',
      plan: 'Plan',
      auto: 'Auto',
      dontAsk: "Don't ask",
      bypassPermissions: 'Bypass permissions',
    } satisfies Record<PermissionMode, string>,
    empty: {
      title: 'No session selected',
      description: 'Pick a session on the left or start a new one.',
      welcomeTitle: 'Welcome to {product}',
      welcomeDescription: 'Start your first Claude Code session in a project folder.',
      recentProjects: 'Recent projects',
    },
    newSession: {
      title: 'New session',
      cwdLabel: 'Project folder',
      cwdPlaceholder: 'D:\\work\\my-project',
      submit: 'Start session',
      starting: 'Starting…',
    },
    placeholders: {
      transcript: {
        one: 'Transcript view not connected ({count} item).',
        other: 'Transcript view not connected ({count} items).',
      },
      decisionBar: { one: '{count} open decision', other: '{count} open decisions' },
      decisionCard: 'Decision (view not connected)',
      composer: 'Composer not connected.',
    },
    setup: {
      title: 'Claude Code needs attention',
      description: 'The default profile cannot start sessions yet. Run “pnpm preflight” for details.',
    },
    warnings: {
      title: 'Server warning',
    },
    shortcuts: {
      title: 'Keyboard shortcuts',
      description: 'Shortcuts do not fire while you type in a text field (except Esc).',
      help: 'Show keyboard shortcuts',
      selectSession: 'Select session 1–9 in the sidebar',
      empty: 'No shortcuts registered.',
    },
    notifications: {
      region: 'Notifications',
      show: 'Show session',
      kinds: {
        permission: '{title} – needs permission',
        question: '{title} – has a question',
        plan: '{title} – plan ready for review',
        done: '{title} – done',
        error: '{title} – error',
        rate_limit: '{title} – rate limit reached',
      } satisfies Record<NotificationKind, string>,
    },
    playground: {
      title: 'Playground',
      description: 'Development only: components with sample data, no server.',
      demos: 'Demos',
      noDemos: 'No demos found.',
      demoFailed: 'This demo crashed.',
      openApp: 'Open app',
    },
  },
  /** `status.<DisplayStatusKind>` – label of the status icon (never color only). */
  status: {
    'needs-permission': 'Needs permission',
    'needs-answer': 'Has a question',
    'needs-review': 'Plan ready for review',
    'needs-resume': 'Waiting to resume',
    error: 'Error',
    interrupted: 'Interrupted',
    'rate-limited': 'Rate limited',
    starting: 'Starting',
    working: 'Working',
    background: 'Working in the background',
    done: 'Done',
    idle: 'Idle',
    sleeping: 'Sleeping',
    external: 'Opened elsewhere',
  } satisfies Record<DisplayStatusKind, string>,
  auth: {
    signedOutTitle: 'Not signed in',
    signedOutDescription:
      'This window has no valid sign-in. Open Parallax through the launcher (pnpm start).',
    devHint: 'Development: open the URL with “#code=…” from the server log.',
    checkAgain: 'Check again',
  },
  connection: {
    connecting: 'Connecting…',
    unreachableTitle: 'Server not reachable',
    unreachableDescription: 'Parallax cannot reach its local server.',
    upgradeRejected:
      'The server answers but refuses the live connection (WebSocket). Check security software or proxies that filter local traffic.',
    retryIn: { one: 'Retrying in {count} second…', other: 'Retrying in {count} seconds…' },
    reconnecting: 'Connection lost – reconnecting…',
    serverStoppedTitle: 'Parallax server stopped',
    serverStoppedDescription: 'The local server was shut down. Start Parallax again, then reconnect.',
    reconnect: 'Reconnect',
    versionMismatchTitle: 'Parallax was updated',
    versionMismatchDescription:
      'This window and the server run different versions. Reload to continue – if this stays, restart Parallax.',
    status: {
      connecting: 'Connecting',
      open: 'Connected',
      reconnecting: 'Reconnecting',
      closed: 'Disconnected',
    } satisfies Record<ConnectionStatus, string>,
  },
  settings: {
    label: 'Settings',
    theme: 'Theme',
    themes: { dark: 'Dark', light: 'Light', system: 'System' },
    language: 'Language',
    languages: { en: 'English', de: 'Deutsch' },
    shortcuts: 'Keyboard shortcuts',
    saveFailed: 'The setting could not be saved.',
  },
};
