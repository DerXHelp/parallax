/**
 * Default answers of the FakeBackend's read-only calls (WP-13 §3.3) when the scenario did not
 * record one: `getContextUsage` grows per turn (categories with the stable SDK `id`, WP-52),
 * `supportedModels` like auth-probe#23 (CLI 2.1.322; as a constant, no runtime dependency on
 * fixture files), a short `supportedCommands` list.
 */

/** Context window of the fake answers. */
export const FAKE_CONTEXT_WINDOW = 200_000;

/** Raw `getContextUsage({detail})` answer: 20 000 + 1 500 × turns of 200 000 tokens. */
export function fakeContextUsage(turns: number, model = 'claude-haiku-5-5'): Record<string, unknown> {
  const totalTokens = 20_000 + 1_500 * Math.max(0, turns);
  const system = 14_000;
  const messages = totalTokens - system;
  return {
    categories: [
      { id: 'system_prompt', name: 'System prompt', tokens: 3_000, color: 'promptBorder', kind: 'used' },
      { id: 'system_tools', name: 'System tools', tokens: system - 3_000, color: 'inactive', kind: 'used' },
      { id: 'messages', name: 'Messages', tokens: messages, color: 'purple', kind: 'used' },
      { id: 'autocompact_buffer', name: 'Autocompact buffer', tokens: 33_000, color: 'inactive', kind: 'buffer' },
      {
        id: 'free_space',
        name: 'Free space',
        tokens: FAKE_CONTEXT_WINDOW - totalTokens - 33_000,
        color: 'promptBorder',
        kind: 'free',
      },
    ],
    totalTokens,
    maxTokens: FAKE_CONTEXT_WINDOW,
    rawMaxTokens: FAKE_CONTEXT_WINDOW,
    percentage: Math.round((totalTokens / FAKE_CONTEXT_WINDOW) * 100),
    model,
    autoCompactThreshold: FAKE_CONTEXT_WINDOW - 33_000,
    isAutoCompactEnabled: true,
  };
}

const ALL_EFFORTS = ['low', 'medium', 'high', 'xhigh', 'max'] as const;
const NO_XHIGH = ['low', 'medium', 'high', 'max'] as const;

/** One `supportedModels()` row with effort, adaptive thinking and auto mode (the common case). */
function model(
  value: string,
  resolvedModel: string,
  displayName: string,
  description: string,
  o: { fast?: boolean; thinkingOff: boolean; efforts?: readonly string[] },
): Record<string, unknown> {
  return {
    value,
    resolvedModel,
    displayName,
    description,
    supportsEffort: true,
    supportedEffortLevels: [...(o.efforts ?? ALL_EFFORTS)],
    supportsAdaptiveThinking: true,
    ...(o.fast === true ? { supportsFastMode: true } : {}),
    supportsAutoMode: true,
    supportsThinkingOff: o.thinkingOff,
  };
}

const EVERYDAY = 'Best for everyday, complex tasks';
const HARDEST = 'Most capable for your hardest and longest-running tasks';

/** `supportedModels()` like auth-probe#23 (CLI 2.1.322, 14 rows incl. `fable`; SDK-0.3.322.md §5.8). */
export const FAKE_MODELS: readonly Record<string, unknown>[] = [
  model('default', 'claude-opus-5-5', 'Default (recommended)', `Opus 5.5 · ${EVERYDAY}`, { fast: true, thinkingOff: false }),
  model('opus', 'claude-opus-5-5', 'Opus 5.5', 'For complex work and everyday tasks', { fast: true, thinkingOff: false }),
  model('fable', 'claude-fable-5-2', 'Fable 5.2', 'For your toughest challenges', { fast: true, thinkingOff: false }),
  model('sonnet', 'claude-sonnet-5-5', 'Sonnet 5.5', 'Most efficient for simpler tasks', { thinkingOff: false }),
  model('haiku', 'claude-haiku-5-5', 'Haiku 5.5', 'Fastest for quick answers', { thinkingOff: false }),
  model('claude-fable-5-1', 'claude-fable-5-1', 'Fable 5.1', HARDEST, { thinkingOff: false }),
  {
    value: 'claude-haiku-4-5-20251001',
    resolvedModel: 'claude-haiku-4-5-20251001',
    displayName: 'Haiku 4.5',
    description: 'Fastest for quick answers',
    supportsThinkingOff: true,
  },
  model('claude-sonnet-5', 'claude-sonnet-5', 'Sonnet 5', 'Efficient for routine tasks', { thinkingOff: true }),
  model('claude-opus-5', 'claude-opus-5', 'Opus 5', EVERYDAY, { fast: true, thinkingOff: true }),
  model('claude-fable-5', 'claude-fable-5', 'Fable 5', HARDEST, { thinkingOff: false }),
  model('claude-opus-4-8', 'claude-opus-4-8', 'Opus 4.8', EVERYDAY, { fast: true, thinkingOff: true }),
  model('claude-opus-4-7', 'claude-opus-4-7', 'Opus 4.7', EVERYDAY, { thinkingOff: true }),
  model('claude-opus-4-6', 'claude-opus-4-6', 'Opus 4.6', EVERYDAY, { thinkingOff: true, efforts: NO_XHIGH }),
  model('claude-sonnet-4-6', 'claude-sonnet-4-6', 'Sonnet 4.6', 'Efficient for routine tasks', { thinkingOff: true, efforts: NO_XHIGH }),
];

/** Short `supportedCommands()` list (auth-probe#23 entries). */
export const FAKE_COMMANDS: readonly Record<string, unknown>[] = [
  {
    name: 'clear',
    description:
      'Start a new session with empty context; previous session stays on disk (resumable with /resume)',
    argumentHint: '[name]',
    aliases: ['reset', 'new'],
    builtin: true,
  },
  {
    name: 'compact',
    description: 'Free up context by summarizing the conversation so far',
    argumentHint: '<optional custom summarization instructions>',
    builtin: true,
  },
  { name: 'context', description: 'Show current context usage', argumentHint: '', builtin: true },
  { name: 'model', description: 'Set the AI model for Claude Code', argumentHint: '<model>', builtin: true },
  {
    name: 'rename',
    description: 'Rename the current conversation',
    argumentHint: '[name]',
    aliases: ['name'],
    builtin: true,
  },
];

/**
 * `init.terminal_slash_commands` of the fake CLI (Phase 2, ADR-108): commands that only work in a
 * terminal – the composer hides them and offers "open in external console" instead.
 */
export const FAKE_TERMINAL_COMMANDS: readonly string[] = ['exit', 'statusline', 'vim'];

/** Full model id for an alias/setting (init.model, assistant.model): 'haiku' → 'claude-haiku-5-5'. */
export function resolveFakeModel(model: string | null): string {
  if (model === null) return 'claude-haiku-5-5';
  const known = FAKE_MODELS.find((m) => m.value === model)?.resolvedModel;
  return typeof known === 'string' ? known : model;
}
