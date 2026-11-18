import type { PermissionMode } from '@shared/common';

/** Offered modes in the picker's order (Plan "Kopfleiste"; `dontAsk` never, bypass appended when allowed). */
export const OFFERED_PERMISSION_MODES: readonly PermissionMode[] = ['default', 'acceptEdits', 'plan', 'auto'];

export interface ModeAvailability {
  /** The session's profile allows bypass (`ProfileSummary.allowsBypass`). */
  allowsBypass: boolean;
  /** The model the session runs on supports auto mode. */
  autoSupported: boolean;
}

/** The modes of the picker that can be chosen now, in its order. */
export function offeredModes({ allowsBypass }: Pick<ModeAvailability, 'allowsBypass'>): PermissionMode[] {
  return allowsBypass ? [...OFFERED_PERMISSION_MODES, 'bypassPermissions'] : [...OFFERED_PERMISSION_MODES];
}

/** What Shift+Tab cycles through (WP-91): the picker's order without the modes not available now. */
export function cycleModes(availability: ModeAvailability): PermissionMode[] {
  return offeredModes(availability).filter((mode) => mode !== 'auto' || availability.autoSupported);
}

/**
 * The mode after `current` in `modes` (wraps around). Not reported yet (null) counts as `default`;
 * a mode outside the cycle (`dontAsk`, an unavailable `auto`) continues with the first one.
 */
export function nextPermissionMode(
  current: PermissionMode | null,
  modes: readonly PermissionMode[],
): PermissionMode | null {
  if (modes.length === 0) return null;
  const index = modes.indexOf(current ?? 'default');
  return modes[(index + 1) % modes.length] ?? null;
}
