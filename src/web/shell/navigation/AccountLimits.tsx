import { useMemo } from 'react';
import type { HostState, RateLimitInfo } from '@shared/model';
import { windowsPathKey } from '@shared/paths';
import { useFormat, useT } from '@web/i18n';
import { isKnownLimitWindow, limitBars, limitDeadlines, type LimitBar } from '@web/lib/account-limits';
import { cn } from '@web/lib/cn';
import { useNowUntil } from '@web/state/clock';
import { useHostState } from '@web/state/hooks';
import { Gauge } from '@web/ui/gauge';
import { PROFILE_BG } from './profile-colors';

const DAY_MS = 24 * 3_600_000;

function LimitRow({ bar, now }: { bar: LimitBar; now: number }) {
  const t = useT();
  const format = useFormat();
  const label = isKnownLimitWindow(bar.window)
    ? t(`navigation.limits.windows.${bar.window}`)
    : t('navigation.limits.window', { name: bar.window });
  // Within a day the time is enough ("resets at 22:35"), later windows name the date (bars only
  // carry future resets – limitBars leaves the past ones out).
  const resets =
    bar.resetsAt === null
      ? null
      : Date.parse(bar.resetsAt) - now < DAY_MS
        ? t('navigation.limits.resetsAt', { time: format.time(bar.resetsAt) })
        : t('navigation.limits.resetsOn', { date: format.dateTime(bar.resetsAt) });
  return (
    <div data-limit={bar.window} className="grid gap-0.5">
      <div className="text-muted-foreground flex min-w-0 items-baseline justify-between gap-2 text-2xs">
        <span className="truncate">{label}</span>
        {resets === null ? null : <span className="shrink-0 tabular-nums">{resets}</span>}
      </div>
      <Gauge value={bar.percent} label={label} className="w-full" barClassName="w-auto flex-1" />
    </div>
  );
}

type ProfileSummary = HostState['profiles'][number];

interface AccountLimitsBlock {
  /** `windowsPathKey` of the config folder; null = the default folder of Claude Code. */
  key: string | null;
  /** Every profile of this account (also those that have not reported yet), in profile order. */
  profiles: ProfileSummary[];
  bars: LimitBar[];
}

/** The account of a profile: its config folder (sign-in and subscription live there, WP41-05). */
function accountKey(profile: ProfileSummary): string | null {
  const dir = profile.configDir?.trim() ?? '';
  return dir === '' ? null : windowsPathKey(dir);
}

/**
 * One block per account (WP41-05): the server keeps the limits per profile (ADR-114), but profiles
 * with the same config folder share one sign-in – their values are the same subscription. Within an
 * account the newest report (`at`) counts.
 */
function accountLimits(hostState: HostState | null, now: number): AccountLimitsBlock[] {
  if (hostState === null) return [];
  const accounts = new Map<string | null, { profiles: ProfileSummary[]; newest: RateLimitInfo | null }>();
  for (const profile of hostState.profiles) {
    const key = accountKey(profile);
    let account = accounts.get(key);
    if (account === undefined) {
      account = { profiles: [], newest: null };
      accounts.set(key, account);
    }
    account.profiles.push(profile);
    const info = hostState.accountLimits[profile.id];
    if (
      info !== undefined &&
      (account.newest === null || Date.parse(info.at) > Date.parse(account.newest.at))
    ) {
      account.newest = info;
    }
  }
  const result: AccountLimitsBlock[] = [];
  for (const [key, account] of accounts) {
    if (account.newest === null) continue;
    const bars = limitBars(account.newest, now);
    if (bars.length > 0) result.push({ key, profiles: account.profiles, bars });
  }
  return result;
}

/**
 * Subscription limits at the bottom of the sidebar (Plan "Abo-Limit-Anzeige"): per account – the
 * profiles sharing a config folder, WP41-05 – with an entry in `HostState.accountLimits` (the server
 * keeps subscription sessions only) the 5-hour and the weekly window with "resets at HH:MM"; the
 * profile names and colors only when several accounts report. Display only. A window disappears at
 * its reset (R4W-06, V3-07) – the clock re-renders exactly then (and a day before, when the text
 * switches from the date to the time).
 */
export function AccountLimits() {
  const t = useT();
  const hostState = useHostState();
  const deadlines = useMemo(
    () => limitDeadlines(Object.values(hostState?.accountLimits ?? {}), DAY_MS),
    [hostState],
  );
  const now = useNowUntil(deadlines);
  const accounts = useMemo(() => accountLimits(hostState, now), [hostState, now]);
  if (accounts.length === 0) return null;
  const several = accounts.length > 1;
  return (
    <section
      aria-label={t('navigation.limits.label')}
      data-slot="account-limits"
      className="border-sidebar-border grid shrink-0 gap-2 border-t px-3 py-2"
    >
      {accounts.map((account) => {
        const names = account.profiles.map((profile) => profile.name).join(', ');
        return (
          <div
            key={account.key ?? ''}
            data-account-profiles={account.profiles.map((profile) => profile.id).join(' ')}
            role={several ? 'group' : undefined}
            aria-label={
              several
                ? account.profiles.length === 1
                  ? t('navigation.limits.profile', { name: names })
                  : t('navigation.limits.profiles', { names })
                : undefined
            }
            className="grid gap-1"
          >
            {several ? (
              <div aria-hidden className="flex min-w-0 items-center gap-1.5 text-2xs font-medium">
                <span className="flex shrink-0 items-center gap-0.5">
                  {account.profiles.map((profile) => (
                    <span key={profile.id} className={cn('size-2 rounded-full', PROFILE_BG[profile.color])} />
                  ))}
                </span>
                <span className="truncate">{names}</span>
              </div>
            ) : null}
            {account.bars.map((bar) => (
              <LimitRow key={bar.window} bar={bar} now={now} />
            ))}
          </div>
        );
      })}
    </section>
  );
}
