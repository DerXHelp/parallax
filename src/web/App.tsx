import { lazy, memo, Suspense } from 'react';
import { Composer } from './features/composer/Composer';
import { DecisionBar } from './features/decisions/DecisionBar';
import { DecisionCard } from './features/decisions/DecisionCard';
import { PlanSidePanel } from './features/decisions/PlanSidePanel';
import { TRANSCRIPT_SLOTS } from './features/transcript/slots';
import { useT } from './i18n';
import { AppShell } from './shell/AppShell';
import { ShellEffects } from './shell/ShellEffects';
import {
  FeatureSlotsProvider,
  type FeatureSlots,
  type ProfilesSettingsSlotProps,
  type SettingsPageSlotProps,
} from './shell/slots';
import { Skeleton } from './ui/skeleton';

/**
 * R4W-19: the settings page (WP-38) and the profile editor (WP-36) open rarely – they are lazy
 * chunks, not part of the start chunk (architecture §2.3j). Nothing else imports the two features
 * (only their dictionaries are in `i18n/index.ts`); `features/preferences/index.ts` has exactly one
 * slot (`SettingsPage`, guarded by App.test.tsx).
 */
const loadProfiles = () => import('./features/profiles');

const LazySettingsPage = lazy(() => {
  // The section "Profiles" is one click away: fetch its chunk along, so it rarely shows a placeholder.
  loadProfiles().catch(() => undefined);
  return import('./features/preferences').then((module) => ({ default: module.SettingsPage }));
});
const LazyProfilesSettings = lazy(() =>
  loadProfiles().then((module) => ({ default: module.ProfilesSettings })),
);

/**
 * Slot `SettingsPage`: no fallback – the page is a modal dialog of a fixed size, it appears whole
 * once its chunk is there (no half-built dialog, no layout jump; the opener keeps the focus until
 * then, so the page still returns it on close).
 */
const SettingsPageSlot = memo(function SettingsPageSlot(props: SettingsPageSlotProps) {
  return (
    <Suspense fallback={null}>
      <LazySettingsPage {...props} />
    </Suspense>
  );
});

/**
 * Placeholder of the section "Profiles" while its chunk loads: the shape of the list and the editor
 * (same grid as `ProfilesSettings`) inside the fixed-size panel of the settings page – nothing
 * around it moves when the real content replaces it.
 */
function ProfilesSettingsLoading() {
  const t = useT();
  return (
    <div
      role="status"
      aria-busy="true"
      data-slot="profiles-settings-loading"
      className="@container grid gap-3"
    >
      <span className="sr-only">{t('common.loading')}</span>
      <Skeleton className="h-3 w-2/3" />
      <div className="grid gap-4 @2xl:grid-cols-[15rem_minmax(0,1fr)]">
        <Skeleton className="h-40" />
        <Skeleton className="h-72" />
      </div>
    </div>
  );
}

/** Slot `ProfilesSettings` (lazy); forwards `onDirtyChange` (R4W-01: the page asks before closing). */
const ProfilesSettingsSlot = memo(function ProfilesSettingsSlot(props: ProfilesSettingsSlotProps) {
  return (
    <Suspense fallback={<ProfilesSettingsLoading />}>
      <LazyProfilesSettings {...props} />
    </Suspense>
  );
});

/**
 * The real feature components in the shell and feature slots (architecture §2.3d, WP-20b):
 * WP-15 `Transcript` (lazy TranscriptView), `Markdown`, `ToolInputPreview`; WP-16 `DecisionBar`
 * (the only operable decision instance), `DecisionCard` (also used by the transcript's plan card),
 * `SidePanel` = the plan panel (the only side panel in Phase 1) and `Composer` (mode/model/context
 * pickers, ADR-042). Phase 2 (WP-40): WP-38 `SettingsPage` (the settings dialog, opened by the
 * request `settings` of `SettingsMenu`) and WP-36 `ProfilesSettings` (profile list + editor in its
 * section "Profiles"), both lazy (R4W-19). The handlers of the shell request channel
 * (`shell/requests.ts`) register themselves where they are mounted (NewSessionDialog,
 * NavigationLayer, SettingsMenu). A module-level constant: a new object per render would re-render
 * every slot.
 */
export const APP_SLOTS: Partial<FeatureSlots> = {
  ...TRANSCRIPT_SLOTS,
  DecisionBar,
  DecisionCard,
  SidePanel: PlanSidePanel,
  Composer,
  SettingsPage: SettingsPageSlot,
  ProfilesSettings: ProfilesSettingsSlot,
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
