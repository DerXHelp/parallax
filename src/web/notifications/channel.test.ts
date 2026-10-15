import { describe, expect, it } from 'vitest';
import { chooseDeliveryChannel, type NotificationPermissionState } from './channel';

describe('chooseDeliveryChannel (A.9: focused window → in-app, otherwise a Web Notification)', () => {
  const PERMISSIONS: readonly NotificationPermissionState[] = ['unsupported', 'default', 'granted', 'denied'];

  it('shows an in-app hint while the user looks at the window, whatever the permission', () => {
    for (const permission of PERMISSIONS) {
      expect(chooseDeliveryChannel({ focused: true, visible: true, permission })).toBe('in_app');
    }
  });

  it('uses a Web Notification when the window is not focused or hidden – if permitted', () => {
    expect(chooseDeliveryChannel({ focused: false, visible: true, permission: 'granted' })).toBe('system');
    expect(chooseDeliveryChannel({ focused: true, visible: false, permission: 'granted' })).toBe('system');
    expect(chooseDeliveryChannel({ focused: false, visible: false, permission: 'granted' })).toBe('system');
  });

  it('falls back to the in-app hint without permission', () => {
    for (const permission of ['unsupported', 'default', 'denied'] as const) {
      expect(chooseDeliveryChannel({ focused: false, visible: false, permission })).toBe('in_app');
    }
  });
});
