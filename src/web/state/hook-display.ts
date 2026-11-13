import { LOCAL_HOST_ID, type HostId } from '@shared/common';
import { HOOK_DISPLAYS, type HookDisplay } from '@shared/model';
import { selectSettings, updateSettings, useSettings } from './settings';
import { clientStore, type ClientStore } from './store';

/**
 * Hook runs in the transcript (WP-69, pattern of `transcript-view.ts`): `failed` (default – only
 * runs that did not succeed, blocking ones included), `all` (successful runs as steps of the
 * compact groups, a quiet line in the view "all steps") or `off` (no hook rows; a failed
 * SessionStart/Setup hook stays visible – start problems are never hidden). Kept in the server
 * settings (`settings.hookDisplay`, every window follows `host.state`); set in the settings page
 * (features/preferences), read by the transcript (features/transcript) – both only through this
 * module (features never import each other).
 */
export { HOOK_DISPLAYS };
export type { HookDisplay };
export const DEFAULT_HOOK_DISPLAY: HookDisplay = 'failed';

export function useHookDisplay(hostId: HostId = LOCAL_HOST_ID): HookDisplay {
  return useSettings(hostId).hookDisplay;
}

export function getHookDisplay(hostId: HostId = LOCAL_HOST_ID, store: ClientStore = clientStore): HookDisplay {
  return selectSettings(store.getState(), hostId).hookDisplay;
}

/** `settings.update` (optimistic; an error restores the previous value and rejects). */
export async function setHookDisplay(
  next: HookDisplay,
  hostId: HostId = LOCAL_HOST_ID,
  store: ClientStore = clientStore,
): Promise<void> {
  await updateSettings({ hookDisplay: next }, hostId, store);
}
