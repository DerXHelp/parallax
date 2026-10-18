import {
  BellIcon,
  InfoIcon,
  LayersIcon,
  ServerIcon,
  SlidersHorizontalIcon,
  UsersIcon,
  type LucideIcon,
} from 'lucide-react';
import { useState } from 'react';
import type { HostState } from '@shared/model';
import { useI18n, useT } from '@web/i18n';
import { SETTINGS_SECTIONS, type SettingsSection } from '@web/shell/requests';
import { DEFAULT_FEATURE_SLOTS, useFeatureSlots, type SettingsPageSlotProps } from '@web/shell/slots';
import { useHostState } from '@web/state/hooks';
import { Alert } from '@web/ui/alert';
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@web/ui/dialog';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@web/ui/tabs';
import { AboutSection } from './sections/AboutSection';
import { GeneralSection } from './sections/GeneralSection';
import { NotificationsSection } from './sections/NotificationsSection';
import { ServerSection } from './sections/ServerSection';
import { SessionsSection } from './sections/SessionsSection';
import { useSettingsEditor, type SettingsEditor } from './state/settings-editor';

const SECTION_ICONS: Readonly<Record<SettingsSection, LucideIcon>> = {
  general: SlidersHorizontalIcon,
  notifications: BellIcon,
  sessions: LayersIcon,
  profiles: UsersIcon,
  server: ServerIcon,
  about: InfoIcon,
};

function isSection(value: string): value is SettingsSection {
  return (SETTINGS_SECTIONS as readonly string[]).includes(value);
}

function focusedElement(): HTMLElement | null {
  return document.activeElement instanceof HTMLElement && document.activeElement !== document.body
    ? document.activeElement
    : null;
}

/** Section "Profiles": the profile list and editor of WP-36 (slot `ProfilesSettings`). */
function ProfilesSection() {
  const t = useT();
  const { ProfilesSettings } = useFeatureSlots();
  if (ProfilesSettings === DEFAULT_FEATURE_SLOTS.ProfilesSettings) {
    return <p className="text-muted-foreground text-xs">{t('preferences.profiles.unavailable')}</p>;
  }
  return <ProfilesSettings />;
}

function SectionContent({
  section,
  editor,
  hostState,
}: {
  section: SettingsSection;
  editor: SettingsEditor;
  hostState: HostState | null;
}) {
  switch (section) {
    case 'general':
      return <GeneralSection editor={editor} />;
    case 'notifications':
      return <NotificationsSection editor={editor} hostState={hostState} />;
    case 'sessions':
      return <SessionsSection editor={editor} />;
    case 'profiles':
      return <ProfilesSection />;
    case 'server':
      return <ServerSection editor={editor} hostState={hostState} />;
    case 'about':
      return <AboutSection hostState={hostState} />;
  }
}

/**
 * The settings page (WP-38, slot `SettingsPage`): a large dialog – modal is fine here, nothing
 * waits for the user; sessions keep running, Esc closes – with the sections on the left (vertical
 * tabs, arrow keys) and the chosen one on the right, starting at the requested section. Every
 * change is saved at once (`settings.update` with the whole top-level field, rollback + hint on
 * failure – state/settings-editor.ts).
 */
export function SettingsPage({ section, onClose }: SettingsPageSlotProps) {
  const { t, tError } = useI18n();
  const [current, setCurrent] = useState<SettingsSection>(section ?? 'general');
  const editor = useSettingsEditor();
  const hostState = useHostState();
  // Radix gives the focus back only to a DialogTrigger; the page is opened by a request (menu,
  // `/settings` …), so it returns the focus to where it was when the page opened.
  const [returnFocus] = useState(focusedElement);
  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
    >
      <DialogContent
        data-slot="settings-page"
        className="flex h-[min(85vh,42rem)] flex-col gap-0 overflow-hidden p-0 sm:max-w-3xl"
        onCloseAutoFocus={(event) => {
          if (!returnFocus?.isConnected) return;
          event.preventDefault();
          returnFocus.focus();
        }}
      >
        <DialogHeader className="border-b px-5 py-3.5">
          <DialogTitle className="text-base">{t('preferences.title')}</DialogTitle>
          <DialogDescription>{t('preferences.description')}</DialogDescription>
        </DialogHeader>
        {editor.error === null ? null : (
          <div className="border-b px-5 py-2.5">
            <Alert tone="error" title={t('settings.saveFailed')}>
              {tError(editor.error)}
            </Alert>
          </div>
        )}
        <Tabs
          orientation="vertical"
          value={current}
          onValueChange={(value) => {
            if (isSection(value)) setCurrent(value);
          }}
          className="flex min-h-0 flex-1 flex-row gap-0"
        >
          <TabsList
            aria-label={t('preferences.sections.label')}
            className="bg-muted/30 h-auto w-48 shrink-0 flex-col items-stretch justify-start gap-0.5 overflow-y-auto border-r border-b-0 p-2"
          >
            {SETTINGS_SECTIONS.map((value) => {
              const Icon = SECTION_ICONS[value];
              return (
                <TabsTrigger
                  key={value}
                  value={value}
                  data-section={value}
                  className="hover:bg-accent/60 data-[state=active]:bg-accent data-[state=active]:text-accent-foreground mb-0 h-7 justify-start gap-2 rounded-md border-b-0 px-2 font-normal data-[state=active]:font-medium"
                >
                  <Icon aria-hidden />
                  {t(`preferences.sections.${value}`)}
                </TabsTrigger>
              );
            })}
          </TabsList>
          {SETTINGS_SECTIONS.map((value) => (
            <TabsContent key={value} value={value} className="min-h-0 overflow-y-auto px-6 py-5">
              <h3 className="mb-4 text-sm font-semibold">{t(`preferences.sections.${value}`)}</h3>
              <SectionContent section={value} editor={editor} hostState={hostState} />
            </TabsContent>
          ))}
        </Tabs>
      </DialogContent>
    </Dialog>
  );
}
