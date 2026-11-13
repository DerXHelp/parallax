import type { EffortLevel, PermissionMode } from '@shared/common';
import type { ContextBreakdown } from '@shared/model';
import type { ContextCategoryId } from '../lib/context';
import type { MenuKind, NativeCommand } from '../lib/slash';
import type { AttachmentKind } from '../state/attachments';

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
  /** WP-65 §1.5: `session.backgroundTasks` without a tool call (like Ctrl+B in the terminal). */
  backgroundAll: 'Move all to background',
  backgroundAllHint: 'Running commands and subagents continue as background tasks (Ctrl+B).',
  backgroundAllShortcut: 'Move running commands and subagents to the background',
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
    /** WP-57: heading of the full model ids below the aliases. */
    more: 'More models',
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
    /** WP-57: names of the stable SDK category ids (others keep the SDK's name). */
    categories: {
      system_prompt: 'System prompt',
      system_tools: 'System tools',
      mcp_tools: 'MCP tools',
      mcp_instructions: 'MCP instructions',
      custom_agents: 'Custom agents',
      memory_files: 'Memory files',
      skills: 'Skills',
      messages: 'Messages',
      mcp_tools_deferred: 'MCP tools (deferred)',
      system_tools_deferred: 'System tools (deferred)',
      autocompact_buffer: 'Auto-compact buffer',
      compact_buffer: 'Compact buffer',
      free_space: 'Free space',
    } satisfies Record<ContextCategoryId, string>,
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
  /** Images, PDFs and other files (ADR-103, ADR-146). */
  attachments: {
    list: 'Attachments',
    add: 'Attach files',
    remove: 'Remove {name}',
    chip: '{name}: {status}',
    /** PDF and file chips: kind and size in the accessible name. */
    chipFile: '{name} ({kind}, {size}): {status}',
    kind: {
      image: 'Image',
      pdf: 'PDF',
      file: 'File',
    } satisfies Record<AttachmentKind, string>,
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
    /** A PDF or file over its limit (`max` e.g. "10 MB") – not uploaded. */
    fileTooLarge: 'File too large (max. {max})',
    /** ADR-146: dropped folders are left out. */
    folders: 'Folders are not attached – insert their path with @.',
    tooMany: 'At most {max} attachments per message.',
    pending: 'Uploading attachments…',
    removeFailed: 'Remove the failed attachment to send.',
    /** ADR-125/146: on the chips beyond the total limit of one message (`max` e.g. "20 MB"). */
    overTotal: 'Images and PDFs together over {max}',
    removeTooLarge: 'Images and PDFs are too large together – remove one to send.',
    /** R4W-26: an answer to a decision carries no attachments. */
    notWithAnswer: 'The attachments stay for your next message – an answer is sent without them.',
    drop: 'Drop files to attach them',
  },
  /** Large pasted texts as chips (ADR-146, WP-57). */
  pastes: {
    list: 'Pasted texts',
    /** The token in the field where the text stands (`{id}` = #k). */
    token: { one: '[#{id} · {count} line]', other: '[#{id} · {count} lines]' },
    chip: { one: 'Pasted text #{id} · {count} line', other: 'Pasted text #{id} · {count} lines' },
    convert: 'Convert to text',
    convertLabel: 'Convert pasted text #{id} to text',
    remove: 'Remove pasted text #{id}',
    /** Under a cut preview. */
    previewCut: 'Preview of the first {count} characters.',
    /** The paste went into the field as text (`LIMITS.pastesMax` chips already). */
    asTextCount: 'At most {max} pasted texts as chips – this one went into the field as text.',
    /** The paste went into the field as text (the draft would get too large to keep). */
    asTextSize: 'The draft is large – this paste went into the field as text.',
  },
  /** @ file picker (ADR-151, WP-57). */
  mention: {
    list: 'Project files',
    menuHint: 'Arrow keys choose a file, Tab or Enter inserts its path, Esc closes the list.',
    loading: 'Loading project files…',
    failed: 'The project files could not be loaded.',
    empty: 'No matching file.',
    noFiles: 'No files in the project folder.',
    truncated: 'Only part of the project is listed – keep typing to narrow it down.',
    more: 'Showing {shown} of {total} matches – keep typing to narrow it down.',
    /** Next to `truncated` (which already says "keep typing"). */
    moreShort: 'Showing {shown} of {total} matches.',
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
    external: 'Opened in an external console – take it back to write here.',
  },
};
