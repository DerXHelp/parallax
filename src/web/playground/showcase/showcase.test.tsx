import { act, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  hostStateSchema,
  planVersionInfoSchema,
  reviewCommentsSchema,
  sessionDetailSchema,
  sessionFileSchema,
  sessionSummarySchema,
} from '@shared/model';
import {
  type Command,
  type CommandName,
  type CommandResult,
  commandSchema,
  parseCommandResult,
  sessionOpSchema,
} from '@shared/protocol';
import { sampleSettings } from '@shared/samples';
import { getSidebarMode, setSidebarMode } from '@web/shell/navigation/sidebar-view';
import { resetQuietSlotFailures } from '@web/shell/SlotBoundary';
import { unregisterConnection } from '@web/state/connection';
import { FakeHost } from '@web/state/fake-host';
import { resetClientStore } from '@web/state/store';
import { createMemoryTransport } from '@web/state/transport';
import { PlaygroundApp } from '../PlaygroundApp';
import { isBareHash } from '../route';
import { SHOWCASE_NOW } from './clock';
import {
  prepareShowcaseHost,
  SHOWCASE_ALL_ENTRIES,
  SHOWCASE_ENTRIES,
  showcaseData,
  showcasePlanVersions,
} from './data';
import { showcaseDemos } from './demos';
import { SHOWCASE_FILES } from './files';
import { FILTER_FILES, filterReview } from './review';

// Renders the whole app five times (docs/wp/FLAKES.md: slow when the machine is busy).
vi.setConfig({ testTimeout: 60_000 });

const NOW = Date.parse(SHOWCASE_NOW);

afterEach(() => {
  unregisterConnection();
  resetClientStore();
  resetQuietSlotFailures();
  vi.restoreAllMocks();
  window.history.replaceState(null, '', '/');
});

describe('showcase data (WP-68)', () => {
  it('pass the schemas: host state, summaries, details, items, decisions, plan versions, file index', () => {
    const data = showcaseData(NOW, sampleSettings());
    expect(hostStateSchema.safeParse(data.hostState).success).toBe(true);
    expect(data.summaries.map((summary) => summary.entryId)).toEqual(SHOWCASE_ALL_ENTRIES);
    for (const summary of data.summaries) {
      expect(sessionSummarySchema.safeParse(summary).success, summary.entryId).toBe(true);
    }
    for (const snapshot of data.sessions) {
      expect(sessionDetailSchema.safeParse(snapshot.detail).success, snapshot.entryId).toBe(true);
      for (const item of snapshot.items) {
        expect(sessionOpSchema.safeParse({ op: 'item.upsert', item }).success, item.id).toBe(true);
      }
      for (const decision of snapshot.decisions) {
        expect(sessionOpSchema.safeParse({ op: 'decision.upsert', decision }).success, decision.id).toBe(
          true,
        );
      }
    }
    for (const version of showcasePlanVersions(NOW)) {
      expect(planVersionInfoSchema.safeParse(version.info).success).toBe(true);
    }
    const host = new FakeHost({ transport: createMemoryTransport(), ...data });
    prepareShowcaseHost(host, NOW);
    for (const files of host.sessionFiles.values()) {
      for (const file of files) expect(sessionFileSchema.safeParse(file).success, file.path).toBe(true);
    }
    host.dispose();
  });

  it('every open decision belongs to a tool call waiting for it; no visible "Fake"/"Sample"/"Demo"', () => {
    const data = showcaseData(NOW, sampleSettings());
    for (const snapshot of data.sessions) {
      for (const decision of snapshot.decisions) {
        const call = snapshot.items.find(
          (item) => item.kind === 'tool_call' && item.toolUseId === decision.toolUseId,
        );
        expect(call, decision.id).toMatchObject({ status: 'awaiting_decision' });
      }
    }
    // Words that must never show on a README screenshot (the host state is checked by its flags).
    const visible = JSON.stringify({
      summaries: data.summaries,
      sessions: data.sessions,
      files: SHOWCASE_FILES,
    });
    expect(visible).not.toMatch(/\b(fake|sample|demo)\b/i);
    expect(data.hostState).toMatchObject({ backend: 'sdk', dev: false, nativeNotifications: true });
  });
});

