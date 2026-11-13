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

/** The last tab of any window (localStorage through lib/storage – broken storage = overview). */
export function readLastTab(): InfoTab {
  const stored = readStorage('local', STORAGE_KEYS.sessionInfoTab);
  return stored !== null && isInfoTab(stored) ? stored : 'overview';
}

export function writeLastTab(tab: InfoTab): void {
  writeStorage('local', STORAGE_KEYS.sessionInfoTab, tab);
}
