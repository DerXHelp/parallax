import {
  BellIcon,
  InfoIcon,
  LayersIcon,
  ServerIcon,
  SlidersHorizontalIcon,
  UsersIcon,
  type LucideIcon,
} from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import type { HostState } from '@shared/model';
import { useI18n, useT } from '@web/i18n';
import { cn } from '@web/lib/cn';
import { SETTINGS_SECTIONS, useShellRequestHandler, type SettingsSection } from '@web/shell/requests';
import { DEFAULT_FEATURE_SLOTS, useFeatureSlots, type SettingsPageSlotProps } from '@web/shell/slots';
import { useHostState } from '@web/state/hooks';
import { Alert } from '@web/ui/alert';
import { Button } from '@web/ui/button';
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
function ProfilesSection({ onDirtyChange }: { onDirtyChange: (dirty: boolean) => void }) {
  const t = useT();
  const { ProfilesSettings } = useFeatureSlots();
  if (ProfilesSettings === DEFAULT_FEATURE_SLOTS.ProfilesSettings) {
    return <p className="text-muted-foreground text-xs">{t('preferences.profiles.unavailable')}</p>;
  }
  return <ProfilesSettings onDirtyChange={onDirtyChange} />;
}

function SectionContent({
  section,
  editor,
  hostState,
  onProfilesDirtyChange,
}: {
  section: SettingsSection;
  editor: SettingsEditor;
  hostState: HostState | null;
  onProfilesDirtyChange: (dirty: boolean) => void;
}) {
  switch (section) {
    case 'general':
      return <GeneralSection editor={editor} />;
    case 'notifications':
      return <NotificationsSection editor={editor} hostState={hostState} />;
    case 'sessions':
      return <SessionsSection editor={editor} />;
    case 'profiles':
      return <ProfilesSection onDirtyChange={onProfilesDirtyChange} />;
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
 *
 * Unsaved profile drafts (R4W-01): the section "Profiles" stays mounted once opened (hidden while
 * another section shows), so a draft survives switching sections; closing (Esc, X, click outside)
 * while the profile editor reports unsaved changes asks inline first; a `settings` request while
 * the page is open only switches the section – the page is never mounted anew.
 */
export function SettingsPage({ section, onClose }: SettingsPageSlotProps) {
  const { t, tError } = useI18n();
  const [current, setCurrent] = useState<SettingsSection>(section ?? 'general');
  // The profile editor is mounted on its first visit and then kept (forceMount + hidden).
  const [profilesKept, setProfilesKept] = useState(current === 'profiles');
  const [profilesDirty, setProfilesDirty] = useState(false);
  const [confirmClose, setConfirmClose] = useState(false);
  const [refocus, setRefocus] = useState(0);
  const askedFrom = useRef<HTMLElement | null>(null);
  const contentRef = useRef<HTMLDivElement>(null);
  const profilesPanelRef = useRef<HTMLDivElement>(null);
  const editor = useSettingsEditor();
  const hostState = useHostState();
  // Radix gives the focus back only to a DialogTrigger; the page is opened by a request (menu,
  // `/settings` …), so it returns the focus to where it was when the page opened.
  const [returnFocus] = useState(focusedElement);

  const showSection = (next: SettingsSection) => {
    setCurrent(next);
    if (next === 'profiles') setProfilesKept(true);
  };

  // A changed `section` from the host (a request while open) switches the section, no remount.
  const [requested, setRequested] = useState(section);
  if (section !== requested) {
    setRequested(section);
    if (section !== null) showSection(section);
  }
  // While open, the page takes `settings` requests itself (the newest handler wins): it shows the
  // requested section – also the same one again – and keeps everything else.
  useShellRequestHandler('settings', (request) => {
    if (request.section !== undefined) showSection(request.section);
    return true;
  });

  const requestClose = () => {
    if (!profilesDirty) {
      onClose();
      return;
    }
    askedFrom.current = focusedElement();
    setConfirmClose(true);
  };

  /** "Keep editing": back to the profile editor – to the field the user left, else its tab. */
  const keepEditing = () => {
    setConfirmClose(false);
    showSection('profiles');
    setRefocus((value) => value + 1);
  };

  useEffect(() => {
    if (refocus === 0) return;
    const target = askedFrom.current;
    askedFrom.current = null;
    if (target?.isConnected === true && profilesPanelRef.current?.contains(target) === true) {
      target.focus();
      return;
    }
    contentRef.current?.querySelector<HTMLElement>('[role="tab"][data-section="profiles"]')?.focus();
  }, [refocus]);

  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open) requestClose();
      }}
    >
      <DialogContent
        ref={contentRef}
        data-slot="settings-page"
        className="flex h-[min(85vh,42rem)] flex-col gap-0 overflow-hidden p-0 sm:max-w-3xl"
        onEscapeKeyDown={(event) => {
          // Esc while asking = "Keep editing" (the question goes away, the page stays).
          if (!confirmClose) return;
          event.preventDefault();
          keepEditing();
        }}
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
        {confirmClose ? (
          <div className="border-b px-5 py-2.5">
            <Alert
              tone="warning"
              data-slot="settings-close-confirm"
              title={t('preferences.closeConfirm.title')}
              actions={
                <>
                  <Button
                    size="sm"
                    variant="outline"
                    data-action="settings-keep-editing"
                    // R4W-24: the harmless choice takes the focus (a repeated Enter discards nothing).
                    autoFocus
                    onClick={keepEditing}
                  >
                    {t('preferences.closeConfirm.keep')}
                  </Button>
                  <Button size="sm" variant="ghost" data-action="settings-discard-close" onClick={onClose}>
                    {t('preferences.closeConfirm.discard')}
                  </Button>
                </>
              }
            >
              {t('preferences.closeConfirm.description')}
            </Alert>
          </div>
        ) : null}
        {editor.error === null ? null : (
          <div className="border-b px-5 py-2.5">
            <Alert
              tone="error"
              title={t('settings.saveFailed')}
              actions={
                <Button size="sm" variant="outline" data-action="settings-error-dismiss" onClick={editor.dismissError}>
                  {t('preferences.dismissError')}
                </Button>
              }
            >
              {tError(editor.error)}
            </Alert>
          </div>
        )}
        <Tabs
          orientation="vertical"
          value={current}
          onValueChange={(value) => {
            if (isSection(value)) showSection(value);
          }}
          className="flex min-h-0 flex-1 flex-row gap-0"
        >
          <TabsList
            aria-label={t('preferences.sections.label')}
            className="bg-muted/30 h-auto w-48 shrink-0 flex-col items-stretch justify-start gap-0.5 overflow-y-auto border-r border-b-0 p-2"
          >
            {SETTINGS_SECTIONS.map((value) => {
              const Icon = SECTION_ICONS[value];
              const unsaved = value === 'profiles' && profilesDirty;
              return (
                <TabsTrigger
                  key={value}
                  value={value}
                  data-section={value}
                  data-unsaved={unsaved ? 'true' : undefined}
                  className="hover:bg-accent/60 data-[state=active]:bg-accent data-[state=active]:text-accent-foreground mb-0 h-7 justify-start gap-2 rounded-md border-b-0 px-2 font-normal data-[state=active]:font-medium"
                >
                  <Icon aria-hidden />
                  {t(`preferences.sections.${value}`)}
                  {unsaved ? (
                    <>
                      <span aria-hidden className="bg-warning ml-auto size-1.5 shrink-0 rounded-full" />
                      <span className="sr-only">{t('preferences.sections.unsaved')}</span>
                    </>
                  ) : null}
                </TabsTrigger>
              );
            })}
          </TabsList>
          {SETTINGS_SECTIONS.map((value) => {
            const kept = value === 'profiles' && profilesKept;
            return (
              <TabsContent
                key={value}
                value={value}
                ref={value === 'profiles' ? profilesPanelRef : undefined}
                {...(kept ? { forceMount: true, hidden: current !== value } : {})}
                // The sticky action bar of the profile editor ends at the panel's bottom edge (V3-06).
                className={cn('min-h-0 overflow-y-auto px-6 pt-5', value === 'profiles' ? 'pb-0' : 'pb-5')}
              >
                <h3 className="mb-4 text-sm font-semibold">{t(`preferences.sections.${value}`)}</h3>
                <SectionContent
                  section={value}
                  editor={editor}
                  hostState={hostState}
                  onProfilesDirtyChange={setProfilesDirty}
                />
              </TabsContent>
            );
          })}
        </Tabs>
      </DialogContent>
    </Dialog>
  );
}
