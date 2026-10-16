/**
 * Default answers of the FakeBackend's read-only calls (WP-13 §3.3) when the scenario did not
 * record one: `getContextUsage` grows per turn, `supportedModels` like auth-probe#24 (as a
 * constant, no runtime dependency on fixture files), a short `supportedCommands` list.
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
      { name: 'System prompt', tokens: 3_000, color: 'promptBorder', kind: 'used' },
      { name: 'System tools', tokens: system - 3_000, color: 'inactive', kind: 'used' },
      { name: 'Messages', tokens: messages, color: 'purple', kind: 'used' },
      { name: 'Autocompact buffer', tokens: 33_000, color: 'inactive', kind: 'buffer' },
      {
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

/** `supportedModels()` like auth-probe#24 (CLI 2.1.300, cleaned). */
export const FAKE_MODELS: readonly Record<string, unknown>[] = [
  {
    value: 'default',
    resolvedModel: 'claude-opus-5-5',
    displayName: 'Default (recommended)',
    description: 'Opus 5.5 · Best for everyday, complex tasks',
    supportsEffort: true,
    supportedEffortLevels: ['low', 'medium', 'high', 'xhigh', 'max'],
    supportsAdaptiveThinking: true,
    supportsFastMode: true,
    supportsAutoMode: true,
    supportsThinkingOff: false,
  },
  {
    value: 'opus',
    resolvedModel: 'claude-opus-5-5',
    displayName: 'Opus',
    description: 'Opus 5.5 · Best for everyday, complex tasks',
    supportsEffort: true,
    supportedEffortLevels: ['low', 'medium', 'high', 'xhigh', 'max'],
    supportsAdaptiveThinking: true,
    supportsFastMode: true,
    supportsAutoMode: true,
    supportsThinkingOff: false,
  },
  {
    value: 'claude-fable-5-1[1m]',
    resolvedModel: 'claude-fable-5-1',
    displayName: 'Fable',
    description: 'Fable 5.1 · Most capable for your hardest and longest-running tasks',
    supportsEffort: true,
    supportedEffortLevels: ['low', 'medium', 'high', 'xhigh', 'max'],
    supportsAdaptiveThinking: true,
    supportsAutoMode: true,
    supportsThinkingOff: false,
  },
  {
    value: 'sonnet',
    resolvedModel: 'claude-sonnet-5-5',
    displayName: 'Sonnet',
    description: 'Sonnet 5.5 · Efficient for routine tasks',
    supportsEffort: true,
    supportedEffortLevels: ['low', 'medium', 'high', 'xhigh', 'max'],
    supportsAdaptiveThinking: true,
    supportsAutoMode: true,
    supportsThinkingOff: false,
  },
  {
    value: 'haiku',
    resolvedModel: 'claude-haiku-5-5',
    displayName: 'Haiku',
    description: 'Haiku 5.5 · Fastest for quick answers',
    supportsEffort: true,
    supportedEffortLevels: ['low', 'medium', 'high', 'xhigh', 'max'],
    supportsAdaptiveThinking: true,
    supportsAutoMode: true,
    supportsThinkingOff: false,
  },
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