describe('showcase commands (WP-118)', () => {
  function setup() {
    const data = showcaseData(NOW, sampleSettings());
    const host = new FakeHost({ transport: createMemoryTransport(), ...data });
    const run = <N extends CommandName>(name: N, fields: Record<string, unknown>): CommandResult<N> => {
      const cmd: Command = commandSchema.parse({ name, ...fields });
      const ack = data.onCommand(cmd, host);
      if (ack?.ok !== true) throw new Error(`${name} failed`);
      const result = parseCommandResult(name, ack.result);
      if (result === null) throw new Error(`${name}: result does not match its schema`);
      return result;
    };
    return { host, run };
  }

  it('git: the filter worktree has three changed files and two commits to push, the others a clean tree', () => {
    const { host, run } = setup();
    const filter = SHOWCASE_ENTRIES.filter;
    expect(run('git.status', { entryId: filter }).status).toMatchObject({ ahead: 2, behind: 0 });
    const diff = run('git.diff', { entryId: filter, scope: 'session' });
    expect(diff.files.map((file) => file.path)).toEqual(Object.values(FILTER_FILES));
    expect(diff.base).not.toBeNull();
    const file = run('git.fileDiff', { entryId: filter, scope: 'session', path: FILTER_FILES.bar });
    expect(file.file.patch).toContain('parseFilter(useSearchParams())');
    const other = run('git.status', { entryId: SHOWCASE_ENTRIES.paypal }).status;
    expect(other).toMatchObject({ ahead: 0, files: [] });
    expect(run('git.diff', { entryId: SHOWCASE_ENTRIES.paypal, scope: 'session' }).files).toEqual([]);
    host.dispose();
  });

  it('review: one sent and one open comment on FilterBar.tsx; add/markSent come back as ops', () => {
    const comments = filterReview(NOW);
    expect(reviewCommentsSchema.safeParse(comments).success).toBe(true);
    expect(comments.map((comment) => [comment.path, comment.state])).toEqual([
      [FILTER_FILES.bar, 'sent'],
      [FILTER_FILES.bar, 'open'],
    ]);
    const { host, run } = setup();
    const filter = SHOWCASE_ENTRIES.filter;
    const added = run('review.add', {
      entryId: filter,
      path: FILTER_FILES.lib,
      side: 'new',
      line: 3,
      endLine: 3,
      quote: '  colors: string[];',
      text: 'Ok.',
    });
    expect(host.view(filter)?.detail.review.map((comment) => comment.id)).toContain(added.comment.id);
    run('review.markSent', { entryId: filter, commentIds: [added.comment.id] });
    const sent = host.view(filter)?.detail.review.find((comment) => comment.id === added.comment.id);
    expect(sent?.state).toBe('sent');
    host.dispose();
  });

  it('search: "Zeitzone" finds prompts, answers and summaries of four sessions, archived ones too', () => {
    const { host, run } = setup();
    const all = run('search.query', { text: 'zeitzone' });
    expect(new Set(all.hits.map((hit) => hit.entryId)).size).toBe(4);
    expect(new Set(all.hits.map((hit) => hit.kind))).toEqual(new Set(['prompt', 'answer', 'summary']));
    for (const hit of all.hits) {
      expect(hit.ranges.length, hit.snippet).toBeGreaterThan(0);
      for (const [from, to] of hit.ranges) expect(hit.snippet.slice(from, to).toLowerCase()).toBe('zeitzone');
    }
    const dates = all.hits.map((hit) => Date.parse(hit.at));
    expect(dates).toEqual([...dates].sort((a, b) => b - a));
    const active = run('search.query', { text: 'Zeitzone', includeArchived: false });
    expect(new Set(active.hits.map((hit) => hit.entryId)).size).toBe(2);
    host.dispose();
  });
});

describe('route', () => {
  it('&bare and &bare=1 drop the playground frame, everything else keeps it', () => {
    expect(isBareHash('#playground=showcase-plan&bare')).toBe(true);
    expect(isBareHash('#playground=showcase-plan&bare=1')).toBe(true);
    expect(isBareHash('#playground=showcase-plan&bare=0')).toBe(false);
    expect(isBareHash('#playground=showcase-plan')).toBe(false);
  });
});

