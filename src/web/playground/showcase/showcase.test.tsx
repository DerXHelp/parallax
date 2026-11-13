import { act, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  hostStateSchema,
  planVersionInfoSchema,
  sessionDetailSchema,
  sessionFileSchema,
  sessionSummarySchema,
} from '@shared/model';
import { sessionOpSchema } from '@shared/protocol';
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
import { prepareShowcaseHost, SHOWCASE_ALL_ENTRIES, showcaseData, showcasePlanVersions } from './data';
import { showcaseDemos } from './demos';
import { SHOWCASE_FILES } from './files';

// Renders the whole app three times (docs/wp/FLAKES.md: slow when the machine is busy).
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
      'showcase-files',
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
