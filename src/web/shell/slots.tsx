import { createContext, useContext, useMemo, type ComponentType, type ReactNode } from 'react';
import type { DecisionId, JsonValue } from '@shared/common';
import {
  ComposerPlaceholder,
  DecisionBarPlaceholder,
  DecisionCardPlaceholder,
  MarkdownPlaceholder,
  SidePanelPlaceholder,
  ToolInputPreviewPlaceholder,
  TranscriptPlaceholder,
} from './placeholders';

/**
 * Feature slots instead of cross imports (architecture §2.3 d/e, ADR-017): the shell renders the
 * shell slots for the selected session; features use each other's components only through the
 * feature slots. WP-20 fills them in App.tsx; playgrounds set their own. Unset slots render the
 * neutral placeholders of WP-14.
 */
export interface FeatureSlots {
  // Shell slots (AppShell renders them for the selected session)
  /** WP-15 TranscriptView. */
  Transcript: ComponentType<{ sessionKey: string }>;
  /** WP-16 DecisionBar (docked above the composer). */
  DecisionBar: ComponentType<{ sessionKey: string }>;
  /** WP-16 Composer. */
  Composer: ComponentType<{ sessionKey: string }>;
  /** Later (Phase 2): right side panel of a session pane. */
  SidePanel: ComponentType<{ sessionKey: string }>;
  // Feature slots
  /** WP-16 → WP-15 (plan card via tool_call.decision). */
  DecisionCard: ComponentType<{
    sessionKey: string;
    decisionId: DecisionId;
    placement: 'transcript' | 'bar';
  }>;
  /** WP-15 → WP-16 (plan text, option previews). */
  Markdown: ComponentType<{ text: string }>;
  /** WP-15 → WP-16 (diff preview in permission cards). */
  ToolInputPreview: ComponentType<{ toolName: string; input: JsonValue }>;
}

export const DEFAULT_FEATURE_SLOTS: FeatureSlots = {
  Transcript: TranscriptPlaceholder,
  DecisionBar: DecisionBarPlaceholder,
  Composer: ComposerPlaceholder,
  SidePanel: SidePanelPlaceholder,
  DecisionCard: DecisionCardPlaceholder,
  Markdown: MarkdownPlaceholder,
  ToolInputPreview: ToolInputPreviewPlaceholder,
};

const FeatureSlotsContext = createContext<FeatureSlots>(DEFAULT_FEATURE_SLOTS);

/**
 * Sets slots for the subtree; unset (or `undefined`) slots keep the parent's value. Pass a
 * module-level constant (a new object on every render re-renders all consumers).
 */
export function FeatureSlotsProvider({
  slots,
  children,
}: {
  slots: Partial<FeatureSlots>;
  children: ReactNode;
}) {
  const parent = useContext(FeatureSlotsContext);
  const value = useMemo<FeatureSlots>(
    () => ({
      Transcript: slots.Transcript ?? parent.Transcript,
      DecisionBar: slots.DecisionBar ?? parent.DecisionBar,
      Composer: slots.Composer ?? parent.Composer,
      SidePanel: slots.SidePanel ?? parent.SidePanel,
      DecisionCard: slots.DecisionCard ?? parent.DecisionCard,
      Markdown: slots.Markdown ?? parent.Markdown,
      ToolInputPreview: slots.ToolInputPreview ?? parent.ToolInputPreview,
    }),
    [parent, slots],
  );
  return <FeatureSlotsContext value={value}>{children}</FeatureSlotsContext>;
}

/** The current slots (never undefined: placeholders where nothing is set). */
export function useFeatureSlots(): FeatureSlots {
  return useContext(FeatureSlotsContext);
}
