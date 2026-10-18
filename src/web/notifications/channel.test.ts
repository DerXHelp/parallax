import { describe, expect, it } from 'vitest';
import { chooseDeliveryChannel, type DeliveryContext, type NotificationPermissionState } from './channel';

const BASE: DeliveryContext = {
  delivery: 'system',
  focused: false,
  visible: true,
  permission: 'granted',
  focusedElsewhere: 'in_app',
  osAllowed: true,
};

function choose(patch: Partial<DeliveryContext>) {
  return chooseDeliveryChannel({ ...BASE, ...patch });
}

describe('chooseDeliveryChannel (A.9, ADR-109: the window follows the server, corrects stale presence)', () => {
  const PERMISSIONS: readonly NotificationPermissionState[] = ['unsupported', 'default', 'granted', 'denied'];

  it('follows the server while the presence matches', () => {
    expect(choose({ delivery: 'system' })).toBe('system');
    expect(choose({ delivery: 'in_app', focused: true })).toBe('in_app');
  });

  it('shows an in-app hint while the user looks at the window (server still thought it was in the background)', () => {
    for (const permission of PERMISSIONS) {
      expect(choose({ delivery: 'system', focused: true, permission })).toBe('in_app');
    }
  });

  it('keeps the Windows notification in a focused window with focusedElsewhere "system"', () => {
    expect(choose({ delivery: 'system', focused: true, focusedElsewhere: 'system' })).toBe('system');
  });

  it('uses a Web Notification when an in-app hint reaches a window in the background', () => {
    expect(choose({ delivery: 'in_app', focused: false })).toBe('system');
    expect(choose({ delivery: 'in_app', focused: true, visible: false })).toBe('system');
  });

  it('never upgrades against "Do not disturb" or a switched-off toast', () => {
    expect(choose({ delivery: 'in_app', focused: false, osAllowed: false })).toBe('in_app');
  });

  it('falls back to the in-app hint without permission', () => {
    for (const permission of ['unsupported', 'default', 'denied'] as const) {
      expect(choose({ delivery: 'system', focused: false, visible: false, permission })).toBe('in_app');
      expect(choose({ delivery: 'in_app', focused: false, permission })).toBe('in_app');
    }
  });
});
