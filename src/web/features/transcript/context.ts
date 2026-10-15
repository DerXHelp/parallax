import { createContext, useContext, type ComponentType } from 'react';

/**
 * Values the TranscriptView computes once and every row may need. They change rarely (model
 * switch, profile), so a change re-rendering the rows is fine; per-item data always comes from
 * `useItem` (architecture §2.3g).
 */
export interface TranscriptSettings {
  /**
   * Model of the session (`init.model`, else the summary's model). Assistant messages from another
   * model show a badge (F.6: plan mode with Haiku plans on Sonnet).
   */
  sessionModel: string | null;
  /** Costs only for API-key profiles (B "Kosten nur bei API-Key-Profilen"): `apiKeySource ≠ 'none'`. */
  showCost: boolean;
  /** Row component for nested items (Agent card children) – avoids an import cycle. */
  Row: ComponentType<{ sessionKey: string; itemId: string; nested?: boolean }>;
}

export const TranscriptSettingsContext = createContext<TranscriptSettings | null>(null);

export function useTranscriptSettings(): TranscriptSettings | null {
  return useContext(TranscriptSettingsContext);
}

/** Message UUIDs still in `detail.queue` (B "Gequeuete Nachrichten" – shown grey until taken over). */
export const QueuedIdsContext = createContext<ReadonlySet<string>>(new Set());
