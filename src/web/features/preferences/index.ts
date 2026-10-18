import type { FeatureSlots } from '@web/shell/slots';
import { SettingsPage } from './SettingsPage';

/**
 * Feature `preferences` (WP-38): the settings page for the slot `SettingsPage`; WP-40 wires it in
 * App.tsx (`...PREFERENCES_SLOTS`). Sounds and their delivery live in src/web/notifications.
 */
export { SettingsPage };

export const PREFERENCES_SLOTS: Partial<FeatureSlots> = { SettingsPage };
