import { lazy, memo, Suspense, type ComponentType } from 'react';
import { Composer } from './features/composer/Composer';
import { DecisionBar } from './features/decisions/DecisionBar';
import { DecisionCard } from './features/decisions/DecisionCard';
import { PlanSidePanel } from './features/decisions/PlanSidePanel';
import { FILES_SLOTS } from './features/files';
import { TASKS_SLOTS } from './features/tasks';
import { Markdown } from './features/transcript/markdown/Markdown';
import { ToolInputPreviewSlot, TranscriptSlot } from './features/transcript/slots';
import { useT } from './i18n';
import { AppShell } from './shell/AppShell';
import { ShellEffects } from './shell/ShellEffects';
import { withSlotBoundary } from './shell/SlotBoundary';
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
 * A lazy slot inside the error boundary of WP-58 (`shell/SlotBoundary.tsx`, WP-50 §8): a chunk that
 * cannot be loaded or a render error shows the card "This area could not be loaded" in place of the
 * slot – the rest of the app stays usable. The boundary sits OUTSIDE the slot's own `Suspense`
 * (every lazy slot below brings its Suspense), so it also catches the failed dynamic import.
 * `resetKeyOf`: a new value (another session, file, text) gives a render error a fresh try.
 */
function bounded<P extends object>(
  Slot: ComponentType<P>,
  resetKeyOf?: (props: P) => unknown,
): ComponentType<P> {
  return memo(withSlotBoundary(Slot, resetKeyOf));
}

const bySessionKey = (props: { sessionKey: string }): string => props.sessionKey;

/**
 * The real feature components in the shell and feature slots (architecture §2.3d, WP-20b):
 * WP-15 `Transcript` (lazy TranscriptView), `Markdown`, `ToolInputPreview`; WP-16 `DecisionBar`
 * (the only operable decision instance), `DecisionCard` (also used by the transcript's plan card),
 * `PlanPanel` = the plan tab of the side panel host (Phase 3, ADR-150; WP-56: versions, diff, live
 * plan file) and `Composer` (mode/model/context pickers, ADR-042; Phase 3 attachments, paste chips,
 * @-picker). Phase 2 (WP-40): WP-38 `SettingsPage` (the settings dialog, opened by the request
 * `settings` of `SettingsMenu`) and WP-36 `ProfilesSettings` (profile list + editor in its section
 * "Profiles"), both lazy (R4W-19). Phase 3 (WP-60): WP-54 `FileLink`, `FilePanel` (viewer),
 * `FilesPanel` ("Files of this session") and WP-55 `TasksPanel`, `TaskStrip` – all lazy chunks.
 * Every lazy slot is wrapped in a `SlotBoundary` (WP-58); the eager ones (DecisionBar,
 * DecisionCard, Composer) are not lazy and need none.
 *
 * The handlers of the shell request channel (`shell/requests.ts`) register themselves where they
 * are mounted (NewSessionDialog, NavigationLayer, SettingsMenu, the side panel host for `openFile`
 * and `sidePanel`, the composer for `attachFiles`). A module-level constant: a new object per render
 * would re-render every slot.
 */
export const APP_SLOTS: Partial<FeatureSlots> = {
  Transcript: bounded(TranscriptSlot, bySessionKey),
  Markdown: bounded(Markdown, (props) => props.text),
  ToolInputPreview: bounded(ToolInputPreviewSlot, (props) => props.sessionKey),
  DecisionBar,
  DecisionCard,
  PlanPanel: bounded(PlanSidePanel, bySessionKey),
  Composer,
  SettingsPage: bounded(SettingsPageSlot, (props) => props.section),
  ProfilesSettings: bounded(ProfilesSettingsSlot),
  FileLink: bounded(FILES_SLOTS.FileLink, (props) => props.path),
  FilePanel: bounded(FILES_SLOTS.FilePanel, (props) => `${props.sessionKey}|${props.path}`),
  FilesPanel: bounded(FILES_SLOTS.FilesPanel, bySessionKey),
  TasksPanel: bounded(TASKS_SLOTS.TasksPanel, bySessionKey),
  TaskStrip: bounded(TASKS_SLOTS.TaskStrip, bySessionKey),
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
