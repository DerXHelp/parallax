import { LOCAL_HOST_ID, type HostId } from '@shared/common';
import { TRANSCRIPT_VIEWS, type TranscriptView } from '@shared/model';
import { STORAGE_KEYS, readStorage, writeStorage } from '@web/lib/storage';
import { selectSettings, updateSettings, useSettings } from './settings';
import { clientStore, type ClientStore } from './store';

/**
 * Transcript view (WP-63 §1.5): `compact` (default – work steps between two visible entries form
 * one group line, pictures as a gallery) or `all` (every step as its own line, the former view).
 * Set in the settings page (features/preferences), read by the transcript (features/transcript) –
 * both only through this module (features never import each other).
 * WP-65 §1.6: kept in the server settings (`settings.transcriptView`, every window and browser
 * follows `host.state`); WP-63's localStorage value `parallax.transcript.view` is taken over once
 * (`migrateLegacyTranscriptView`, ShellEffects) and then removed.
 */
export { TRANSCRIPT_VIEWS };
export type TranscriptViewMode = TranscriptView;
export const DEFAULT_TRANSCRIPT_VIEW: TranscriptViewMode = 'compact';

export function useTranscriptView(hostId: HostId = LOCAL_HOST_ID): TranscriptViewMode {
  return useSettings(hostId).transcriptView;
}

export function getTranscriptView(hostId: HostId = LOCAL_HOST_ID, store: ClientStore = clientStore): TranscriptViewMode {
  return selectSettings(store.getState(), hostId).transcriptView;
}

/** `settings.update` (optimistic; an error restores the previous value and rejects). */
export async function setTranscriptView(
  next: TranscriptViewMode,
  hostId: HostId = LOCAL_HOST_ID,
  store: ClientStore = clientStore,
): Promise<void> {
  await updateSettings({ transcriptView: next }, hostId, store);
}

let migrating = false;

/**
 * Once per browser profile, after `host.state` arrived: a stored `all` of WP-63 becomes the setting
 * (unless the setting already says `all`), then the key is removed – any other value is just
 * removed. A failed update keeps the key for the next start. True when the setting was changed.
 */
export async function migrateLegacyTranscriptView(
  hostId: HostId = LOCAL_HOST_ID,
  store: ClientStore = clientStore,
): Promise<boolean> {
  if (migrating || (store.getState().hosts[hostId]?.hostState ?? null) === null) return false;
  const legacy = readStorage('local', STORAGE_KEYS.transcriptView);
  if (legacy === null) return false;
  migrating = true;
  try {
    const change = legacy === 'all' && getTranscriptView(hostId, store) !== 'all';
    if (change) await updateSettings({ transcriptView: 'all' }, hostId, store);
    writeStorage('local', STORAGE_KEYS.transcriptView, null);
    return change;
  } finally {
    migrating = false;
  }
}
