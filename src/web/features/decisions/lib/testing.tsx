import { render, type RenderResult } from '@testing-library/react';
import type { ReactNode } from 'react';
import type { Command } from '@shared/protocol';
import { installShortcutListener } from '@web/shell/shortcuts';
import { FeatureSlotsProvider, type FeatureSlots } from '@web/shell/slots';
import type { FakeAck, FakeHost } from '@web/state/fake-host';
import { TooltipProvider } from '@web/ui/tooltip';
import { DecisionArmDelayContext } from '../components/card-shell';
import { DEMO_ENTRIES, demoData, demoHostState, type DemoEntry } from './demo-data';
import { startDemoHost, type DemoHost } from './demo-host';

/**
 * Test harness of WP-16 (component tests only, never imported by the app): a demo host with
 * immediate op application, stub slots for `Markdown`/`ToolInputPreview` (WP-15) and the
 * window's shortcut listener. Tests reset the global stores in `afterEach` (R1-web hints).
 */

export const TEST_SLOTS: Partial<FeatureSlots> = {
  Markdown: ({ text }) => <div data-testid="markdown">{text}</div>,
  ToolInputPreview: ({ toolName }) => <div data-testid="tool-input-preview">{toolName}</div>,
};

export interface Harness {
  running: DemoHost;
  host: FakeHost;
  view: RenderResult;
  key(entry: DemoEntry): string;
  /** Commands of the given names received by the host (in order). */
  commands<N extends Command['name']>(name: N): Extract<Command, { name: N }>[];
  stop(): void;
}

export function renderWithHost(
  ui: (key: (entry: DemoEntry) => string) => ReactNode,
  options: {
    entries: readonly DemoEntry[];
    onCommand?: (cmd: Command, host: FakeHost) => FakeAck | undefined;
    armDelayMs?: number;
    slots?: Partial<FeatureSlots>;
  },
): Harness {
  const running = startDemoHost({
    ...demoData(options.entries),
    hostState: demoHostState(),
    onCommand: options.onCommand,
    immediate: true,
  });
  const removeListener = installShortcutListener();
  const key = (entry: DemoEntry) => running.sessionKey(DEMO_ENTRIES[entry]);
  const view = render(
    <DecisionArmDelayContext value={options.armDelayMs ?? 0}>
      <TooltipProvider>
        <FeatureSlotsProvider slots={options.slots ?? TEST_SLOTS}>{ui(key)}</FeatureSlotsProvider>
      </TooltipProvider>
    </DecisionArmDelayContext>,
  );
  return {
    running,
    host: running.host,
    view,
    key,
    commands: <N extends Command['name']>(name: N) =>
      running.host.commands.filter((cmd): cmd is Extract<Command, { name: N }> => cmd.name === name),
    stop() {
      view.unmount();
      removeListener();
      running.stop();
    },
  };
}
