import type { ReactNode } from 'react';
import type { FeatureSlots } from '@web/shell/slots';

/**
 * One demo in the playground (architecture §2.3c). `title` is English developer text (no `t()`),
 * data comes from `@shared/samples`.
 */
export interface PlaygroundDemo {
  /** Unique within its module; the playground prefixes the feature folder (`transcript/markdown`). */
  id: string;
  title: string;
  /** Optional one-line developer note. */
  description?: string;
  render(): ReactNode;
}

/**
 * Shape of `src/web/features/<f>/playground.tsx` (found via `import.meta.glob`, no central list).
 * `slots` (optional, WP-14 extension): components this feature provides for the FeatureSlots –
 * the playground's shell demos then show the real Transcript/DecisionBar/Composer instead of
 * placeholders, without WP-14 importing features.
 */
export interface PlaygroundModule {
  demos?: readonly PlaygroundDemo[];
  slots?: Partial<FeatureSlots>;
}
