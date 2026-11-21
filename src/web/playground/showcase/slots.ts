import type { FeatureSlots } from '@web/shell/slots';

/**
 * Slots of the README showcase (WP-118) that no feature playground provides: the tab "Changes"
 * (`changes`) and the full-text search (`search`). The playground never imports features; like the
 * feature demos in PlaygroundApp they come through `import.meta.glob` (dev server only, never in the
 * build). Only the `*_SLOTS` exports are taken.
 */

interface SlotModule {
  CHANGES_SLOTS?: Pick<FeatureSlots, 'ChangesPanel'>;
  SEARCH_SLOTS?: Pick<FeatureSlots, 'SearchDialog'>;
}

const modules = import.meta.glob<SlotModule>(
  ['../../features/changes/index.ts', '../../features/search/index.ts'],
  { eager: true },
);

export const SHOWCASE_SLOTS: Partial<FeatureSlots> = Object.values(modules).reduce<Partial<FeatureSlots>>(
  (all, module) => ({ ...all, ...module.CHANGES_SLOTS, ...module.SEARCH_SLOTS }),
  {},
);
