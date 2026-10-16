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
    questions: 'Tell Claude why you skip the questions…',
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
  counter: '{count} / {max} characters',
  /** Enter answers this decision (it was open before the draft began, R2W-01). */
  target: {
    permission: 'Answering the {tool} permission ({requester}) – Enter denies it with your text.',
    question: 'Answering the question ({requester}) – Enter answers it with your text.',
    questions: 'Answering the questions ({requester}) – Enter skips them with your text.',
    plan: 'Answering plan v{version} – Enter sends your feedback, Claude keeps planning.',
  },
  /** A decision is open, but Enter sends a normal message (appeared while typing, subagent, …). */
  pending: {
    permission:
      'The {tool} permission ({requester}) is open – Enter sends a new message, “Send as answer” denies it with your text.',
    question:
      'A question ({requester}) is open – Enter sends a new message, “Send as answer” answers it with your text.',
    questions:
      'Questions ({requester}) are open – Enter sends a new message, “Send as answer” skips them with your text.',
    plan: 'Plan v{version} is open – Enter sends a new message, “Keep planning with feedback” sends your text as feedback.',
  },
  mode: {
    label: 'Permission mode',
    /** Accessible name of the picker button (one key with the value, R3-17). */
    trigger: 'Permission mode: {mode}',
    unknown: 'Unknown mode',
    /** No `init` yet (V2-05): the CLI starts with the mode of its own settings. */
    notStarted: 'CLI default',
    notStartedHint:
      'Not started yet: Claude Code starts with the default mode of its settings – or the mode you pick here.',
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
    trigger: 'Model: {model}',
    default: 'Default model',
    defaultActual: '{label} · {model}',
    actual: 'Currently running on {model}',
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
    categoriesSource:
      'Categories as reported by the Agent SDK – the total matches /context, the split into categories can differ.',
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
