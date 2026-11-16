/**
 * WP-73: Claude's own settings as `getSettings()` reports them (internal in SDK 0.3.322; answer
 * `{effective, sources: [{source, settings}], applied}` – checked in the CLI 2.1.323 binary). Pure,
 * tolerant parsing (zod): unknown keys are ignored, a value of the wrong type counts as not set.
 * Used by SdkBackend (`readClaudeSettings`, ADR-201); WP-64's `remoteControlAtStartup` reads here too.
 *
 * - `model` = what the CLI runs without `--model`: `ANTHROPIC_MODEL` (the settings `env` is assigned
 *   into the process env at start, so it wins over the launch env), else settings `model`.
 * - `modelPicker` is honored only from managed, `--settings`/SDK and user settings; the highest
 *   source that defines it wins outright. `sources` decides (a project file may carry one that the
 *   CLI ignores); without usable `sources` the merged `effective` value is taken.
 */
import { z } from 'zod';
import { modelNameSchema } from '@shared/common';
import { getEnvVar } from '../lib/windows';
import type { ClaudeModelPicker, ClaudeSettings } from './types';

/** At most this many curated rows are kept (a settings file is user input). */
export const MODEL_PICKER_ROWS_MAX = 100;

/** Source names of `getSettings().sources`, highest precedence first, that may define `modelPicker`. */
const PICKER_SOURCES = ['policySettings', 'flagSettings', 'userSettings'] as const;

const pickerSchema = z.looseObject({
  options: z.array(z.unknown()),
  replaceBuiltInOptions: z.unknown().optional(),
});

const pickerRowSchema = z.looseObject({ model: z.string() });

const settingsSchema = z.looseObject({
  model: z.unknown().optional(),
  modelPicker: z.unknown().optional(),
  remoteControlAtStartup: z.unknown().optional(),
  env: z.record(z.string(), z.unknown()).optional().catch(undefined),
});

const answerSchema = z.looseObject({
  effective: settingsSchema.optional().catch(undefined),
  sources: z.array(z.unknown()).optional().catch(undefined),
});

const sourceSchema = z.looseObject({ source: z.string(), settings: settingsSchema });

type SettingsShape = z.infer<typeof settingsSchema>;

function modelNameOf(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const parsed = modelNameSchema.safeParse(value.trim());
  return parsed.success ? parsed.data : null;
}

/**
 * `modelPicker` value → port shape; null when it is not an object with an `options` array or no row
 * names a usable model (the CLI then keeps its built-in list, `replaceBuiltInOptions` included).
 */
export function modelPickerOf(value: unknown): ClaudeModelPicker | null {
  const parsed = pickerSchema.safeParse(value);
  if (!parsed.success) return null;
  const models: string[] = [];
  for (const row of parsed.data.options) {
    const model = pickerRowSchema.safeParse(row);
    const name = model.success ? modelNameOf(model.data.model) : null;
    if (name === null || models.includes(name)) continue;
    models.push(name);
    if (models.length >= MODEL_PICKER_ROWS_MAX) break;
  }
  if (models.length === 0) return null;
  return { models, replaceBuiltIn: parsed.data.replaceBuiltInOptions === true };
}

/** The `settings` of every usable entry of `sources`, by source name (the last one per name wins). */
function settingsBySource(sources: readonly unknown[] | undefined): Map<string, SettingsShape> | null {
  if (sources === undefined) return null;
  const bySource = new Map<string, SettingsShape>();
  for (const entry of sources) {
    const parsed = sourceSchema.safeParse(entry);
    if (parsed.success) bySource.set(parsed.data.source, parsed.data.settings);
  }
  return bySource;
}

function pickerFrom(effective: SettingsShape | undefined, bySource: Map<string, SettingsShape> | null) {
  if (bySource !== null) {
    for (const source of PICKER_SOURCES) {
      const value = bySource.get(source)?.modelPicker;
      if (value !== undefined) return modelPickerOf(value);
    }
    return null;
  }
  return effective?.modelPicker === undefined ? null : modelPickerOf(effective.modelPicker);
}

function envModel(env: Readonly<Record<string, unknown>> | undefined): string | null {
  if (env === undefined) return null;
  const strings = Object.fromEntries(
    Object.entries(env).flatMap(([key, value]) => (typeof value === 'string' ? [[key, value]] : [])),
  );
  return modelNameOf(getEnvVar(strings, 'ANTHROPIC_MODEL'));
}

/**
 * Raw `getSettings()` answer → port result; null when the answer has neither `effective` nor
 * `sources`. `launchEnv` = the env the process was started with (LaunchSpec.env).
 */
export function claudeSettingsOf(
  raw: unknown,
  launchEnv: Readonly<Record<string, string | undefined>>,
): ClaudeSettings | null {
  const parsed = answerSchema.safeParse(raw);
  if (!parsed.success) return null;
  const { effective, sources } = parsed.data;
  if (effective === undefined && sources === undefined) return null;
  const remote = effective?.remoteControlAtStartup;
  return {
    remoteControlAtStartup: typeof remote === 'boolean' ? remote : null,
    model:
      envModel(effective?.env) ??
      modelNameOf(getEnvVar(launchEnv, 'ANTHROPIC_MODEL')) ??
      modelNameOf(effective?.model),
    modelPicker: pickerFrom(effective, settingsBySource(sources)),
  };
}
