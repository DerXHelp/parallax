import { render } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import {
  SETTINGS_SECTIONS,
  registerShellRequestHandler,
  requestShell,
  useShellRequestHandler,
} from './requests';

describe('shell request channel (WP-30 §4.14 C)', () => {
  it('without a handler nobody takes the request', () => {
    expect(requestShell({ kind: 'quickSwitcher' })).toBe(false);
  });

  it('delivers to the newest handler of the kind; false passes it on; removal works', () => {
    const older = vi.fn(() => true);
    const newer = vi.fn(() => false);
    const other = vi.fn(() => true);
    const removeOlder = registerShellRequestHandler('newSession', older);
    const removeNewer = registerShellRequestHandler('newSession', newer);
    const removeOther = registerShellRequestHandler('settings', other);

    expect(requestShell({ kind: 'newSession', cwd: 'D:\\work' })).toBe(true);
    expect(newer).toHaveBeenCalledWith({ kind: 'newSession', cwd: 'D:\\work' });
    expect(older).toHaveBeenCalledTimes(1);
    expect(other).not.toHaveBeenCalled();

    removeOlder();
    expect(requestShell({ kind: 'newSession' })).toBe(false);
    removeNewer();
    removeOther();
    expect(requestShell({ kind: 'settings', section: 'profiles' })).toBe(false);
  });

  it('the hook registers while mounted', () => {
    const seen: string[] = [];
    function Header() {
      useShellRequestHandler('renameTitle', (request) => {
        seen.push(request.sessionKey);
        return true;
      });
      return null;
    }
    const view = render(<Header />);
    expect(requestShell({ kind: 'renameTitle', sessionKey: 'local:en_1' })).toBe(true);
    view.unmount();
    expect(requestShell({ kind: 'renameTitle', sessionKey: 'local:en_2' })).toBe(false);
    expect(seen).toEqual(['local:en_1']);
  });

  it('settings sections include profiles (slot of WP-36)', () => {
    expect(SETTINGS_SECTIONS).toContain('profiles');
  });
});