describe('showcase demos', () => {
  async function sidePanel(): Promise<HTMLElement> {
    return waitFor(() => {
      const found = document.querySelector<HTMLElement>('[data-slot="side-panel"]');
      if (found === null) throw new Error('side panel not open yet');
      return found;
    });
  }

  async function open(id: string) {
    window.history.replaceState(null, '', `/#playground=${id}&bare`);
    const view = render(<PlaygroundApp />);
    await waitFor(() => {
      expect(document.querySelector(`[data-demo="${id}"] [data-showcase-ready]`)).not.toBeNull();
    });
    // Bare: no playground frame around the app.
    expect(screen.queryByRole('navigation', { name: 'Demos' })).toBeNull();
    return view;
  }

  it('are registered in order', () => {
    expect(showcaseDemos.map((demo) => demo.id)).toEqual([
      'showcase-overview',
      'showcase-plan',
      'showcase-review',
      'showcase-files',
      'showcase-search',
    ]);
  });

  it('overview: the app with every project, grouped, PayPal selected; the sidebar view comes back', async () => {
    setSidebarMode('flat');
    const view = await open('showcase-overview');
    expect(getSidebarMode()).toBe('grouped');
    // Sidebar row and header.
    expect((await screen.findAllByText('PayPal Express im Checkout')).length).toBeGreaterThanOrEqual(2);
    for (const title of [
      'Rate-Limiting für /v2/connections',
      'Erinnerungen für Termine',
      'Staging: Postgres 16',
    ]) {
      expect(screen.getAllByText(title).length, title).toBeGreaterThanOrEqual(1);
    }
    expect(document.querySelector('[data-slot="side-panel"]')).toBeNull();
    // README screenshots never show "Several computers" (WP-82): no badge, no host marks, the plain
    // folder toggle instead of the "Group by" menu with its "Computer" option.
    for (const slot of [
      'host-badge',
      'header-host',
      'pane-host',
      'multi-host-indicator',
      'row-host-status',
    ]) {
      expect(document.querySelector(`[data-slot="${slot}"]`), slot).toBeNull();
    }
    const groupControl = document.querySelector('[data-slot="sidebar-mode"]');
    expect(groupControl?.getAttribute('aria-pressed')).toBe('true');
    expect(groupControl?.getAttribute('aria-haspopup')).toBeNull();
    view.unmount();
    act(() => {
      unregisterConnection();
    });
    expect(getSidebarMode()).toBe('flat');
  });

  it('plan: the plan side panel of the rate-limit session', async () => {
    await open('showcase-plan');
    const panel = await sidePanel();
    expect(await within(panel).findByText('Nicht Teil des Plans', {}, { timeout: 15_000 })).toBeTruthy();
    act(() => {
      unregisterConnection();
    });
  });

  it('review: the changes of the filter worktree with the open comment and the git bar', async () => {
    await open('showcase-review');
    const panel = await sidePanel();
    await waitFor(
      () => {
        expect(panel.textContent).toContain('FilterBar.tsx');
        expect(panel.textContent).toContain('Reihenfolge der Facetten');
        expect(panel.textContent).toContain('multi-filter');
      },
      { timeout: 15_000 },
    );
    act(() => {
      unregisterConnection();
    });
  });

  it('search: the dialog with the hits for "Zeitzone"', async () => {
    await open('showcase-search');
    const dialog = await screen.findByRole('dialog');
    await waitFor(
      () => {
        expect(dialog.textContent).toContain('GTFS-Import beschleunigen');
        expect(dialog.textContent).toContain('Erinnerungen für Termine');
      },
      { timeout: 15_000 },
    );
    act(() => {
      unregisterConnection();
    });
  });

  it('files: the reminder service in the viewer of the push session', async () => {
    await open('showcase-files');
    const panel = await sidePanel();
    // File name in the tab and the viewer head, the folder once the file info arrived.
    await waitFor(
      () => {
        expect(panel.textContent).toContain('reminder_service.dart');
        expect(panel.textContent).toContain('vereinsapp');
      },
      { timeout: 15_000 },
    );
    act(() => {
      unregisterConnection();
    });
  });
});
