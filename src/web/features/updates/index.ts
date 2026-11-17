import { createElement, lazy, memo, Suspense } from 'react';
import type { FeatureSlots, NoSlotProps, UpdateNoticeSlotProps } from '@web/shell/slots';
import { useHostState } from '@web/state/hooks';
import { hasUpdateBanner, updateNotice } from './lib/update-state';

/**
 * Feature `updates` (WP-88a, WP-87 §2.3): the slots `UpdateNotice` (head of the sidebar),
 * `UpdateBanner` (ShellBanners) and `UpdatesSettings` (settings section "Updates"), always for the
 * local host. All three are lazy chunks; notice and banner first check `HostState.update` with a
 * cheap rule (lib/update-state.ts), so a window without an update loads nothing. WP-89 wires them
 * in App.tsx (`...UPDATES_SLOTS`); tests and the playground import the modules directly.
 */

const LazyUpdateNotice = lazy(() => import('./UpdateNotice'));
const LazyUpdateBanner = lazy(() => import('./UpdateBanner'));
const LazyUpdatesSettings = lazy(() => import('./UpdatesSettings'));

const UpdateNoticeSlot = memo(function UpdateNoticeSlot(props: UpdateNoticeSlotProps) {
  const update = useHostState()?.update ?? null;
  if (update === null || updateNotice(update) === null) return null;
  return createElement(Suspense, { fallback: null }, createElement(LazyUpdateNotice, props));
});

const UpdateBannerSlot = memo(function UpdateBannerSlot(props: NoSlotProps) {
  const update = useHostState()?.update ?? null;
  if (update === null || !hasUpdateBanner(update)) return null;
  return createElement(Suspense, { fallback: null }, createElement(LazyUpdateBanner, props));
});

/** No fallback: the settings page is a fixed-size dialog, the section fills once its chunk is there. */
const UpdatesSettingsSlot = memo(function UpdatesSettingsSlot(props: NoSlotProps) {
  return createElement(Suspense, { fallback: null }, createElement(LazyUpdatesSettings, props));
});

export const UPDATES_SLOTS: Pick<FeatureSlots, 'UpdateNotice' | 'UpdateBanner' | 'UpdatesSettings'> = {
  UpdateNotice: UpdateNoticeSlot,
  UpdateBanner: UpdateBannerSlot,
  UpdatesSettings: UpdatesSettingsSlot,
};
