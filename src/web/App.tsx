import { AppShell } from './shell/AppShell';
import { ShellEffects } from './shell/ShellEffects';
import { FeatureSlotsProvider, type FeatureSlots } from './shell/slots';

/**
 * Feature components for the shell and feature slots. WP-20 sets the real components here
 * (TranscriptView, DecisionBar, Composer, DecisionCard, Markdown, ToolInputPreview); unset slots
 * show the neutral placeholders of WP-14. Keep it a module-level constant (stable identity).
 */
export const APP_SLOTS: Partial<FeatureSlots> = {};

/** Root component; the connection is started before the first render (main.tsx → bootApp). */
export function App() {
  return (
    <FeatureSlotsProvider slots={APP_SLOTS}>
      <ShellEffects />
      <AppShell />
    </FeatureSlotsProvider>
  );
}
