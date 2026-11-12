import { useEffect } from 'react';
import { PRODUCT_NAME } from '@shared/product';
import { useLanguageLoadFailure, useT } from '@web/i18n';
import { useAttentionCount, useConnectionStatus } from '@web/state/hooks';
import { useLanguageController } from '@web/state/language';
import { showTextNotice } from '@web/state/notices';
import { useSettings } from '@web/state/settings';
import { useThemeController } from '@web/state/theme';
import { installDropGuard } from './drop-guard';
import { reloadWindow } from './SlotBoundary';

/**
 * Window title "(n) Parallax" with n = sessions waiting for the user (Plan "Benachrichtigungen").
 * Without a live server (stopped, signed out, outdated window) nothing waits here any more: plain
 * "Parallax" (V2-08), even though the last summaries are still in the store.
 */
export function useWindowTitle(): void {
  const attention = useAttentionCount();
  const closed = useConnectionStatus() === 'closed';
  const count = closed ? 0 : attention;
  const t = useT();
  useEffect(() => {
    document.title = count > 0 ? t('shell.windowTitle', { count, product: PRODUCT_NAME }) : PRODUCT_NAME;
  }, [count, t]);
}

/** Id of the notice "the chosen language could not be loaded" (one per window, ADR-153). */
export const LANGUAGE_LOAD_NOTICE_ID = 'shell-language-load';

/**
 * ADR-153: the dictionary of the chosen language is a lazy chunk. When it cannot be loaded (e.g.
 * Parallax was rebuilt while this window was open) the window stays English and says so once –
 * `useLanguageLoadFailure` reports only the first failure of the window; a fixed notice id keeps a
 * second mount (StrictMode, playground) from stacking it.
 */
function useLanguageLoadNotice(): void {
  const failed = useLanguageLoadFailure();
  useEffect(() => {
    if (failed === null) return;
    showTextNotice('settings.languageLoadFailed', undefined, {
      tone: 'warning',
      id: LANGUAGE_LOAD_NOTICE_ID,
      durationMs: 15_000,
      action: { label: 'common.reload', run: reloadWindow },
    });
  }, [failed]);
}

/**
 * Applies the host settings to the window: theme (Dark/Light/System), language (start is always
 * English until `host.state` arrives; another language switches once its lazy dictionary is
 * loaded) and the window title; guards the window against file and link drops outside a drop zone
 * (R4W-02, drop-guard.ts). Mounted once (App, playground).
 */
export function ShellEffects() {
  const settings = useSettings();
  useThemeController(settings.theme);
  useLanguageController(settings.language);
  useLanguageLoadNotice();
  useWindowTitle();
  useEffect(() => installDropGuard(window), []);
  return null;
}
