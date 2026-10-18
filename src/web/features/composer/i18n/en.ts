import type { EffortLevel, PermissionMode } from '@shared/common';
import type { ContextBreakdown } from '@shared/model';
import type { MenuKind, NativeCommand } from '../lib/slash';

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
  /** Send button while the draft is a command Parallax runs itself (/model, /status …). */
  run: 'Run',
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
    /** `/effort` without a level when the model has no effort setting. */
    effortUnavailable: 'The current model has no effort setting.',
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
  /** Slash menu and `/` commands (WP-37, ADR-108). */
  slash: {
    menu: 'Commands',
    /** Accessible description of the field while the menu is open. */
    menuHint: 'Arrow keys choose a command, Tab or Enter takes it, Esc closes the list.',
    /** Accessible text of the argument hint shown after `/name `. */
    argumentHint: 'Arguments: {hint}',
    kinds: {
      native: 'Parallax',
      builtin: 'Claude Code',
      custom: 'Skill/command',
      mcp: 'MCP',
    } satisfies Record<Exclude<MenuKind, 'plain'>, string>,
    native: {
      model: 'Switch the model – without a name the model picker opens',
      effort: 'Set the effort – without a level the effort menu opens',
      fast: 'Fast mode on or off – without an argument it toggles',
      plan: 'Switch to plan mode – a text after it is sent right away',
      rename: 'Rename the session – without a name the title becomes editable',
      status: 'Session info: model, folder, versions',
      help: 'All commands and keyboard shortcuts',
      resume: 'Earlier conversations of this session',
    } satisfies Record<NativeCommand, string>,
    nativeArguments: {
      model: '[model]',
      effort: '[low|medium|high|xhigh|max]',
      fast: '[on|off]',
      plan: '[text]',
      rename: '[name]',
    },
    error: {
      invalidModel: '“{name}” is not a valid model name.',
      invalidEffort: 'Unknown effort “{value}” – use one of {levels}.',
      invalidFast: 'Use /fast on or /fast off.',
      fastUnavailable: 'Fast mode is not available for the current model.',
      titleTooLong: 'The name is too long – at most {max} characters.',
      unavailable: '/{command} is not available here.',
    },
    terminal: {
      title: '/{command} only works in the terminal of Claude Code',
      description:
        'Parallax has no terminal view. Open the session in an external console and use the command there.',
      open: 'Open in external console',
      dismiss: 'Close hint',
    },
  },
  help: {
    title: 'Commands',
    description:
      'Type / in the message field to search them. Parallax commands open their own controls, all others are sent to Claude Code.',
    native: 'Parallax',
    builtin: 'Claude Code',
    custom: 'Skills and own commands',
    mcp: 'MCP prompts',
    plain: 'More commands',
    noCatalog: 'Descriptions of the Claude Code commands arrive once the session has started.',
    aliases: 'also {aliases}',
    terminal: 'Only in the terminal: {commands}',
    shortcuts: 'Keyboard shortcuts',
  },
  attachments: {
    list: 'Attached images',
    add: 'Attach images',
    remove: 'Remove {name}',
    chip: '{name}: {status}',
    status: {
      preparing: 'Preparing…',
      uploading: 'Uploading…',
      done: 'Ready',
      error: 'Failed',
    },
    problem: {
      type: 'Not an image of a supported type.',
      decode: 'The image could not be read.',
      tooLarge: 'Too large, even after shrinking.',
    },
    onlyImages: 'Only images can be attached (PNG, JPEG, WebP, GIF).',
    tooMany: 'At most {max} images per message.',
    pending: 'Uploading images…',
    removeFailed: 'Remove the failed image to send.',
    drop: 'Drop images to attach them',
  },
  /** Prompt suggestion as ghost text (ADR-117). */
  suggestion: {
    hint: 'Suggestion: press Tab to take it.',
  },
  /** Rate-limit banner (ADR-112). */
  rateLimit: {
    limited: 'Usage limit reached – resets at {time}',
    continueAt: 'Continue at {time}',
    scheduled: 'Continue planned at {time}',
    cancel: 'Cancel',
    expired: 'The usage limit has been reset.',
    continue: 'Continue',
  },
  /** Archived or handed off: no input field (the pane banner offers the actions). */
  disabled: {
    archived: 'Archived – read only.',
    external: 'Open in an external console – take it back to write here.',
  },
};
