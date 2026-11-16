/**
 * WP-73: Claude's own settings in the engine (ADR-199, ADR-200). After every readiness and model
 * refresh of a process (`AgentSession.readClaudeSettings`, ONE getSettings request):
 * - `entry.claudeModel` = what "Default" (`modelSetting` null) means for the entry: the profile's
 *   `--model`, else the model Claude's settings name (`ANTHROPIC_MODEL`, settings `model`, e.g.
 *   'opusplan'). Unknown settings keep the last value.
 * - The profile's model catalog gets the `curated` flags of Claude's `modelPicker` and keeps the
 *   entry's tail row (`withClaudeSettings`); `detail.models` is patched only when it changed.
 * WP-64's `remoteControlAtStartup` reaches remoteControlAfterReady from the same answer.
 */
import { isDeepStrictEqual } from 'node:util';
import { modelNameSchema } from '@shared/common';
import type { ClaudeSettings } from '../backend/types';
import type { LaunchSpec } from '../claude/ports';
import type { EngineCore, EntryState } from './entryState';
import { withClaudeSettings, type ModelCatalog } from './models';

/** A valid model name (Entry.claudeModel is persisted under `modelNameSchema`), else null. */
function validModel(value: string | null | undefined): string | null {
  if (value === null || value === undefined) return null;
  const parsed = modelNameSchema.safeParse(value);
  return parsed.success ? parsed.data : null;
}

/** The model a process of `launch` runs on without `modelSetting`; `settings` null = unknown → `previous`. */
export function claudeModelOf(
  launch: Pick<LaunchSpec, 'sdkOptions'>,
  settings: ClaudeSettings | null,
  previous: string | null,
): string | null {
  const profileModel = validModel(launch.sdkOptions.model);
  if (profileModel !== null) return profileModel;
  return settings === null ? previous : validModel(settings.model);
}

/** Stores `claudeModel` on the entry when it changed. */
export function updateClaudeModel(s: EntryState, claudeModel: string | null): void {
  if (s.entry.claudeModel !== claudeModel) s.patch((e) => ({ ...e, claudeModel }));
}

/**
 * A fresh catalog of the entry's process plus Claude's settings → entry, profile catalog and the
 * entry's `detail.models`. Returns the stored catalog.
 */
export function applyModelSettings(
  core: EngineCore,
  s: EntryState,
  launch: Pick<LaunchSpec, 'sdkOptions'>,
  fresh: ModelCatalog,
  settings: ClaudeSettings | null,
): ModelCatalog {
  const claudeModel = claudeModelOf(launch, settings, s.entry.claudeModel);
  updateClaudeModel(s, claudeModel);
  const catalog = withClaudeSettings(
    fresh,
    settings === null ? undefined : settings.modelPicker,
    core.models(s.entry.profileId),
    [s.entry.modelSetting, claudeModel],
  );
  core.setModels(s.entry.profileId, catalog);
  if (s.mirror === null || !isDeepStrictEqual(s.mirror.detail.models, catalog.options)) {
    s.emit([{ op: 'detail.patch', patch: { models: catalog.options } }]);
  }
  return catalog;
}
