import { createContext, useContext, useMemo, type ComponentType, type ReactNode } from 'react';
import type { DecisionId, JsonValue } from '@shared/common';
import {
  ComposerPlaceholder,
  DecisionBarPlaceholder,
  DecisionCardPlaceholder,
  FileLinkPlaceholder,
  FilePanelPlaceholder,
  FilesPanelPlaceholder,
  MarkdownPlaceholder,
  PlanPanelPlaceholder,
  ProfilesSettingsPlaceholder,
  SettingsPagePlaceholder,
  TaskStripPlaceholder,
  TasksPanelPlaceholder,
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
  /**
   * Tab "Plan" of the side panel (shell/side-panel/SidePanelHost renders the frame, Phase 3
   * ADR-150; until Phase 3 the slot `SidePanel`): the content only – header row, plan text.
   */
  PlanPanel: ComponentType<{ sessionKey: string }>;
  // Phase 3 (WP-50 §4.14 C, ADR-150): further side panel tabs and the task strip
  /** WP-54: tab "Datei" – the viewer of one file. */
  FilePanel: ComponentType<FilePanelSlotProps>;
  /** WP-54: tab "Dateien" – "Dateien dieser Session" (ADR-145). */
  FilesPanel: ComponentType<{ sessionKey: string }>;
  /** WP-55: tab "Aufgaben" – background tasks (ADR-149). */
  TasksPanel: ComponentType<{ sessionKey: string }>;
  /** WP-55: the pinned task list directly above the composer (SessionPane). */
  TaskStrip: ComponentType<{ sessionKey: string }>;
  // Feature slots
  /**
   * WP-16 → WP-15 (plan card via tool_call.decision). Rule (architecture §2.3e, ADR-031):
   * renders open and expired decisions (`useDecision ≠ null`) and returns `null` once resolved.
   * `placement: 'bar'` is the ONLY operable instance; `placement: 'transcript'` is read-only (plan
   * text, status, button "Go to decision" → `focusDecision`, decision-focus.ts). After the
   * resolution WP-15 draws the final state itself from `tool_call.decision.outcome` + `input`.
   */
  DecisionCard: ComponentType<DecisionCardSlotProps>;
  /**
   * WP-15 → WP-16 (plan text, option previews). `sessionKey`: host of blob links (R1W-20).
   * Phase 3: `baseDir` resolves relative file references (viewer of a Markdown file, WP-54).
   */
  Markdown: ComponentType<{ text: string; sessionKey?: string; baseDir?: string }>;
  /** WP-15 → WP-16 (diff preview in permission cards). `sessionKey`: host of capped inputs (blobs). */
  ToolInputPreview: ComponentType<{ toolName: string; input: JsonValue; sessionKey?: string }>;
  // Phase 2 (WP-30 §4.14 C)
  /**
   * WP-38 (features/preferences): the settings page as a large dialog; the shell opens it on the
   * request `{kind: 'settings'}` (shell/requests.ts). `section` null = the first section.
   */
  SettingsPage: ComponentType<SettingsPageSlotProps>;
  /** WP-36 (features/profiles): profile list + editor, rendered by the settings page (section `profiles`). */
  ProfilesSettings: ComponentType<ProfilesSettingsSlotProps>;
  /**
   * Phase 3, WP-54 (features/files) → transcript, decisions, panels: a clickable file reference
   * with its actions (viewer, editor, Explorer – ADR-144). The placeholder renders the text only.
   */
  FileLink: ComponentType<FileLinkSlotProps>;
}

export interface FilePanelSlotProps {
  sessionKey: string;
  /** Absolute Windows path. */
  path: string;
  line: number | null;
  col: number | null;
}

/** inline = text link, chip = file chip, menu = actions button only. */
export type FileLinkVariant = 'inline' | 'chip' | 'menu';

export interface FileLinkSlotProps {
  sessionKey: string;
  /** Absolute Windows path (callers resolve relative paths with resolveWindowsPath against the cwd). */
  path: string;
  line?: number | null;
  col?: number | null;
  /** true: link only after a successful file.statMany (text references); false: always (tool inputs). */
  verify?: boolean;
  /** inline = text link, chip = file chip, menu = actions button only. */
  variant?: FileLinkVariant;
  /** Visible text; default: path tail. */
  children?: ReactNode;
}

export interface ProfilesSettingsSlotProps {
  /**
   * R4W-01: reports whether the editor holds unsaved changes, so the settings page can ask before
   * it closes (Esc, X, outside click, a new `settings` request). Optional: without it nothing asks.
   */
  onDirtyChange?: (dirty: boolean) => void;
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
  PlanPanel: PlanPanelPlaceholder,
  FilePanel: FilePanelPlaceholder,
  FilesPanel: FilesPanelPlaceholder,
  TasksPanel: TasksPanelPlaceholder,
  TaskStrip: TaskStripPlaceholder,
  DecisionCard: DecisionCardPlaceholder,
  Markdown: MarkdownPlaceholder,
  ToolInputPreview: ToolInputPreviewPlaceholder,
  SettingsPage: SettingsPagePlaceholder,
  ProfilesSettings: ProfilesSettingsPlaceholder,
  FileLink: FileLinkPlaceholder,
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
      PlanPanel: slots.PlanPanel ?? parent.PlanPanel,
      FilePanel: slots.FilePanel ?? parent.FilePanel,
      FilesPanel: slots.FilesPanel ?? parent.FilesPanel,
      TasksPanel: slots.TasksPanel ?? parent.TasksPanel,
      TaskStrip: slots.TaskStrip ?? parent.TaskStrip,
      DecisionCard: slots.DecisionCard ?? parent.DecisionCard,
      Markdown: slots.Markdown ?? parent.Markdown,
      ToolInputPreview: slots.ToolInputPreview ?? parent.ToolInputPreview,
      SettingsPage: slots.SettingsPage ?? parent.SettingsPage,
      ProfilesSettings: slots.ProfilesSettings ?? parent.ProfilesSettings,
      FileLink: slots.FileLink ?? parent.FileLink,
    }),
    [parent, slots],
  );
  return <FeatureSlotsContext value={value}>{children}</FeatureSlotsContext>;
}

/** The current slots (never undefined: placeholders where nothing is set). */
export function useFeatureSlots(): FeatureSlots {
  return useContext(FeatureSlotsContext);
}
