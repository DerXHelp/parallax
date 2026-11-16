/**
 * WP-73: Claude's own settings of the fake CLI – `model` and `modelPicker` – one per backend (like the
 * user's settings.json, shared by every fake session). `readClaudeSettings()` reports them; a start
 * without `model` runs on `model`; `supportedModels()` follows them like CLI 2.1.323 (`Fwe(lle())`):
 * the built-in rows (only Default with `replaceBuiltInOptions`), then the curated rows not listed yet
 * (a curated row for a listed model does not replace the built-in row), then a tail row for the
 * session's current model when no row has it (`opusplan` → "Opus Plan").
 * Levers: FakeBackendOptions.claudeSettings (tests) and the keywords `fake:claude-model <model|none>`
 * and `fake:model-picker [replace|off]` (dev, E2E; interactive.ts).
 */
import { modelNameSchema } from '@shared/common';
import { modelPickerOf } from '../claudeSettings';
import type { ClaudeSettings } from '../types';
import { FAKE_MODELS } from './defaults';
import type { DslContext } from './dsl';
import { answerTurn, type Turn } from './turn';
import type { FakeScriptContext } from './types';

export interface FakeModelPickerRow {
  model: string;
  label?: string;
  description?: string;
}

/** Shape of the settings key (`modelPicker`). */
export interface FakeModelPicker {
  options: FakeModelPickerRow[];
  replaceBuiltInOptions?: boolean;
}

export interface FakeClaudeSettingsOptions {
  /** Settings `model` (e.g. 'opusplan'); default none. */
  model?: string | null;
  /** Settings `modelPicker`; default none. */
  modelPicker?: FakeModelPicker | null;
}

/** `fake:model-picker`: one row the built-in list lacks, one it already has (stays the built-in row). */
export const FAKE_MODEL_PICKER: FakeModelPicker = {
  options: [
    { model: 'sonnet[1m]', label: 'Sonnet 1M', description: 'Sonnet with the long context window' },
    { model: 'claude-opus-4-8', label: 'Opus 4.8 (pinned)' },
  ],
};

/** "Opus Plan" of the CLI (`KI('opusplan')`); outside plan mode it answers with Sonnet. */
export const FAKE_OPUSPLAN_ROW: Readonly<Record<string, unknown>> = Object.freeze({
  value: 'opusplan',
  resolvedModel: 'claude-sonnet-5-5',
  displayName: 'Opus Plan',
  description: 'Opus in plan mode, else Sonnet',
  supportsEffort: true,
  supportedEffortLevels: ['low', 'medium', 'high', 'xhigh', 'max'],
  supportsAdaptiveThinking: true,
  supportsAutoMode: true,
  supportsThinkingOff: false,
});

export class FakeClaudeSettings {
  model: string | null;
  modelPicker: FakeModelPicker | null;

  constructor(options: FakeClaudeSettingsOptions = {}) {
    this.model = options.model ?? null;
    this.modelPicker = options.modelPicker ?? null;
  }

  /** What `getSettings()` would yield through `claudeSettingsOf` (without remoteControlAtStartup). */
  snapshot(): Omit<ClaudeSettings, 'remoteControlAtStartup'> {
    return { model: this.model, modelPicker: modelPickerOf(this.modelPicker) };
  }
}

function curatedRow(row: FakeModelPickerRow): Record<string, unknown> {
  const known = FAKE_MODELS.find((m) => m.value === row.model);
  const displayName = typeof known?.displayName === 'string' ? known.displayName : row.model;
  return {
    ...(known ?? { resolvedModel: row.model, supportsAutoMode: true }),
    value: row.model,
    displayName: row.label ?? displayName,
    description: row.description ?? `Custom model (${row.model})`,
  };
}

function tailRow(value: string): Record<string, unknown> {
  if (value === 'opusplan') return { ...FAKE_OPUSPLAN_ROW };
  return { value, resolvedModel: value, displayName: value, description: 'Custom model' };
}

/**
 * `supportedModels()` of a fake session whose current model is `current` (the alias as set; null =
 * none set, the settings model applies).
 */
export function fakeModelList(
  settings: FakeClaudeSettings,
  current: string | null,
): Record<string, unknown>[] {
  const rows = (settings.modelPicker?.options ?? []).filter((row) => row.model.trim() !== '');
  let list: Record<string, unknown>[];
  if (settings.modelPicker?.replaceBuiltInOptions === true && rows.length > 0) {
    list = [...FAKE_MODELS.filter((m) => m.value === 'default'), ...rows.map(curatedRow)];
  } else {
    list = [...FAKE_MODELS];
    for (const row of rows) if (!list.some((m) => m.value === row.model)) list.push(curatedRow(row));
  }
  const effective = current ?? settings.model;
  if (effective !== null && effective !== 'default' && !list.some((m) => m.value === effective)) {
    list.push(tailRow(effective));
  }
  return list;
}

// ---- keywords (interactive.ts) ----

export const FAKE_CLAUDE_SETTINGS_KEYWORDS = ['fake:claude-model', 'fake:model-picker'] as const;
export type FakeClaudeSettingsKeyword = (typeof FAKE_CLAUDE_SETTINGS_KEYWORDS)[number];

export function isFakeClaudeSettingsKeyword(keyword: string): keyword is FakeClaudeSettingsKeyword {
  return (FAKE_CLAUDE_SETTINGS_KEYWORDS as readonly string[]).includes(keyword);
}

/**
 * `fake:claude-model <model|none>` (settings `model`; without a valid name: none) and
 * `fake:model-picker [replace|off]` (FAKE_MODEL_PICKER, with `replaceBuiltInOptions`, or none). Like
 * an edited settings.json: the next start, model refresh and getSettings see it; the running
 * session keeps its model. Answers with a short turn.
 */
export async function claudeSettingsKeyword(
  ctx: FakeScriptContext,
  c: DslContext,
  turn: Turn,
  keyword: FakeClaudeSettingsKeyword,
  text: string,
): Promise<void> {
  const arg = (text.split(/\s+/)[1] ?? '').trim();
  let answer: string;
  if (keyword === 'fake:claude-model') {
    const parsed = modelNameSchema.safeParse(arg);
    ctx.claudeSettings.model = parsed.success && arg.toLowerCase() !== 'none' ? parsed.data : null;
    answer = `Fake: Claude settings model ${ctx.claudeSettings.model ?? 'none'}.`;
  } else if (arg.toLowerCase() === 'off') {
    ctx.claudeSettings.modelPicker = null;
    answer = 'Fake: Claude modelPicker off.';
  } else {
    const replace = arg.toLowerCase() === 'replace';
    ctx.claudeSettings.modelPicker = { ...FAKE_MODEL_PICKER, replaceBuiltInOptions: replace };
    answer = `Fake: Claude modelPicker on${replace ? ' (replaces the built-in list)' : ''}.`;
  }
  await answerTurn(ctx, c, turn, answer);
}
