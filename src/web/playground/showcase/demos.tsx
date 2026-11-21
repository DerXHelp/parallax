import { useEffect, useState } from 'react';
import { AppShell } from '@web/shell/AppShell';
import { getSidebarMode, setSidebarMode } from '@web/shell/navigation/sidebar-view';
import { requestShell, type SidePanelTab } from '@web/shell/requests';
import { closeSidePanel, openSidePanel, setSidePanelFile } from '@web/shell/side-panel/state';
import { setSidebarWidth, sidebarWidth } from '@web/shell/sidebar-layout';
import { FeatureSlotsProvider } from '@web/shell/slots';
import { startScenario } from '../PlaygroundScenario';
import type { PlaygroundDemo } from '../types';
import { SHOWCASE_SESSION_KEYS } from './data';
import { SHOWCASE_FILE_PATHS } from './files';
import { SHOWCASE_SLOTS } from './slots';

/**
 * The README demos (WP-68, WP-118): the whole app over the showcase scenario, each with its session
 * selected and its side panel open (or the full-text search); the sidebar grouped by project and a
 * little wider while mounted (the previous view comes back afterwards). `data-showcase-ready` tells
 * scripts/screenshots.ts that the scenario runs. Open them with `#playground=showcase-overview&bare`
 * (window-filling).
 */

interface Setup {
  select: string;
  panel: { tab: SidePanelTab; file?: string } | null;
  /** Opens the full-text search with this text once the host is connected (WP-118). */
  search?: string;
}

/** How long the search demo waits for the dialog to take `search.open` (host state not there yet). */
const SEARCH_WAIT_MS = 10_000;
const SEARCH_RETRY_MS = 50;
/** Wider than the default 288 px: the German filter labels and the session titles fit. */
const SHOWCASE_SIDEBAR_WIDTH = 336;

function Showcase({ setup }: { setup: Setup }) {
  const [ready, setReady] = useState(false);
  useEffect(() => {
    const previousMode = getSidebarMode();
    const previousWidth = sidebarWidth();
    setSidebarMode('grouped');
    setSidebarWidth(SHOWCASE_SIDEBAR_WIDTH);
    const running = startScenario('showcase', { select: setup.select });
    const { panel, search } = setup;
    if (panel !== null) {
      if (panel.file !== undefined) {
        setSidePanelFile(setup.select, { path: panel.file, line: null, col: null });
      }
      openSidePanel(setup.select, panel.tab);
    }
    let active = true;
    let timer: ReturnType<typeof setTimeout> | null = null;
    if (search === undefined) {
      queueMicrotask(() => {
        if (active) setReady(true);
      });
    } else {
      // The dialog takes the request only once a connected host searches contents.
      const started = Date.now();
      const tryOpen = () => {
        timer = null;
        if (!active) return;
        if (requestShell({ kind: 'search.open', text: search })) setReady(true);
        else if (Date.now() - started < SEARCH_WAIT_MS) timer = setTimeout(tryOpen, SEARCH_RETRY_MS);
      };
      tryOpen();
    }
    return () => {
      active = false;
      if (timer !== null) clearTimeout(timer);
      closeSidePanel(setup.select);
      running.stop();
      setSidebarMode(previousMode);
      setSidebarWidth(previousWidth);
    };
  }, [setup]);
  return (
    <FeatureSlotsProvider slots={SHOWCASE_SLOTS}>
      <div className="h-full" data-showcase-ready={ready ? '' : undefined}>
        <AppShell />
      </div>
    </FeatureSlotsProvider>
  );
}

const OVERVIEW: Setup = { select: SHOWCASE_SESSION_KEYS.paypal, panel: null };
const PLAN: Setup = { select: SHOWCASE_SESSION_KEYS.rateLimit, panel: { tab: 'plan' } };
const FILES: Setup = {
  select: SHOWCASE_SESSION_KEYS.push,
  panel: { tab: 'file', file: SHOWCASE_FILE_PATHS.reminder },
};
const REVIEW: Setup = { select: SHOWCASE_SESSION_KEYS.filter, panel: { tab: 'changes' } };
const SEARCH: Setup = { select: SHOWCASE_SESSION_KEYS.paypal, panel: null, search: 'Zeitzone' };

export const showcaseDemos: readonly PlaygroundDemo[] = [
  {
    id: 'showcase-overview',
    title: 'Showcase – Overview: many sessions, PayPal session working (README)',
    description:
      'README screenshot 1: sidebar with every state and the filter, transcript with steps, diff, running Bash, to-dos.',
    render: () => <Showcase setup={OVERVIEW} />,
  },
  {
    id: 'showcase-plan',
    title: 'Showcase – Plan v2 waiting for approval, plan in the side panel (README)',
    description: 'README screenshot 2: plan decision in the bar, plan versions in the side panel.',
    render: () => <Showcase setup={PLAN} />,
  },
  {
    id: 'showcase-review',
    title: 'Showcase – Changes tab: session diff, review comments, git bar (README)',
    description:
      'README screenshot 3: worktree session, three changed files, an open and a sent comment, 2 commits to push.',
    render: () => <Showcase setup={REVIEW} />,
  },
  {
    id: 'showcase-files',
    title: 'Showcase – File viewer, side question, background agent (README)',
    description:
      'README screenshot 4: Dart file in the viewer, FileLinks, side question card, Explore agent.',
    render: () => <Showcase setup={FILES} />,
  },
  {
    id: 'showcase-search',
    title: 'Showcase – Full-text search over every session (README)',
    description: 'README screenshot 5: hits from four sessions, archived ones included.',
    render: () => <Showcase setup={SEARCH} />,
  },
];
