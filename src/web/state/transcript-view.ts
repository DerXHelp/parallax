import { useSyncExternalStore } from 'react';
import { STORAGE_KEYS, readStorage, writeStorage } from '@web/lib/storage';

/**
 * Transcript view (WP-63 §1.5): `compact` (default – work steps between two visible entries form
 * one group line, pictures as a gallery) or `all` (every step as its own line, the former view).
 * Set in the settings page (features/preferences), read by the transcript (features/transcript) –
 * both only through this module (features never import each other).
 * Kept in localStorage `parallax.transcript.view` (shared by every window of this browser profile,
 * other windows follow through the `storage` event): the server settings have no field for it –
 * a contract change that WP-63 did not get (requested in its report).
 */
export const TRANSCRIPT_VIEWS = ['compact', 'all'] as const;
export type TranscriptViewMode = (typeof TRANSCRIPT_VIEWS)[number];
export const DEFAULT_TRANSCRIPT_VIEW: TranscriptViewMode = 'compact';

function parse(value: string | null): TranscriptViewMode {
  return value === 'all' ? 'all' : DEFAULT_TRANSCRIPT_VIEW;
}

let mode: TranscriptViewMode = parse(readStorage('local', STORAGE_KEYS.transcriptView));
const listeners = new Set<() => void>();

function emit(): void {
  for (const listener of [...listeners]) listener();
}

function onStorage(event: StorageEvent): void {
  if (event.key !== STORAGE_KEYS.transcriptView) return;
  const next = parse(event.newValue);
  if (next === mode) return;
  mode = next;
  emit();
}

function subscribe(listener: () => void): () => void {
  if (listeners.size === 0 && typeof window !== 'undefined') window.addEventListener('storage', onStorage);
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
    if (listeners.size === 0 && typeof window !== 'undefined') {
      window.removeEventListener('storage', onStorage);
    }
  };
}

export function getTranscriptView(): TranscriptViewMode {
  return mode;
}

export function setTranscriptView(next: TranscriptViewMode): void {
  writeStorage('local', STORAGE_KEYS.transcriptView, next === DEFAULT_TRANSCRIPT_VIEW ? null : next);
  if (next === mode) return;
  mode = next;
  emit();
}

export function useTranscriptView(): TranscriptViewMode {
  return useSyncExternalStore(subscribe, getTranscriptView, getTranscriptView);
}

/** Tests: back to the default (the stored choice is removed). */
export function resetTranscriptView(): void {
  writeStorage('local', STORAGE_KEYS.transcriptView, null);
  mode = DEFAULT_TRANSCRIPT_VIEW;
  emit();
}
