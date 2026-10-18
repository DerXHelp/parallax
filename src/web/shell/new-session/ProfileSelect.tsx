import { ChevronDownIcon } from 'lucide-react';
import { useId } from 'react';
import { profileIdSchema, type ProfileId } from '@shared/common';
import type { ProfileSummary } from '@shared/model';
import { useI18n } from '@web/i18n';
import { cn } from '@web/lib/cn';
import { Badge } from '@web/ui/badge';
import { Button } from '@web/ui/button';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuTrigger,
} from '@web/ui/dropdown-menu';
import { Tooltip, TooltipContent, TooltipTrigger } from '@web/ui/tooltip';
import { ProfileColorDot, ProfileIssueText, ProfileStatus, profileErrors } from './profile-status';

export interface ProfileSelectProps {
  profiles: readonly ProfileSummary[];
  value: ProfileId | null;
  onValueChange: (profileId: ProfileId) => void;
  /** Id of the trigger button (`<Label htmlFor>`). */
  id?: string;
  /** Id of the visible label: the accessible name is "<label> <profile name>". */
  labelId?: string;
  describedBy?: string;
  disabled?: boolean;
  className?: string;
}

/**
 * Profile choice (Plan "Claude-Profile": the default is pre-selected, another one is an explicit
 * choice): a menu with color, name, "Default" and the Claude Code state of every profile.
 * Profiles with `level: 'error'` findings cannot be picked; the reason is visible in the item
 * (keyboard, screen readers) and in full in its tooltip (ADR-102).
 */
export function ProfileSelect({
  profiles,
  value,
  onValueChange,
  id,
  labelId,
  describedBy,
  disabled = false,
  className,
}: ProfileSelectProps) {
  const { t } = useI18n();
  const valueId = useId();
  const selected = profiles.find((profile) => profile.id === value) ?? null;
  const selectedUnusable = selected !== null && profileErrors(selected).length > 0;
  return (
    <DropdownMenu modal={false}>
      <DropdownMenuTrigger asChild disabled={disabled}>
        <Button
          id={id}
          variant="outline"
          data-slot="profile-select"
          data-profile-id={selected?.id}
          aria-labelledby={labelId === undefined ? undefined : `${labelId} ${valueId}`}
          aria-describedby={describedBy}
          aria-invalid={selectedUnusable ? true : undefined}
          className={cn('h-auto min-h-8 w-full justify-between gap-2 py-1 text-left font-normal', className)}
        >
          <span id={valueId} className="flex min-w-0 flex-1 items-center gap-2">
            {selected === null ? (
              <span className="text-muted-foreground">{t('newSession.profile.none')}</span>
            ) : (
              <>
                <ProfileColorDot color={selected.color} />
                <span className="grid min-w-0 gap-0.5">
                  <span className="truncate font-medium">{selected.name}</span>
                  <ProfileStatus claude={selected.claude} />
                </span>
              </>
            )}
          </span>
          <ChevronDownIcon aria-hidden className="text-muted-foreground size-3.5 shrink-0" />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent
        align="start"
        data-slot="profile-select-menu"
        className="w-(--radix-dropdown-menu-trigger-width) min-w-64"
      >
        <DropdownMenuRadioGroup
          value={value ?? ''}
          onValueChange={(next) => {
            const parsed = profileIdSchema.safeParse(next);
            if (parsed.success) onValueChange(parsed.data);
          }}
        >
          {profiles.map((profile) => (
            <ProfileOption key={profile.id} profile={profile} />
          ))}
        </DropdownMenuRadioGroup>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

function ProfileOption({ profile }: { profile: ProfileSummary }) {
  const { t } = useI18n();
  const errors = profileErrors(profile);
  const unusable = errors.length > 0;
  const item = (
    <DropdownMenuRadioItem
      value={profile.id}
      disabled={unusable}
      data-profile-id={profile.id}
      className="items-start py-1.5"
    >
      <ProfileColorDot color={profile.color} className="mt-1" />
      <span className="grid min-w-0 flex-1 gap-0.5">
        <span className="flex min-w-0 items-center gap-1.5">
          <span className="truncate">{profile.name}</span>
          {profile.isDefault ? <Badge variant="outline">{t('newSession.profile.defaultBadge')}</Badge> : null}
        </span>
        {unusable ? (
          <span className="text-destructive text-2xs">
            {t('newSession.profile.unusableShort', { count: errors.length })}
          </span>
        ) : (
          <ProfileStatus claude={profile.claude} />
        )}
      </span>
    </DropdownMenuRadioItem>
  );
  if (!unusable) return item;
  // A disabled item ignores the pointer: the wrapper carries the tooltip with the full reasons.
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <div data-slot="profile-option-unusable">{item}</div>
      </TooltipTrigger>
      <TooltipContent side="right" className="grid max-w-96 gap-1">
        <span className="font-medium">{t('newSession.profile.unusable')}</span>
        {errors.map((finding, index) => (
          <ProfileIssueText key={`${finding.issue.code}-${String(index)}`} finding={finding} />
        ))}
      </TooltipContent>
    </Tooltip>
  );
}
