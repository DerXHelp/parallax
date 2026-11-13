import { useEffect, useState } from 'react';
import { AppShell } from '@web/shell/AppShell';
import { getSidebarMode, setSidebarMode } from '@web/shell/navigation/sidebar-view';
import type { SidePanelTab } from '@web/shell/requests';
import { closeSidePanel, openSidePanel, setSidePanelFile } from '@web/shell/side-panel/state';
import { startScenario } from '../PlaygroundScenario';
import type { PlaygroundDemo } from '../types';
import { SHOWCASE_SESSION_KEYS } from './data';
import { SHOWCASE_FILE_PATHS } from './files';

/**
 * The three README demos (WP-68): the whole app over the showcase scenario, each with its session
 * selected and its side panel open; the sidebar grouped by project while mounted (the previous
 * view comes back afterwards). `data-showcase-ready` tells scripts/screenshots.ts that the
 * scenario runs. Open them with `#playground=showcase-overview&bare` (window-filling).
 */

interface Setup {
  select: string;
  panel: { tab: SidePanelTab; file?: string } | null;
}

function Showcase({ setup }: { setup: Setup }) {
  const [ready, setReady] = useState(false);
  useEffect(() => {
    const previousMode = getSidebarMode();
    setSidebarMode('grouped');
    const running = startScenario('showcase', { select: setup.select });
    const { panel } = setup;
    if (panel !== null) {
      if (panel.file !== undefined) {
        setSidePanelFile(setup.select, { path: panel.file, line: null, col: null });
      }
      openSidePanel(setup.select, panel.tab);
    }
    let active = true;
    queueMicrotask(() => {
      if (active) setReady(true);
    });
    return () => {
      active = false;
      closeSidePanel(setup.select);
      running.stop();
      setSidebarMode(previousMode);
    };
  }, [setup]);
  return (
    <div className="h-full" data-showcase-ready={ready ? '' : undefined}>
      <AppShell />
    </div>
  );
}

const OVERVIEW: Setup = { select: SHOWCASE_SESSION_KEYS.paypal, panel: null };
const PLAN: Setup = { select: SHOWCASE_SESSION_KEYS.rateLimit, panel: { tab: 'plan' } };
const FILES: Setup = {
  select: SHOWCASE_SESSION_KEYS.push,
  panel: { tab: 'file', file: SHOWCASE_FILE_PATHS.reminder },
};

export const showcaseDemos: readonly PlaygroundDemo[] = [
  {
    id: 'showcase-overview',
    title: 'Showcase – Overview: many sessions, PayPal session working (README)',
    description:
      'README screenshot 1: sidebar with every state, transcript with steps, diff, running Bash, to-dos.',
    render: () => <Showcase setup={OVERVIEW} />,
  },
  {
    id: 'showcase-plan',
    title: 'Showcase – Plan v2 waiting for approval, plan in the side panel (README)',
    description: 'README screenshot 2: plan decision in the bar, plan versions in the side panel.',
    render: () => <Showcase setup={PLAN} />,
  },
  {
    id: 'showcase-files',
    title: 'Showcase – File viewer, side question, background agent (README)',
    description:
      'README screenshot 3: Dart file in the viewer, FileLinks, side question card, Explore agent.',
    render: () => <Showcase setup={FILES} />,
  },
];
