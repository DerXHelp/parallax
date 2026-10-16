import { createContext, useContext, useMemo, type ComponentType, type ReactNode } from 'react';
import type { DecisionId, JsonValue } from '@shared/common';
import {
  ComposerPlaceholder,
  DecisionBarPlaceholder,
  DecisionCardPlaceholder,
  MarkdownPlaceholder,
  ProfilesSettingsPlaceholder,
  SettingsPagePlaceholder,
  SidePanelPlaceholder,
  ToolInputPreviewPlaceholder,
  TranscriptPlaceholder,
} from './placeholders';
import type { SettingsSection } from './requests';

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
  /**
   * WP-16 → WP-15 (plan card via tool_call.decision). Rule (architecture §2.3e, ADR-031):
   * renders open and expired decisions (`useDecision ≠ null`) and returns `null` once resolved.
   * `placement: 'bar'` is the ONLY operable instance; `placement: 'transcript'` is read-only (plan
   * text, status, button "Go to decision" → `focusDecision`, decision-focus.ts). After the
   * resolution WP-15 draws the final state itself from `tool_call.decision.outcome` + `input`.
   */
  DecisionCard: ComponentType<DecisionCardSlotProps>;
  /** WP-15 → WP-16 (plan text, option previews). `sessionKey`: host of blob links (R1W-20). */
  Markdown: ComponentType<{ text: string; sessionKey?: string }>;
  /** WP-15 → WP-16 (diff preview in permission cards). `sessionKey`: host of capped inputs (blobs). */
  ToolInputPreview: ComponentType<{ toolName: string; input: JsonValue; sessionKey?: string }>;
  // Phase 2 (WP-30 §4.14 C)
  /**
   * WP-38 (features/preferences): the settings page as a large dialog; the shell opens it on the
   * request `{kind: 'settings'}` (shell/requests.ts). `section` null = the first section.
   */
  SettingsPage: ComponentType<SettingsPageSlotProps>;
  /** WP-36 (features/profiles): profile list + editor, rendered by the settings page (section `profiles`). */
  ProfilesSettings: ComponentType<Record<string, never>>;
}

export interface SettingsPageSlotProps {
  section: SettingsSection | null;
  onClose: () => void;
}

export type DecisionCardPlacement = 'transcript' | 'bar';

export interface DecisionCardSlotProps {
  sessionKey: string;
  decisionId: DecisionId;
  placement: DecisionCardPlacement;
}

export const DEFAULT_FEATURE_SLOTS: FeatureSlots = {
  Transcript: TranscriptPlaceholder,
  DecisionBar: DecisionBarPlaceholder,
  Composer: ComposerPlaceholder,
  SidePanel: SidePanelPlaceholder,
  DecisionCard: DecisionCardPlaceholder,
  Markdown: MarkdownPlaceholder,
  ToolInputPreview: ToolInputPreviewPlaceholder,
  SettingsPage: SettingsPagePlaceholder,
  ProfilesSettings: ProfilesSettingsPlaceholder,
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
      SettingsPage: slots.SettingsPage ?? parent.SettingsPage,
      ProfilesSettings: slots.ProfilesSettings ?? parent.ProfilesSettings,
    }),
    [parent, slots],
  );
  return <FeatureSlotsContext value={value}>{children}</FeatureSlotsContext>;
}

/** The current slots (never undefined: placeholders where nothing is set). */
export function useFeatureSlots(): FeatureSlots {
  return useContext(FeatureSlotsContext);
}
