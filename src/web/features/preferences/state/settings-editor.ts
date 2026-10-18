import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import type { ErrorPayload } from '@shared/errors';
import { settingsSchema, type Settings, type SettingsPatch } from '@shared/model';
import { errorPayloadOf } from '@web/state/connection';
import { showTextNotice } from '@web/state/notices';
import { updateSettings, useSettings } from '@web/state/settings';

/**
 * Editing state of the settings page: the stored settings (`host.state.settings`) with the changes
 * still waiting for the server's ack on top, so a switch moves at once and a second change made
 * before the first ack builds on the first (every `settings.update` replaces whole top-level
 * fields, WP-30 §4.12). The overlay goes away with the ack of the newest change (the store then
 * holds the server's value) or with its failure – then the stored value shows again (rollback) and
 * `error` says why. The page shows that error itself: the window's hint region lies behind the
 * modal dialog (ADR-126).
 *
 * R4W-16: the error stays until every refused field was saved successfully again or the user
 * dismisses it – a later success of another field does not hide it. A refusal that arrives after
 * the page was closed goes to the window's hint region instead (nothing is lost silently).
 */

export interface SettingsEditor {
  /** Stored settings plus the pending changes. */
  settings: Settings;
  /** Sends whole top-level fields (`settings.update`); an invalid patch is dropped. */
  save: (patch: SettingsPatch) => void;
  /** Why the newest refused change was refused; null once handled (see above). */
  error: ErrorPayload | null;
  /** Hides the error (the refused values already went back). */
  dismissError: () => void;
}

interface Failure {
  error: ErrorPayload;
  /** Top-level fields refused and not saved successfully since. */
  fields: readonly string[];
}

function merge(current: Settings, patch: SettingsPatch): Settings | null {
  const parsed = settingsSchema.safeParse({ ...current, ...patch });
  return parsed.success ? parsed.data : null;
}

export function useSettingsEditor(): SettingsEditor {
  const stored = useSettings();
  const [pending, setPending] = useState<{ settings: Settings; token: number } | null>(null);
  const [failure, setFailure] = useState<Failure | null>(null);
  const latest = useRef(0);
  const mounted = useRef(false);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  const settings = pending?.settings ?? stored;
  // The newest settings for the next patch, also before React rendered the previous one.
  const current = useRef(settings);
  useLayoutEffect(() => {
    current.current = settings;
  }, [settings]);

  const save = useCallback((patch: SettingsPatch) => {
    const next = merge(current.current, patch);
    if (next === null) return;
    const fields = Object.keys(patch);
    const token = ++latest.current;
    current.current = next;
    setPending({ settings: next, token });
    const settle = () => {
      setPending((state) => (state?.token === token ? null : state));
    };
    updateSettings(patch).then(
      () => {
        settle();
        setFailure((state) => {
          if (state === null) return null;
          const left = state.fields.filter((field) => !fields.includes(field));
          return left.length === 0 ? null : { ...state, fields: left };
        });
      },
      (caught: unknown) => {
        settle();
        const error = errorPayloadOf(caught);
        if (!mounted.current) {
          // The page is gone: the window's hint region says it (the stored value already shows).
          showTextNotice('settings.saveFailed', undefined, { tone: 'error', id: 'settings.saveFailed' });
          return;
        }
        setFailure((state) => ({ error, fields: [...new Set([...(state?.fields ?? []), ...fields])] }));
      },
    );
  }, []);

  const dismissError = useCallback(() => {
    setFailure(null);
  }, []);

  const error = failure?.error ?? null;
  return useMemo(() => ({ settings, save, error, dismissError }), [settings, save, error, dismissError]);
}
