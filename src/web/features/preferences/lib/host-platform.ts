import { WINDOWS_HOST_CAPABILITIES, type HostCapabilities, type HostState } from '@shared/model';
import { pathFlavorOf, pathRules, type PathFlavor, type PathRules } from '@shared/paths';

/**
 * Platform of the computer whose settings the page edits (WP-104): its path flavor, path rules and
 * desktop capabilities. Without a host state everything is as on Windows (the UI before WP-104).
 */
export interface SettingsHost {
  flavor: PathFlavor;
  rules: PathRules;
  capabilities: HostCapabilities;
}

export function settingsHostOf(hostState: HostState | null | undefined): SettingsHost {
  const flavor = hostState === null || hostState === undefined ? 'win32' : pathFlavorOf(hostState.platform);
  return {
    flavor,
    rules: pathRules(flavor),
    capabilities: hostState?.capabilities ?? WINDOWS_HOST_CAPABILITIES,
  };
}
