import { act, renderHook } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Language } from '@shared/common';
import type * as I18nModule from '@web/i18n';
import { getLanguage, setLanguage } from '@web/i18n';
import { STORAGE_KEYS } from '@web/lib/storage';
import { preloadInitialLanguage, readCachedLanguage, useLanguageController } from './language';

const preload = vi.hoisted(() => ({ calls: [] as string[] }));

vi.mock('@web/i18n', async (importOriginal) => {
  const actual = await importOriginal<typeof I18nModule>();
  return {
    ...actual,
    preloadLanguage: (language: Parameters<typeof actual.preloadLanguage>[0]) => {
      preload.calls.push(language);
      actual.preloadLanguage(language);
    },
  };
});

afterEach(() => {
  vi.restoreAllMocks();
  act(() => {
    setLanguage('en');
  });
  localStorage.clear();
  preload.calls.length = 0;
});

describe('window language (ADR-153)', () => {
  it('applies the settings language and remembers a non-default one for the next start', () => {
    const initialProps: { language: Language } = { language: 'de' };
    const { rerender } = renderHook(
      ({ language }) => {
        useLanguageController(language);
      },
      { initialProps },
    );
    // German is in memory in tests: the switch is synchronous.
    expect(getLanguage()).toBe('de');
    expect(localStorage.getItem(STORAGE_KEYS.language)).toBe('de');
    rerender({ language: 'en' });
    expect(getLanguage()).toBe('en');
    expect(localStorage.getItem(STORAGE_KEYS.language)).toBeNull();
  });

  it('a window that never leaves English writes nothing', () => {
    // A recording storage behind the getter: in happy-dom a spy on Storage.prototype misses methods
    // used before, and a spy on the instance (a Proxy) survives vi.restoreAllMocks().
    const writes: string[] = [];
    const real = window.localStorage;
    const recording: Storage = {
      get length() {
        return real.length;
      },
      clear: () => {
        real.clear();
      },
      key: (index) => real.key(index),
      getItem: (key) => real.getItem(key),
      setItem: (key, value) => {
        writes.push(`set ${key}=${value}`);
        real.setItem(key, value);
      },
      removeItem: (key) => {
        writes.push(`remove ${key}`);
        real.removeItem(key);
      },
    };
    vi.spyOn(window, 'localStorage', 'get').mockReturnValue(recording);
    const initialProps: { language: Language } = { language: 'en' };
    const { rerender } = renderHook(
      ({ language }) => {
        useLanguageController(language);
      },
      { initialProps },
    );
    expect(writes).toEqual([]);
    // The recording does see writes: German is remembered.
    rerender({ language: 'de' });
    expect(writes).toEqual([`set ${STORAGE_KEYS.language}=de`]);
  });

  it('reads only a known language; broken storage counts as none', () => {
    expect(readCachedLanguage()).toBeNull();
    localStorage.setItem(STORAGE_KEYS.language, 'fr');
    expect(readCachedLanguage()).toBeNull();
    localStorage.setItem(STORAGE_KEYS.language, 'de');
    expect(readCachedLanguage()).toBe('de');
    vi.spyOn(window, 'localStorage', 'get').mockImplementation(() => {
      throw new Error('SecurityError');
    });
    expect(readCachedLanguage()).toBeNull();
  });

  it('the start fetches the dictionary of the language used last, never English, and does not switch', () => {
    preloadInitialLanguage();
    expect(preload.calls).toEqual([]);
    localStorage.setItem(STORAGE_KEYS.language, 'de');
    preloadInitialLanguage();
    expect(preload.calls).toEqual(['de']);
    // The window stays English until the settings arrive (Plan Punkt 5).
    expect(getLanguage()).toBe('en');
  });
});
