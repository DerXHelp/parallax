import { useCallback, useLayoutEffect, useMemo, useRef, useState } from 'react';
import type { ErrorPayload } from '@shared/errors';
import { settingsSchema, type Settings, type SettingsPatch } from '@shared/model';
import { errorPayloadOf } from '@web/state/connection';
import { updateSettings, useSettings } from '@web/state/settings';

/**
 * Editing state of the settings page: the stored settings (`host.state.settings`) with the changes
 * still waiting for the server's ack on top, so a switch moves at once and a second change made
 * before the first ack builds on the first (every `settings.update` replaces whole top-level
 * fields, WP-30 §4.12). The overlay goes away with the ack of the newest change (the store then
 * holds the server's value) or with its failure – then the stored value shows again (rollback) and
 * `error` says why. The page shows that error itself: the window's hint region lies behind the
 * modal dialog (dimmed and hidden from screen readers).
 */

export interface SettingsEditor {
  /** Stored settings plus the pending changes. */
  settings: Settings;
  /** Sends whole top-level fields (`settings.update`); an invalid patch is dropped. */
  save: (patch: SettingsPatch) => void;
  /** Why the last change was refused; null after the next successful one. */
  error: ErrorPayload | null;
}

function merge(current: Settings, patch: SettingsPatch): Settings | null {
  const parsed = settingsSchema.safeParse({ ...current, ...patch });
  return parsed.success ? parsed.data : null;
}

export function useSettingsEditor(): SettingsEditor {
  const stored = useSettings();
  const [pending, setPending] = useState<{ settings: Settings; token: number } | null>(null);
  const [error, setError] = useState<ErrorPayload | null>(null);
  const latest = useRef(0);
  const settings = pending?.settings ?? stored;
  // The newest settings for the next patch, also before React rendered the previous one.
  const current = useRef(settings);
  useLayoutEffect(() => {
    current.current = settings;
  }, [settings]);

  const save = useCallback((patch: SettingsPatch) => {
    const next = merge(current.current, patch);
    if (next === null) return;
    const token = ++latest.current;
    current.current = next;
    setPending({ settings: next, token });
    const settle = () => {
      setPending((state) => (state?.token === token ? null : state));
    };
    updateSettings(patch).then(
      () => {
        settle();
        if (latest.current === token) setError(null);
      },
      (caught: unknown) => {
        settle();
        setError(errorPayloadOf(caught));
      },
    );
  }, []);

  return useMemo(() => ({ settings, save, error }), [settings, save, error]);
}
