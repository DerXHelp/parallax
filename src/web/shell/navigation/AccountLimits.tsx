import { useMemo } from 'react';
import type { HostState } from '@shared/model';
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

interface ProfileLimits {
  id: string;
  name: string;
  color: HostState['profiles'][number]['color'];
  bars: LimitBar[];
}

function profileLimits(hostState: HostState | null, now: number): ProfileLimits[] {
  if (hostState === null) return [];
  const result: ProfileLimits[] = [];
  for (const profile of hostState.profiles) {
    const info = hostState.accountLimits[profile.id];
    if (info === undefined) continue;
    const bars = limitBars(info, now);
    if (bars.length > 0) result.push({ id: profile.id, name: profile.name, color: profile.color, bars });
  }
  return result;
}

/**
 * Subscription limits at the bottom of the sidebar (Plan "Abo-Limit-Anzeige"): per profile with an
 * entry in `HostState.accountLimits` (the server keeps subscription sessions only) the 5-hour and
 * the weekly window with "resets at HH:MM"; name and color only when several profiles report.
 * Display only. A window disappears at its reset (R4W-06, V3-07) – the clock re-renders exactly
 * then (and a day before, when the text switches from the date to the time).
 */
export function AccountLimits() {
  const t = useT();
  const hostState = useHostState();
  const deadlines = useMemo(
    () => limitDeadlines(Object.values(hostState?.accountLimits ?? {}), DAY_MS),
    [hostState],
  );
  const now = useNowUntil(deadlines);
  const profiles = useMemo(() => profileLimits(hostState, now), [hostState, now]);
  if (profiles.length === 0) return null;
  const several = profiles.length > 1;
  return (
    <section
      aria-label={t('navigation.limits.label')}
      data-slot="account-limits"
      className="border-sidebar-border grid shrink-0 gap-2 border-t px-3 py-2"
    >
      {profiles.map((profile) => (
        <div
          key={profile.id}
          data-profile={profile.id}
          role={several ? 'group' : undefined}
          aria-label={several ? t('navigation.limits.profile', { name: profile.name }) : undefined}
          className="grid gap-1"
        >
          {several ? (
            <div aria-hidden className="flex min-w-0 items-center gap-1.5 text-2xs font-medium">
              <span className={cn('size-2 shrink-0 rounded-full', PROFILE_BG[profile.color])} />
              <span className="truncate">{profile.name}</span>
            </div>
          ) : null}
          {profile.bars.map((bar) => (
            <LimitRow key={bar.window} bar={bar} now={now} />
          ))}
        </div>
      ))}
    </section>
  );
}
