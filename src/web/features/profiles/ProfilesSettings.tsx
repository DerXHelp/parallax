import { useEffect, useState } from 'react';
import type { ProfileId } from '@shared/common';
import { useI18n, type TranslationKey, type TranslationParams } from '@web/i18n';
import type { ProfilesSettingsSlotProps } from '@web/shell/slots';
import { useHostState } from '@web/state/hooks';
import { Alert } from '@web/ui/alert';
import { Button } from '@web/ui/button';
import { NewProfileEditor, SavedProfileEditor, type ProfileEditorEvents } from './components/ProfileEditor';
import { ProfileList, type ProfileSelection } from './components/ProfileList';

interface Notice {
  key: TranslationKey;
  params: TranslationParams;
}

/**
 * Settings section "Profiles" (slot `ProfilesSettings`, WP-36 requirement 3; ADR-102): the
 * profiles of the local host on the left, the editor of the chosen one on the right (stacked when
 * narrow). Switching away from unsaved changes asks first. Everything is decided by the server
 * (`profile.*`); the list follows `HostState.profiles`.
 */
export function ProfilesSettings({
  initialSelection,
  onDirtyChange,
}: ProfilesSettingsSlotProps & {
  /** Start with this profile (playground, tests); default: the default profile. */
  initialSelection?: ProfileSelection;
}) {
  const { t } = useI18n();
  const hostState = useHostState();
  const profiles = hostState?.profiles ?? [];
  const defaultId = hostState?.defaultProfileId ?? null;
  const [selection, setSelection] = useState<ProfileSelection | null>(initialSelection ?? null);
  const [editorVersion, setEditorVersion] = useState(0);
  const [dirty, setDirty] = useState(false);
  // R4W-01: the settings page asks before it closes while the editor holds unsaved changes.
  useEffect(() => {
    onDirtyChange?.(dirty);
  }, [dirty, onDirtyChange]);
  const [pending, setPending] = useState<ProfileSelection | null>(null);
  const [notice, setNotice] = useState<Notice | null>(null);

  // The chosen profile, else the default one (also after it was deleted elsewhere).
  const chosen: ProfileSelection | null =
    selection?.kind === 'new'
      ? selection
      : selection !== null && profiles.some((profile) => profile.id === selection.id)
        ? selection
        : defaultId === null
          ? null
          : { kind: 'profile', id: defaultId };

  /** `null` = the default profile. */
  const open = (next: ProfileSelection | null) => {
    setSelection(next);
    setPending(null);
    setDirty(false);
    setEditorVersion((value) => value + 1);
  };

  const request = (next: ProfileSelection) => {
    if (dirty) {
      setPending(next);
      return;
    }
    setNotice(null);
    open(next);
  };

  const events: ProfileEditorEvents = {
    onSaved: (profileId: ProfileId, name: string) => {
      setNotice({ key: 'profiles.notices.saved', params: { name } });
      open({ kind: 'profile', id: profileId });
    },
    onDeleted: (name: string) => {
      setNotice({ key: 'profiles.notices.deleted', params: { name } });
      open(null);
    },
    onDefaultSet: (name: string) => {
      setNotice({ key: 'profiles.notices.defaultSet', params: { name } });
    },
    onDiscardNew: () => {
      setNotice(null);
      open(null);
    },
    onDirtyChange: setDirty,
  };

  const summary =
    chosen?.kind === 'profile' ? (profiles.find((profile) => profile.id === chosen.id) ?? null) : null;

  return (
    <div data-slot="profiles-settings" className="@container grid gap-3">
      <p className="text-muted-foreground text-xs">{t('profiles.description')}</p>
      <div className="grid gap-4 @2xl:grid-cols-[15rem_minmax(0,1fr)]">
        <ProfileList profiles={profiles} selection={chosen ?? { kind: 'new' }} onSelect={request} />
        <div className="grid min-w-0 content-start gap-3">
          {pending === null ? null : (
            <Alert
              tone="warning"
              data-slot="profile-discard-confirm"
              title={t('profiles.editor.discardTitle')}
              actions={
                <>
                  <Button
                    size="sm"
                    variant="outline"
                    data-action="profile-discard-changes"
                    autoFocus
                    onClick={() => {
                      setNotice(null);
                      open(pending);
                    }}
                  >
                    {t('profiles.editor.discard')}
                  </Button>
                  <Button
                    size="sm"
                    variant="ghost"
                    onClick={() => {
                      setPending(null);
                    }}
                  >
                    {t('profiles.editor.keepEditing')}
                  </Button>
                </>
              }
            />
          )}
          {notice === null ? null : (
            <Alert tone="success" data-slot="profile-notice">
              {t(notice.key, notice.params)}
            </Alert>
          )}
          {chosen === null ? null : chosen.kind === 'new' ? (
            <NewProfileEditor key={`new-${String(editorVersion)}`} profiles={profiles} events={events} />
          ) : (
            <SavedProfileEditor
              key={`${chosen.id}-${String(editorVersion)}`}
              profileId={chosen.id}
              summary={summary}
              events={events}
            />
          )}
        </div>
      </div>
    </div>
  );
}
