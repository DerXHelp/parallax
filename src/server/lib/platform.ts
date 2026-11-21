/**
 * What the desktop of this host can do (WP-102 `HostCapabilities`, WP-103): the UI shows desktop
 * actions only where the host has them. Wired into the host state by the composition
 * (`app/compose.ts`, coordinator).
 *
 * - Windows: everything (`WINDOWS_HOST_CAPABILITIES`).
 * - Linux: `desktop` when a graphical session is reachable (`DISPLAY` or `WAYLAND_DISPLAY` set; later
 *   also "not `--server`", WP-107); the integrations stay off until their packages build them
 *   (terminal emulator, editor, file manager, autostart, `parallax:` – WP-105/106).
 * - Other platforms: nothing.
 */
import { WINDOWS_HOST_CAPABILITIES, type HostCapabilities } from '@shared/model';

const NO_CAPABILITIES: HostCapabilities = {
  desktop: false,
  externalConsole: false,
  shellWindow: false,
  editor: false,
  fileManager: false,
  autostart: false,
  protocolHandler: false,
};

function isSet(value: string | undefined): boolean {
  return value !== undefined && value.trim() !== '';
}

/** True if a graphical session is reachable from this environment (X11 or Wayland). */
export function hasGraphicalSession(env: NodeJS.ProcessEnv = process.env): boolean {
  return isSet(env.DISPLAY) || isSet(env.WAYLAND_DISPLAY);
}

export function hostCapabilities(
  platform: NodeJS.Platform = process.platform,
  env: NodeJS.ProcessEnv = process.env,
): HostCapabilities {
  if (platform === 'win32') return { ...WINDOWS_HOST_CAPABILITIES };
  if (platform === 'linux') return { ...NO_CAPABILITIES, desktop: hasGraphicalSession(env) };
  return { ...NO_CAPABILITIES };
}
