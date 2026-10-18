import { Composer } from './features/composer/Composer';
import { DecisionBar } from './features/decisions/DecisionBar';
import { DecisionCard } from './features/decisions/DecisionCard';
import { PlanSidePanel } from './features/decisions/PlanSidePanel';
import { PREFERENCES_SLOTS } from './features/preferences';
import { ProfilesSettings } from './features/profiles';
import { TRANSCRIPT_SLOTS } from './features/transcript/slots';
import { AppShell } from './shell/AppShell';
import { ShellEffects } from './shell/ShellEffects';
import { FeatureSlotsProvider, type FeatureSlots } from './shell/slots';

/**
 * The real feature components in the shell and feature slots (architecture §2.3d, WP-20b):
 * WP-15 `Transcript` (lazy TranscriptView), `Markdown`, `ToolInputPreview`; WP-16 `DecisionBar`
 * (the only operable decision instance), `DecisionCard` (also used by the transcript's plan card),
 * `SidePanel` = the plan panel (the only side panel in Phase 1) and `Composer` (mode/model/context
 * pickers, ADR-042). Phase 2 (WP-40): WP-38 `SettingsPage` (the settings dialog, opened by the
 * request `settings` of `SettingsMenu`) and WP-36 `ProfilesSettings` (profile list + editor in its
 * section "Profiles"). The handlers of the shell request channel (`shell/requests.ts`) register
 * themselves where they are mounted (NewSessionDialog, NavigationLayer, SettingsMenu). A
 * module-level constant: a new object per render would re-render every slot.
 */
export const APP_SLOTS: Partial<FeatureSlots> = {
  ...TRANSCRIPT_SLOTS,
  ...PREFERENCES_SLOTS,
  DecisionBar,
  DecisionCard,
  SidePanel: PlanSidePanel,
  Composer,
  ProfilesSettings,
};

/**
 * Root component; the connection (auth bootstrap, WebSocket of the local host), presence and
 * notification delivery are started before the first render (main.tsx → bootApp).
 */
export function App() {
  return (
    <FeatureSlotsProvider slots={APP_SLOTS}>
      <ShellEffects />
      <AppShell />
    </FeatureSlotsProvider>
  );
}
