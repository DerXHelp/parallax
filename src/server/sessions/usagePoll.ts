/**
 * WP-65 §1.4: plan limits through the experimental usage query. While a claude process runs, every
 * `usagePollMs` (default 5 min) – the first time `usageFirstMs` after a spawn – ONE running
 * subscription session per profile (`apiKeySource 'none'`, ADR-114) answers `readUsage()`; the
 * windows are merged into the profile's account limits (`mergeUsage`). Never more than one round at
 * a time; failures stay quiet (the backend logs once per process and answers null).
 */
import type { Logger } from 'pino';
import type { ProfileId } from '@shared/common';
import type { UsageLimits } from '../backend/types';
import type { EntryState, SessionManagerOptions } from './entryState';
import type { TimerHandle, Timers } from './lib/timers';

export interface UsagePollerDeps {
  options: Pick<SessionManagerOptions, 'usagePollMs' | 'usageFirstMs'>;
  timers: Timers;
  states(): Iterable<EntryState>;
  merge(profileId: ProfileId, usage: UsageLimits): void;
  shuttingDown(): boolean;
  log: Logger;
}

export interface UsagePoller {
  /** A claude process was spawned: the first round follows `usageFirstMs` later (unless one is planned). */
  spawned(): void;
  /** One round now (tests, and the timer). */
  poll(): Promise<void>;
  stop(): void;
}

/** One running subscription session per profile (not external, not closing). */
export function usageSources(states: Iterable<EntryState>): Map<ProfileId, EntryState> {
  const byProfile = new Map<ProfileId, EntryState>();
  for (const s of states) {
    const rt = s.runtime;
    if (rt === null || !rt.alive || rt.closing || s.phase !== 'running' || s.removed) continue;
    if (s.entry.apiKeySource !== 'none' || s.entry.external !== null) continue;
    if (!byProfile.has(s.entry.profileId)) byProfile.set(s.entry.profileId, s);
  }
  return byProfile;
}

export function createUsagePoller(deps: UsagePollerDeps): UsagePoller {
  let timer: TimerHandle | null = null;
  let busy = false;

  const anyRunning = (): boolean => {
    for (const s of deps.states()) if (s.runtime?.alive === true) return true;
    return false;
  };

  const schedule = (delayMs: number): void => {
    if (deps.options.usagePollMs <= 0 || deps.shuttingDown() || timer !== null) return;
    timer = deps.timers.setTimeout(() => {
      timer = null;
      void poll().finally(() => {
        if (anyRunning()) schedule(deps.options.usagePollMs);
      });
    }, delayMs);
  };

  const poll = async (): Promise<void> => {
    if (busy || deps.shuttingDown()) return;
    busy = true;
    try {
      const rounds = [...usageSources(deps.states())].map(async ([profileId, s]) => {
        const rt = s.runtime;
        if (rt === null) return;
        const usage = await rt.agent.readUsage();
        if (usage !== null && !deps.shuttingDown()) deps.merge(profileId, usage);
      });
      await Promise.all(rounds);
    } catch (error) {
      deps.log.debug({ err: error }, 'usage query failed');
    } finally {
      busy = false;
    }
  };

  return {
    spawned: () => {
      schedule(deps.options.usageFirstMs);
    },
    poll,
    stop: () => {
      timer?.cancel();
      timer = null;
    },
  };
}
