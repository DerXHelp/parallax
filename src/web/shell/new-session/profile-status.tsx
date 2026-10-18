import {
  CircleAlertIcon,
  CircleCheckIcon,
  InfoIcon,
  LoaderCircleIcon,
  TriangleAlertIcon,
  type LucideIcon,
} from 'lucide-react';
import type { ClaudeInstallStatus, ProfileColor, ProfileIssue, ProfileSummary } from '@shared/model';
import { useI18n, type TranslationKey, type TranslationParams } from '@web/i18n';
import { cn } from '@web/lib/cn';
import { PROFILE_BG } from '@web/shell/navigation/profile-colors';
import { issueDetail } from './profile-issues';

/**
 * Shared building blocks for showing a profile (WP-36): color dot, the state of its Claude Code
 * (`ProfileSummary.claude`) and whether it can start sessions at all (`level: 'error'` findings,
 * ADR-102). Used by the "New session" dialog and the profile editor (features/profiles).
 */

export type ProfileStatusTone = 'ok' | 'warning' | 'error' | 'checking';

export interface ProfileStatusText {
  tone: ProfileStatusTone;
  key: TranslationKey;
  params: TranslationParams;
}

/** Text of a Claude Code check result (never color only: the tone also picks an icon). */
export function profileStatusText(claude: ClaudeInstallStatus): ProfileStatusText {
  const version = claude.version ?? '';
  switch (claude.state) {
    case 'checking':
      return { tone: 'checking', key: 'newSession.status.checking', params: {} };
    case 'not_found':
      return { tone: 'error', key: 'newSession.status.notFound', params: {} };
    case 'error':
      return { tone: 'error', key: 'newSession.status.error', params: {} };
    case 'ok':
      break;
  }
  if (claude.versionStatus === 'too_old') return { tone: 'warning', key: 'newSession.status.tooOld', params: { version } };
  if (claude.auth.state === 'logged_out') {
    return { tone: 'warning', key: 'newSession.status.loggedOut', params: { version } };
  }
  if (claude.auth.state === 'error') return { tone: 'warning', key: 'newSession.status.authError', params: { version } };
  const plan = claude.auth.subscriptionType;
  if (version === '') return { tone: 'ok', key: 'newSession.status.readyNoVersion', params: {} };
  return plan === null
    ? { tone: 'ok', key: 'newSession.status.ready', params: { version } }
    : { tone: 'ok', key: 'newSession.status.readyPlan', params: { version, plan } };
}

const TONE_ICON: Readonly<Record<ProfileStatusTone, LucideIcon>> = {
  ok: CircleCheckIcon,
  warning: TriangleAlertIcon,
  error: CircleAlertIcon,
  checking: LoaderCircleIcon,
};

const TONE_CLASS: Readonly<Record<ProfileStatusTone, string>> = {
  ok: 'text-success',
  warning: 'text-warning',
  error: 'text-destructive',
  checking: 'text-muted-foreground motion-safe:animate-spin',
};

/** Icon + text of the Claude Code state of a profile (`data-tone` for tests and E2E). */
export function ProfileStatus({ claude, className }: { claude: ClaudeInstallStatus; className?: string }) {
  const { t } = useI18n();
  const status = profileStatusText(claude);
  const Icon = TONE_ICON[status.tone];
  return (
    <span
      data-slot="profile-status"
      data-tone={status.tone}
      className={cn('text-muted-foreground inline-flex min-w-0 items-center gap-1 text-2xs', className)}
    >
      <Icon aria-hidden className={cn('size-3 shrink-0', TONE_CLASS[status.tone])} />
      <span className="truncate">{t(status.key, status.params)}</span>
    </span>
  );
}

/** The profile color as a small dot (decorative: the name is always next to it). */
export function ProfileColorDot({ color, className }: { color: ProfileColor; className?: string }) {
  return (
    <span aria-hidden className={cn('inline-block size-2.5 shrink-0 rounded-full', PROFILE_BG[color], className)} />
  );
}

const LEVEL_ICON: Readonly<Record<ProfileIssue['level'], LucideIcon>> = {
  error: CircleAlertIcon,
  warning: TriangleAlertIcon,
  info: InfoIcon,
};

const LEVEL_CLASS: Readonly<Record<ProfileIssue['level'], string>> = {
  error: 'text-destructive',
  warning: 'text-warning',
  info: 'text-info',
};

/**
 * One finding: level icon + level word (never color only) + the translated error text and its
 * detail (flag, field, variable name – no values).
 */
export function ProfileIssueText({
  finding,
  id,
  className,
}: {
  finding: ProfileIssue;
  id?: string;
  className?: string;
}) {
  const { t, tError } = useI18n();
  const Icon = LEVEL_ICON[finding.level];
  const detail = issueDetail(finding.issue);
  return (
    <span
      id={id}
      data-slot="profile-issue"
      data-level={finding.level}
      data-code={finding.issue.code}
      className={cn('flex min-w-0 items-start gap-1.5 text-2xs', className)}
    >
      <Icon aria-hidden className={cn('mt-px size-3 shrink-0', LEVEL_CLASS[finding.level])} />
      <span className="min-w-0">
        <span className={cn('font-medium', LEVEL_CLASS[finding.level])}>
          {t(`newSession.issues.levels.${finding.level}`)}
        </span>{' '}
        <span>{tError(finding.issue)}</span>
        {detail === null ? null : (
          <span className="text-muted-foreground block break-words">{t(detail.key, detail.params)}</span>
        )}
      </span>
    </span>
  );
}

/** Findings that block starting a session with the profile (ADR-102); none = the profile is usable. */
export function profileErrors(profile: Pick<ProfileSummary, 'issues'>): ProfileIssue[] {
  return profile.issues.filter((finding) => finding.level === 'error');
}
