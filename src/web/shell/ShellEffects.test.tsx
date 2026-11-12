import { act, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { StrictMode, useSyncExternalStore } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Language } from '@shared/common';
import type * as I18nModule from '@web/i18n';
import { clientStore, resetClientStore } from '@web/state/store';
import { NotificationCenter } from './NotificationCenter';
import { LANGUAGE_LOAD_NOTICE_ID, ShellEffects } from './ShellEffects';

/**
 * ADR-153: the lazy dictionary of the chosen language may fail to load (tests always have it in
 * memory, so the failure of the real controller is simulated here; its own logic is tested in
 * i18n.test.tsx). The shell then says so once – English stays.
 */
const failure = vi.hoisted(() => {
  let value: Language | null = null;
  const listeners = new Set<() => void>();
  return {
    get: (): Language | null => value,
    set: (next: Language | null): void => {
      value = next;
      for (const listener of listeners) listener();
    },
    subscribe: (listener: () => void): (() => void) => {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
  };
});

vi.mock('@web/i18n', async (importOriginal) => {
  const actual = await importOriginal<typeof I18nModule>();
  return {
    ...actual,
    useLanguageLoadFailure: () => useSyncExternalStore(failure.subscribe, failure.get, failure.get),
  };
});

afterEach(() => {
  failure.set(null);
  resetClientStore();
});

describe('ShellEffects: a language whose dictionary cannot be loaded (ADR-153)', () => {
  it('no notice while the dictionaries load fine', () => {
    render(<ShellEffects />);
    expect(clientStore.getState().notices).toEqual([]);
  });

  it('one notice (also under StrictMode); "Reload" reloads the window', async () => {
    const reload = vi.spyOn(window.location, 'reload').mockImplementation(() => undefined);
    try {
      const user = userEvent.setup();
      render(
        <StrictMode>
          <ShellEffects />
          <NotificationCenter />
        </StrictMode>,
      );
      act(() => {
        failure.set('de');
      });
      const notices = clientStore.getState().notices;
      expect(notices.map((notice) => notice.id)).toEqual([LANGUAGE_LOAD_NOTICE_ID]);
      expect(notices[0]?.tone).toBe('warning');
      const region = screen.getByRole('region', { name: 'Notifications' });
      expect(
        within(region).getByText(
          'The texts of the chosen language could not be loaded – Parallax stays in English. Reload the window to try again.',
        ),
      ).toBeTruthy();
      await user.click(within(region).getByRole('button', { name: 'Reload' }));
      expect(reload).toHaveBeenCalledOnce();
    } finally {
      reload.mockRestore();
    }
  });
});
