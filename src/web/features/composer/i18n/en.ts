import type { EffortLevel, PermissionMode } from '@shared/common';
import type { ContextBreakdown } from '@shared/model';

type CategoryKind = ContextBreakdown['categories'][number]['kind'];

/**
 * English dictionary of the `composer` namespace (owner WP-16): `t('composer.<path>')`.
 * Registered statically in src/web/i18n/index.ts (stub created by WP-14). Leaves are strings or
 * plural forms `{ one, other }`; never use `other` as a namespace key.
 */
export const en = {
  label: 'Message to Claude',
  toolbar: 'Session controls',
  placeholder: {
    idle: 'Message Claude…',
    working: 'Queue a message – Claude reads it after the current step…',
    permission: 'Tell Claude what to do instead…',
    question: 'Answer in your own words…',
    plan: 'Feedback on the plan…',
  },
  send: 'Send',
  queue: 'Queue',
  sendNow: 'Send now',
  sendNowHint: 'Interrupts the current step and sends right away.',
  answer: 'Send as answer',
  answerPlan: 'Keep planning with feedback',
  moreSend: 'More send options',
  sendAsMessage: 'Send as new message instead',
  stop: 'Stop',
  stopHint: 'Stops Claude (Esc in an empty message field).',
  notConnected: 'Not connected',
  tooLong: 'Too long – at most {max} characters.',
  target: {
    permission: 'Answering the {tool} permission ({requester}) – sending denies it with your text.',
    question: 'Answering the question ({requester}) – sending skips it with your text.',
    plan: 'Answering plan v{version} – sending your feedback keeps Claude planning.',
  },
  queueList: {
    label: 'Queued messages',
    title: { one: '{count} queued message', other: '{count} queued messages' },
    sending: 'sending',
    queued: 'queued',
    now: 'now',
  },
  mode: {
    label: 'Permission mode',
    unknown: 'Unknown mode',
    modes: {
      default: 'Manual',
      acceptEdits: 'Accept edits',
      plan: 'Plan',
      auto: 'Auto',
      dontAsk: "Don't ask",
      bypassPermissions: 'Bypass permissions',
    } satisfies Record<PermissionMode, string>,
    hints: {
      default: 'Claude asks before every change and command.',
      acceptEdits: 'File edits run without asking; commands still ask.',
      plan: 'Claude only reads and plans – nothing is changed.',
      auto: 'Claude decides itself what needs a question.',
      dontAsk: 'Set outside Parallax.',
      bypassPermissions: 'No permission checks at all – only for isolated environments.',
    } satisfies Record<PermissionMode, string>,
    autoUnavailable: 'Not supported by the current model.',
    switching: 'Switching mode…',
  },
  model: {
    label: 'Model',
    default: 'Default model',
    loading: 'Loading models…',
    unavailable: 'The model list is available while the session runs.',
    effort: 'Effort',
    effortDefault: 'Default',
    effortLevels: {
      low: 'Low',
      medium: 'Medium',
      high: 'High',
      xhigh: 'Extra high',
      max: 'Max',
    } satisfies Record<EffortLevel, string>,
    fast: 'Fast mode',
  },
  context: {
    label: 'Context',
    button: 'Context {percent} – show details',
    unknown: 'Context not measured yet',
    title: 'Context window',
    tokens: '{used} of {max} tokens',
    source: {
      sdk: 'Measured after the last turn',
      estimate: 'Estimated during the turn',
    },
    model: 'Model: {model}',
    breakdown: 'Breakdown',
    loading: 'Loading breakdown…',
    unavailable: 'The breakdown is available while the session runs.',
    kinds: {
      used: 'used',
      free: 'free',
      buffer: 'reserved',
      deferred: 'deferred',
    } satisfies Record<CategoryKind, string>,
    autoCompact: 'Auto-compact at {tokens} tokens',
    autoCompactOff: 'Auto-compact is off',
    compact: 'Compact now',
    compactHint: 'Sends /compact – Claude summarizes the conversation to free context.',
  },
};
