import type { AppVersion, HostState, UpdateState, UpdateStatus } from '@shared/model';
import { compareVersions } from '@shared/version';

/**
 * Pure rules of the update UI over `HostState.update` (WP-87 §2.3): when the sidebar hint shows,
 * when the banner shows, which way a version change went, which statuses block the buttons.
 */

export interface UpdateNoticeInfo {
  /** `available` = "Parallax <v> available"; `ready` = prepared, a restart switches. */
  kind: 'available' | 'ready';
  version: AppVersion;
}

/** The sidebar hint: `available`/`ready` with a version the user did not hide; else null. */
export function updateNotice(update: UpdateState): UpdateNoticeInfo | null {
  if (update.status !== 'available' && update.status !== 'ready') return null;
  const version = update.available?.version;
  if (version === undefined || version === update.dismissedVersion) return null;
  return { kind: update.status, version };
}

/** The banner shows after a version change or a failed switch. */
export function hasUpdateBanner(update: UpdateState): boolean {
  return update.justUpdated !== null || update.failedUpdate !== null;
}

type VersionChange = NonNullable<UpdateState['justUpdated']>;

/** `to` is older than `from` (a rollback, an older package): "Switched to", not "Updated to". */
export function isVersionBack(change: VersionChange): boolean {
  if (change.from === null) return false;
  const order = compareVersions(change.to, change.from);
  return order !== null && order < 0;
}

/**
 * "What's new" after a version change: the sections after `from` (an update); after a step back or
 * without `from` (first start of an installation) the running version's own section.
 */
export function whatsNewSince(change: VersionChange): AppVersion | undefined {
  return change.from === null || isVersionBack(change) ? undefined : change.from;
}

const BUSY: ReadonlySet<UpdateStatus> = new Set(['checking', 'downloading', 'preparing', 'restarting']);

/** One update step runs: the server answers every command but `dismiss` with UPDATE_BUSY. */
export function isUpdateBusy(status: UpdateStatus): boolean {
  return BUSY.has(status);
}

/** An installation that updates itself; false = a checkout or `pnpm dev` ("updates via git"). */
export function isPackaged(hostState: HostState): boolean {
  return hostState.app?.packaged === true && hostState.update.status !== 'unsupported';
}
