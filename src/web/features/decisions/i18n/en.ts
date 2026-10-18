import type { PermissionMode, RuleDestination } from '@shared/common';
import type { CANCEL_REASONS, DecisionOutcome } from '@shared/model';

type CancelReason = (typeof CANCEL_REASONS)[number];
type ResolvedOutcome = Exclude<DecisionOutcome['type'], 'cancelled'>;

/**
 * English dictionary of the `decisions` namespace (owner WP-16): `t('decisions.<path>')`.
 * Registered statically in src/web/i18n/index.ts (stub created by WP-14). Leaves are strings or
 * plural forms `{ one, other }`; never use `other` as a namespace key.
 */
export const en = {
  bar: {
    label: 'Decisions',
    more: { one: '+{count} more', other: '+{count} more' },
    moreLabel: 'Open decisions of this session',
    /** Accessible name of the "+n more" button (one key, R3-17). */
    moreTrigger: {
      one: '+{count} more · Open decisions of this session',
      other: '+{count} more · Open decisions of this session',
    },
    oldest: 'oldest',
    notConnected: 'Not connected – answers are paused.',
    sending: 'Sending…',
    announce: {
      permission: 'Claude asks for permission: {title}',
      question: 'Claude has a question',
      plan: 'Plan version {version} is ready for review',
      expired: 'An expired decision waits for you',
    },
  },
  kind: {
    permission: 'Permission',
    question: 'Question',
    plan: 'Plan',
  },
  requester: {
    label: 'Asked by',
    main: 'Main agent',
    subagent: 'Subagent: {name}',
    subagentUnnamed: 'Subagent',
  },
  actions: {
    shortcutHint: 'Click or press {keys} – Enter and Space never answer.',
  },
  permission: {
    title: '{tool} needs your permission',
    allowOnce: 'Allow once',
    allowAlways: 'Always allow · {destination}',
    destinationMenu: 'Where should the rule be remembered?',
    destinations: {
      session: 'This session',
      localSettings: 'This project (local)',
      projectSettings: 'This project (shared)',
      userSettings: 'All projects (global)',
    } satisfies Record<RuleDestination, string>,
    destinationHints: {
      session: 'Forgotten when the session ends.',
      localSettings: 'Saved in .claude/settings.local.json – not committed.',
      projectSettings: 'Writes .claude/settings.json into the repository.',
      userSettings: 'Applies to every project of this profile.',
    } satisfies Record<RuleDestination, string>,
    writesToRepo: 'Writes to repo',
    global: 'Global',
    remembers: 'Remembers {rules}',
    folders: 'Folders: {folders}',
    noGuarantee: 'Claude Code may still ask again, e.g. for paths outside the project.',
    acceptEdits: 'Allow + accept edits',
    acceptEditsHint: 'Also switches this session to “Accept edits”.',
    deny: 'Deny',
    denyMenu: 'More ways to deny',
    denyWithReason: 'Deny with a reason…',
    denyAndStop: 'Deny and stop the turn…',
    reasonLabel: 'Reason for Claude',
    reasonOptional: 'Reason for Claude (optional)',
    reasonPlaceholder: 'What should Claude do instead?',
    sendDenial: 'Send denial',
    sendDenialAndStop: 'Deny and stop',
    stopHint: 'Stops the whole turn – background subagents end too.',
    defaultToNo: 'Claude Code suggests denying this request.',
    blockedPath: 'Outside the allowed folders: {path}',
    mcpServer: 'MCP server {name}',
    reason: 'Reason: {reason}',
    showChange: 'Change',
    showInput: 'Input',
    inputTruncated: 'The input was shortened for display.',
  },
  question: {
    title: { one: 'Claude has a question', other: 'Claude has {count} questions' },
    multiSelect: 'Select one or more',
    otherOption: 'Other',
    otherPlaceholder: 'Your own answer',
    notes: 'Note for Claude (optional)',
    notesPlaceholder: 'Add context to your answer',
    preview: 'Preview: {label}',
    answer: 'Answer',
    decline: 'Skip',
    incomplete: 'Answer every question to send.',
  },
  plan: {
    ready: 'Plan v{version} ready',
    approve: 'Implement · {mode}',
    approveMenu: 'How should Claude implement the plan?',
    /** Menu entries; the button shows the mode label of the shell (`shell.permissionMode.*`). */
    modes: {
      auto: 'With auto mode',
      acceptEdits: 'Accept edits automatically',
      default: 'Manual – approve each change',
      plan: 'Stay in plan mode',
      dontAsk: 'Without asking',
      bypassPermissions: 'Without permission checks (bypass)',
    } satisfies Record<PermissionMode, string>,
    freshContext: 'With fresh context',
    freshContextHint: 'Available in a later version.',
    keepPlanning: 'Keep planning',
    keepPlanningHint: 'Type your feedback in the message field – Claude revises the plan.',
    keepPlanningSendHint: 'Sends the text of the message field as feedback – Claude revises the plan.',
    open: 'Open plan',
    close: 'Close plan',
    context: 'Context',
    untitled: 'Plan',
  },
  expired: {
    badge: 'Expired',
    /** Title of an expired plan card (not "ready" any more, V2-08). */
    planTitle: 'Plan v{version}',
    description: 'Parallax restarted while this was open, so Claude stopped. Continue the session.',
    resume: 'Continue',
    resumeApprove: 'Continue & implement · {mode}',
  },
  transcript: {
    goTo: 'Go to decision',
    waiting: 'Waiting for your decision in the bar above the message field.',
    expired: 'Expired – continue in the bar above the message field.',
    showMore: 'Show full plan',
    showLess: 'Show less',
  },
  panel: {
    title: 'Plan v{version}',
    close: 'Close plan',
    file: 'Plan file',
    goTo: 'Go to decision',
    closed: 'This decision is no longer open.',
  },
  shortcuts: {
    respond: 'Decision bar: answer with the focused button or the main action',
  },
  notices: {
    elsewhere: {
      allowed: 'A permission was granted in another window.',
      denied: 'A permission was denied in another window.',
      answered: 'A question was answered in another window.',
      declined: 'A question was skipped in another window.',
      plan_approved: 'The plan was approved in another window.',
      plan_revised: 'The plan was sent back for revision in another window.',
      expired: 'An expired decision was closed.',
    } satisfies Record<ResolvedOutcome, string>,
    withdrawn: {
      signal_aborted: 'Claude withdrew a request.',
      interrupted: 'A request ended because the turn was stopped.',
      process_exit: 'A request ended because the session stopped.',
      conversation_reset: 'A request ended because the conversation was reset.',
    } satisfies Record<CancelReason, string>,
    gone: 'A decision is no longer open.',
  },
};
