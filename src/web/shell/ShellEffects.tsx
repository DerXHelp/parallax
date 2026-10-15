import { useEffect } from 'react';
import { PRODUCT_NAME } from '@shared/product';
import { setLanguage, useT } from '@web/i18n';
import { useAttentionCount, useConnectionStatus } from '@web/state/hooks';
import { useSettings } from '@web/state/settings';
import { useThemeController } from '@web/state/theme';

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

/**
 * Applies the host settings to the window: theme (Dark/Light/System), language (start is always
 * English until `host.state` arrives) and the window title. Mounted once (App, playground).
 */
export function ShellEffects() {
  const settings = useSettings();
  useThemeController(settings.theme);
  useEffect(() => {
    setLanguage(settings.language);
  }, [settings.language]);
  useWindowTitle();
  return null;
}
