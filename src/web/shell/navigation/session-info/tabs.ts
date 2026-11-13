import type { SessionInfoSectionName } from '@shared/model';
import { STORAGE_KEYS, readStorage, writeStorage } from '@web/lib/storage';

/** The dialog's tabs in display order (WP-67 §1.2); `overview` is the old dialog (from `detail.init`). */
export const INFO_TABS = [
  'overview',
  'mcp',
  'permissions',
  'skills',
  'memory',
  'hooks',
  'status',
  'export',
] as const;
export type InfoTab = (typeof INFO_TABS)[number];

/** The `session.info` section behind each tab (every tab but the overview asks the running CLI). */
export const TAB_SECTION: Readonly<Record<Exclude<InfoTab, 'overview'>, SessionInfoSectionName>> = {
  mcp: 'mcp',
  permissions: 'permissions',
  skills: 'skills',
  memory: 'memory',
  hooks: 'hooks',
  status: 'status',
  export: 'export',
};

export function isInfoTab(value: string): value is InfoTab {
  return (INFO_TABS as readonly string[]).includes(value);
}

function storedTab(area: 'session' | 'local'): InfoTab | null {
  const stored = readStorage(area, STORAGE_KEYS.sessionInfoTab);
  return stored !== null && isInfoTab(stored) ? stored : null;
}

/**
 * The last tab of this window (sessionStorage), else the last one of any window (localStorage, the
 * default of new windows) – like the collapsed sidebar; broken storage = overview.
 */
export function readLastTab(): InfoTab {
  return storedTab('session') ?? storedTab('local') ?? 'overview';
}

export function writeLastTab(tab: InfoTab): void {
  writeStorage('session', STORAGE_KEYS.sessionInfoTab, tab);
  writeStorage('local', STORAGE_KEYS.sessionInfoTab, tab);
}
