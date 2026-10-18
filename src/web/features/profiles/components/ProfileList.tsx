import { PlusIcon } from 'lucide-react';
import type { ProfileId } from '@shared/common';
import type { ProfileSummary } from '@shared/model';
import { useI18n } from '@web/i18n';
import { cn } from '@web/lib/cn';
import { issueCounts } from '@web/shell/new-session/profile-issues';
import { ProfileColorDot, ProfileStatus } from '@web/shell/new-session/profile-status';
import { Badge } from '@web/ui/badge';
import { Button } from '@web/ui/button';

/** Selection of the profile list: a saved profile or the draft of a new one. */
export type ProfileSelection = { kind: 'profile'; id: ProfileId } | { kind: 'new' };

/**
 * The profiles of the host: color, name, "Default", Claude Code state, sessions bound to it and
 * the number of findings (errors/warnings as text badges). The chosen row is `aria-current`.
 */
export function ProfileList({
  profiles,
  selection,
  onSelect,
}: {
  profiles: readonly ProfileSummary[];
  selection: ProfileSelection;
  onSelect: (selection: ProfileSelection) => void;
}) {
  const { t } = useI18n();
  return (
    <div className="grid content-start gap-2" data-slot="profile-list">
      <Button
        variant="outline"
        size="sm"
        data-action="profile-new"
        aria-current={selection.kind === 'new' ? 'true' : undefined}
        className="justify-start"
        onClick={() => {
          onSelect({ kind: 'new' });
        }}
      >
        <PlusIcon aria-hidden />
        {t('profiles.list.new')}
      </Button>
      <ul className="grid gap-px" aria-label={t('profiles.list.label')}>
        {profiles.map((profile) => {
          const current = selection.kind === 'profile' && selection.id === profile.id;
          const counts = issueCounts(profile.issues);
          return (
            <li key={profile.id}>
              <button
                type="button"
                data-profile-row={profile.id}
                aria-current={current ? 'true' : undefined}
                onClick={() => {
                  onSelect({ kind: 'profile', id: profile.id });
                }}
                className={cn(
                  'hover:bg-accent focus-visible:ring-ring grid w-full grid-cols-[auto_minmax(0,1fr)] items-start gap-x-2 gap-y-0.5 rounded-md px-2 py-1.5 text-left outline-none focus-visible:ring-2',
                  current && 'bg-accent text-accent-foreground',
                )}
              >
                <ProfileColorDot color={profile.color} className="mt-1" />
                <span className="flex min-w-0 flex-wrap items-center gap-1">
                  <span className="truncate text-ui font-medium">{profile.name}</span>
                  {profile.isDefault ? <Badge variant="outline">{t('profiles.list.default')}</Badge> : null}
                  {profile.builtin ? <Badge variant="secondary">{t('profiles.list.builtin')}</Badge> : null}
                </span>
                <span className="col-start-2 grid min-w-0 gap-0.5">
                  <ProfileStatus claude={profile.claude} />
                  <span className="text-muted-foreground flex flex-wrap items-center gap-1 text-2xs">
                    <span>{t('profiles.list.sessions', { count: profile.entryCount })}</span>
                    {counts.error > 0 ? (
                      <Badge variant="destructive">{t('profiles.list.errors', { count: counts.error })}</Badge>
                    ) : null}
                    {counts.warning > 0 ? (
                      <Badge variant="warning">{t('profiles.list.warnings', { count: counts.warning })}</Badge>
                    ) : null}
                  </span>
                </span>
              </button>
            </li>
          );
        })}
      </ul>
    </div>
  );
}
