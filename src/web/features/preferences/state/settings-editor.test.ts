import { act, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { makeError } from '@shared/errors';
import type { Settings, SettingsPatch } from '@shared/model';
import { sampleNotificationSettings, sampleSettings } from '@shared/samples';
import { ClientCommandError } from '@web/state/connection';
import { clientStore, resetClientStore } from '@web/state/store';
import { useSettingsEditor } from './settings-editor';

interface PendingUpdate {
  patch: SettingsPatch;
  resolve: () => void;
  reject: (error: unknown) => void;
}

// The store's settings and `settings.update` are replaced: every update waits until the test answers it.
const mocks = vi.hoisted(() => ({
  stored: null as Settings | null,
  updates: [] as PendingUpdate[],
}));

vi.mock('@web/state/settings', () => ({
  useSettings: () => mocks.stored,
  updateSettings: (patch: SettingsPatch) =>
    new Promise<void>((resolve, reject) => {
      mocks.updates.push({ patch, resolve, reject });
    }),
}));

function update(index: number): PendingUpdate {
  const pending = mocks.updates[index];
  if (pending === undefined) throw new Error(`no update ${String(index)}`);
  return pending;
}

const refused = new ClientCommandError(makeError('STORE_WRITE_FAILED'));

beforeEach(() => {
  mocks.stored = sampleSettings();
  mocks.updates = [];
});

afterEach(() => {
  resetClientStore();
});

describe('useSettingsEditor – errors (R4W-16)', () => {
  it('a later success of another field keeps the error; a success of the same field clears it', async () => {
    const { result } = renderHook(() => useSettingsEditor());
    act(() => {
      result.current.save({ notifications: sampleNotificationSettings({ doNotDisturb: true }) });
      result.current.save({ promptSuggestions: true });
    });
    await act(async () => {
      update(0).reject(refused);
      update(1).resolve();
      await Promise.resolve();
    });
    expect(result.current.error?.code).toBe('STORE_WRITE_FAILED');
    // The same field again, saved: the error is handled.
    act(() => {
      result.current.save({ notifications: sampleNotificationSettings({ doNotDisturb: true }) });
    });
    await act(async () => {
      update(2).resolve();
      await Promise.resolve();
    });
    expect(result.current.error).toBeNull();
  });

  it('the user can dismiss the error', async () => {
    const { result } = renderHook(() => useSettingsEditor());
    act(() => {
      result.current.save({ promptSuggestions: true });
    });
    await act(async () => {
      update(0).reject(refused);
      await Promise.resolve();
    });
    expect(result.current.error?.code).toBe('STORE_WRITE_FAILED');
    act(() => {
      result.current.dismissError();
    });
    expect(result.current.error).toBeNull();
  });

  it('a refusal after the page closed goes to the window hint region', async () => {
    const { result, unmount } = renderHook(() => useSettingsEditor());
    act(() => {
      result.current.save({ promptSuggestions: true });
    });
    unmount();
    expect(clientStore.getState().notices).toEqual([]);
    await act(async () => {
      update(0).reject(refused);
      await Promise.resolve();
    });
    expect(clientStore.getState().notices.map((notice) => [notice.id, notice.tone])).toEqual([
      ['settings.saveFailed', 'error'],
    ]);
  });
});
