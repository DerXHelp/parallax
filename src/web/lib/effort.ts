import type { EffortLevel } from '@shared/common';

/**
 * The effort a session actually runs with (WP-63 §1.1): the session's own value
 * (`summary.effort` – set by the user, or the profile default taken over at creation); without
 * one the level the CLI reported at its start (`init.effort` – its default for the model), then
 * the profile default; null when nothing is known (then nothing is shown).
 */
export function effectiveEffort(sources: {
  effort: EffortLevel | null;
  initEffort?: EffortLevel | null;
  profileEffort?: EffortLevel | null;
}): EffortLevel | null {
  return sources.effort ?? sources.initEffort ?? sources.profileEffort ?? null;
}
