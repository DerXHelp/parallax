import { useStore } from 'zustand';
import { LIMITS, type HostId } from '@shared/common';
import type { PathRules } from '@shared/paths';
import { errorPayloadOf } from '@web/state/connection';
import { selectHostPaths } from '@web/state/host-platform';
import { canSendTo, selectHostFeature } from '@web/state/hosts';
import { showErrorNotice } from '@web/state/notices';
import { selectSettings, updateSettings } from '@web/state/settings';
import { clientStore, type ClientState } from '@web/state/store';

/**
 * WP-115 (F6, WP-110 §3.7): muted projects – `settings.notifications.mutedProjects` of the
 * project's computer (the sidebar group: `worktree?.repoRoot ?? cwd`, `sessionProjectPath`). The
 * server's notifier sends no toast and no sound for their sessions (WP-112); status, counters and
 * the unread dot stay. A path counts as muted when an entry equals it by the path rules of its
 * computer (WP-112 compares the same way); muting stores the exact string of the group.
 */

/** True when `path` is in `muted` – exactly or by the computer's path rules. */
export function isPathMuted(muted: readonly string[], path: string, rules: PathRules): boolean {
  const key = rules.key(path);
  return muted.some((entry) => entry === path || rules.key(entry) === key);
}

/** `muted` with `path` added (exact string) or every spelling of it removed; null = no change. */
export function toggledMutedProjects(
  muted: readonly string[],
  path: string,
  rules: PathRules,
  mute: boolean,
): string[] | null {
  const present = isPathMuted(muted, path, rules);
  if (present === mute) return null;
  if (mute) return muted.length >= LIMITS.projectsMax ? null : [...muted, path];
  const key = rules.key(path);
  return muted.filter((entry) => entry !== path && rules.key(entry) !== key);
}

/** The computer can mute projects (`features.overview`) and this window may change its settings. */
export function selectCanMuteProjects(state: ClientState, hostId: HostId): boolean {
  return selectHostFeature(state, hostId, 'overview') && canSendTo(hostId, 'settings.update', state);
}

export function selectProjectMuted(state: ClientState, hostId: HostId, path: string): boolean {
  const muted = selectSettings(state, hostId).notifications.mutedProjects;
  return muted.length > 0 && isPathMuted(muted, path, selectHostPaths(state, hostId));
}

export interface ProjectMute {
  /** The computer supports muting and this window may change it. */
  available: boolean;
  muted: boolean;
}

/** Mute state of a project group (re-renders when the list or the computer's features change). */
export function useProjectMute(hostId: HostId, path: string): ProjectMute {
  const available = useStore(clientStore, (state) => selectCanMuteProjects(state, hostId));
  const muted = useStore(clientStore, (state) => selectProjectMuted(state, hostId, path));
  return { available, muted };
}

/**
 * Mutes or unmutes a project on its computer: reads the current notification settings, changes the
 * list and writes the whole object (a patch replaces `notifications` as a whole). A refusal becomes
 * a notice; the optimistic change is rolled back by `updateSettings`.
 */
export function setProjectMuted(hostId: HostId, path: string, mute: boolean): void {
  const state = clientStore.getState();
  if (!selectCanMuteProjects(state, hostId)) return;
  const notifications = selectSettings(state, hostId).notifications;
  const next = toggledMutedProjects(notifications.mutedProjects, path, selectHostPaths(state, hostId), mute);
  if (next === null) return;
  updateSettings({ notifications: { ...notifications, mutedProjects: next } }, hostId).catch(
    (error: unknown) => {
      showErrorNotice(errorPayloadOf(error));
    },
  );
}
