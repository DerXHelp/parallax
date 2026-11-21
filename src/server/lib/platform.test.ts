import { describe, expect, it } from 'vitest';
import { WINDOWS_HOST_CAPABILITIES } from '@shared/model';
import { hasGraphicalSession, hostCapabilities } from './platform';

describe('hostCapabilities (WP-102 HostCapabilities, WP-103)', () => {
  it('Windows: everything, as before', () => {
    expect(hostCapabilities('win32', {})).toEqual(WINDOWS_HOST_CAPABILITIES);
    // A copy: callers cannot change the shared constant.
    expect(hostCapabilities('win32', {})).not.toBe(WINDOWS_HOST_CAPABILITIES);
  });

  it('Linux: a desktop only with X11 or Wayland; the integrations stay off for now', () => {
    const off = {
      desktop: false,
      externalConsole: false,
      shellWindow: false,
      editor: false,
      fileManager: false,
      autostart: false,
      protocolHandler: false,
    };
    expect(hostCapabilities('linux', {})).toEqual(off);
    expect(hostCapabilities('linux', { DISPLAY: ':0' })).toEqual({ ...off, desktop: true });
    expect(hostCapabilities('linux', { WAYLAND_DISPLAY: 'wayland-0' })).toEqual({ ...off, desktop: true });
    expect(hostCapabilities('linux', { DISPLAY: '  ', WAYLAND_DISPLAY: '' })).toEqual(off);
    expect(hostCapabilities('darwin', { DISPLAY: ':0' })).toEqual(off);
  });

  it('hasGraphicalSession', () => {
    expect(hasGraphicalSession({ DISPLAY: ':1' })).toBe(true);
    expect(hasGraphicalSession({ WAYLAND_DISPLAY: 'wayland-1' })).toBe(true);
    expect(hasGraphicalSession({})).toBe(false);
  });
});
