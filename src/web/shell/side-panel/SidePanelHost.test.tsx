import { act, cleanup, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { LOCAL_HOST_ID, makeSessionKey } from '@shared/common';
import { SAMPLE_IDS, sampleId } from '@shared/samples';
import { TooltipProvider } from '@web/ui/tooltip';
import { requestShell } from '../requests';
import { installShortcutListener } from '../shortcuts';
import { FeatureSlotsProvider, type FeatureSlots } from '../slots';
import { SidePanelHost } from './SidePanelHost';
import { getSidePanelFile, getSidePanelTab, resetSidePanelState, SIDE_PANEL_HISTORY_MAX } from './state';
import { SIDE_PANEL_MIN_WIDTH, SIDE_PANEL_WIDTH_KEY } from './width';

const KEY = makeSessionKey(LOCAL_HOST_ID, SAMPLE_IDS.entry);
const OTHER = makeSessionKey(LOCAL_HOST_ID, sampleId('en', 2));

const SLOTS: Partial<FeatureSlots> = {
  PlanPanel: () => <p>plan content</p>,
  FilePanel: ({ path, line }) => (
    <p data-testid="viewer">
      <button type="button">inside viewer</button>
      {`${path}@${String(line)}`}
    </p>
  ),
  FilesPanel: () => <p>files content</p>,
  TasksPanel: () => <p>tasks content</p>,
};

let areaWidth = 1400;
let originalResizeObserver: typeof ResizeObserver;
let removeShortcuts: () => void;

/** happy-dom does not lay out: every observed element reports `areaWidth`. */
class AreaResizeObserver implements ResizeObserver {
  constructor(private readonly callback: ResizeObserverCallback) {}
  observe(target: Element): void {
    this.callback(
      [
        {
          target,
          contentRect: {
            width: areaWidth,
            height: 800,
            x: 0,
            y: 0,
            top: 0,
            left: 0,
            right: areaWidth,
            bottom: 800,
            toJSON: () => ({}),
          },
          borderBoxSize: [],
          contentBoxSize: [],
          devicePixelContentBoxSize: [],
        },
      ],
      this,
    );
  }
  unobserve(): void {
    // Nothing to release: the stub reports once on observe.
  }
  disconnect(): void {
    // Nothing to release: the stub reports once on observe.
  }
}

function renderHost() {
  return render(
    <TooltipProvider>
      <FeatureSlotsProvider slots={SLOTS}>
        <button type="button">opener</button>
        <div data-testid="area" style={{ display: 'flex' }}>
          <main>transcript</main>
          <SidePanelHost sessionKey={KEY} />
        </div>
      </FeatureSlotsProvider>
    </TooltipProvider>,
  );
}

function panel(): HTMLElement {
  const aside = document.querySelector<HTMLElement>('[data-slot="side-panel"]');
  if (aside === null) throw new Error('panel closed');
  return aside;
}

function anchorWidth(): string {
  return document.querySelector<HTMLElement>('[data-slot="side-panel-anchor"]')?.style.width ?? '';
}

beforeAll(async () => {
  // The frame is a lazy chunk: resolve it once, then hosts render it synchronously
  // (SidePanelHost.lazy.test covers the first open before the chunk is there).
  render(
    <FeatureSlotsProvider slots={SLOTS}>
      <SidePanelHost sessionKey={OTHER} />
    </FeatureSlotsProvider>,
  );
  act(() => {
    requestShell({ kind: 'sidePanel', sessionKey: OTHER, tab: 'plan' });
  });
  await screen.findByRole('complementary');
  cleanup();
  resetSidePanelState();
});

beforeEach(() => {
  areaWidth = 1400;
  originalResizeObserver = window.ResizeObserver;
  window.ResizeObserver = AreaResizeObserver;
  globalThis.ResizeObserver = AreaResizeObserver;
  removeShortcuts = installShortcutListener();
});

afterEach(() => {
  cleanup();
  removeShortcuts();
  window.ResizeObserver = originalResizeObserver;
  globalThis.ResizeObserver = originalResizeObserver;
  resetSidePanelState();
  localStorage.clear();
  sessionStorage.clear();
  vi.restoreAllMocks();
});

describe('SidePanelHost (WP-54, ADR-150)', () => {
  it('is closed until a request opens a tab; the file tab appears only with an open file', async () => {
    const user = userEvent.setup();
    renderHost();
    expect(screen.queryByRole('complementary')).toBeNull();
    act(() => {
      expect(requestShell({ kind: 'sidePanel', sessionKey: KEY, tab: 'files' })).toBe(true);
    });
    expect(screen.getByRole('complementary', { name: 'Files' })).toBe(panel());
    expect(panel().getAttribute('data-tab')).toBe('files');
    const tabs = within(screen.getByRole('tablist', { name: 'Side panel' })).getAllByRole('tab');
    expect(tabs.map((tab) => tab.getAttribute('data-tab'))).toEqual(['plan', 'files', 'tasks']);
    expect(screen.getByText('files content')).toBeTruthy();
    await user.click(screen.getByRole('tab', { name: 'Tasks' }));
    expect(getSidePanelTab(KEY)).toBe('tasks');
    expect(screen.getByText('tasks content')).toBeTruthy();
    // Only the active tab is mounted.
    expect(screen.queryByText('files content')).toBeNull();
    // A request for another session is not ours.
    expect(requestShell({ kind: 'sidePanel', sessionKey: OTHER, tab: 'plan' })).toBe(false);
  });

  it('openFile shows the viewer tab with path and line; the same target again remounts it', () => {
    renderHost();
    act(() => {
      requestShell({ kind: 'openFile', sessionKey: KEY, path: 'D:\\work\\a.ts', line: 3, col: null });
    });
    expect(panel().getAttribute('data-tab')).toBe('file');
    const fileTab = screen.getByRole('tab', { name: 'File: a.ts' });
    expect(fileTab.getAttribute('aria-selected')).toBe('true');
    const viewer = screen.getByTestId('viewer');
    expect(viewer.textContent).toContain('D:\\work\\a.ts@3');
    act(() => {
      requestShell({ kind: 'openFile', sessionKey: KEY, path: 'd:\\WORK\\a.ts', line: 3, col: null });
    });
    expect(screen.getByTestId('viewer')).not.toBe(viewer);
    expect(getSidePanelFile(KEY)?.revision).toBe(1);
  });

  it('opening by request focuses the panel; Esc inside and the close button return the focus', async () => {
    const user = userEvent.setup();
    renderHost();
    const opener = screen.getByRole('button', { name: 'opener' });
    opener.focus();
    act(() => {
      requestShell({ kind: 'sidePanel', sessionKey: KEY, tab: 'plan' });
    });
    expect(document.activeElement).toBe(panel());
    await user.keyboard('{Escape}');
    expect(screen.queryByRole('complementary')).toBeNull();
    expect(document.activeElement).toBe(opener);

    act(() => {
      requestShell({ kind: 'openFile', sessionKey: KEY, path: 'D:\\work\\a.ts', line: null, col: null });
    });
    // A link inside the panel opens the next file: the original opener is kept.
    screen.getByRole('button', { name: 'inside viewer' }).focus();
    act(() => {
      requestShell({ kind: 'openFile', sessionKey: KEY, path: 'D:\\work\\b.ts', line: null, col: null });
    });
    await user.click(screen.getByRole('button', { name: 'Close panel' }));
    expect(screen.queryByRole('complementary')).toBeNull();
    expect(document.activeElement).toBe(opener);
  });

  it('Esc outside the panel does not close it (no focus trap, non-modal)', async () => {
    const user = userEvent.setup();
    renderHost();
    act(() => {
      requestShell({ kind: 'sidePanel', sessionKey: KEY, tab: 'plan' });
    });
    screen.getByRole('button', { name: 'opener' }).focus();
    await user.keyboard('{Escape}');
    expect(screen.getByRole('complementary')).toBeTruthy();
  });

  it('"Back" returns to the previous file; the history keeps the last 10 files', async () => {
    const user = userEvent.setup();
    renderHost();
    for (let index = 0; index < SIDE_PANEL_HISTORY_MAX + 2; index++) {
      act(() => {
        requestShell({
          kind: 'openFile',
          sessionKey: KEY,
          path: `D:\\work\\f${String(index)}.ts`,
          line: null,
          col: null,
        });
      });
    }
    await user.click(screen.getByRole('button', { name: 'Back to f10.ts' }));
    expect(screen.getByTestId('viewer').textContent).toContain('D:\\work\\f10.ts');
    await user.click(screen.getByRole('button', { name: 'Recently opened files' }));
    const items = screen.getAllByRole('menuitem');
    expect(items).toHaveLength(SIDE_PANEL_HISTORY_MAX - 1);
    expect(items[0]?.textContent).toContain('f9.ts');
    await user.click(items[2] ?? items[0] ?? document.body);
    expect(screen.getByTestId('viewer').textContent).toContain('D:\\work\\f7.ts');
  });

  it('splitter: arrows ± 16 px (inverted: the panel is right of it), Home/End; the width is remembered', async () => {
    const user = userEvent.setup();
    renderHost();
    act(() => {
      requestShell({ kind: 'sidePanel', sessionKey: KEY, tab: 'plan' });
    });
    const splitter = screen.getByRole('separator', { name: 'Resize panel' });
    expect(splitter.getAttribute('aria-orientation')).toBe('vertical');
    // Default: min(672, 45 % of 1400) = 630; max 70 % = 980.
    expect(splitter.getAttribute('aria-valuenow')).toBe('630');
    expect(splitter.getAttribute('aria-valuemax')).toBe('980');
    expect(anchorWidth()).toBe('630px');
    splitter.focus();
    await user.keyboard('{ArrowLeft}');
    expect(splitter.getAttribute('aria-valuenow')).toBe('646');
    expect(splitter.getAttribute('aria-valuetext')).toBe('646 px');
    await user.keyboard('{ArrowRight}{ArrowRight}');
    expect(splitter.getAttribute('aria-valuenow')).toBe('614');
    expect(localStorage.getItem(SIDE_PANEL_WIDTH_KEY)).toBe('614');
    expect(sessionStorage.getItem(SIDE_PANEL_WIDTH_KEY)).toBe('614');
    await user.keyboard('{Home}');
    expect(splitter.getAttribute('aria-valuenow')).toBe(String(SIDE_PANEL_MIN_WIDTH));
    await user.keyboard('{End}');
    expect(splitter.getAttribute('aria-valuenow')).toBe('980');
    expect(anchorWidth()).toBe('980px');

    cleanup();
    renderHost();
    act(() => {
      requestShell({ kind: 'sidePanel', sessionKey: KEY, tab: 'plan' });
    });
    expect(screen.getByRole('separator').getAttribute('aria-valuenow')).toBe('980');
  });

  it('a remembered width is clamped to 70 % of a smaller area', () => {
    localStorage.setItem(SIDE_PANEL_WIDTH_KEY, '5000');
    areaWidth = 1200;
    renderHost();
    act(() => {
      requestShell({ kind: 'sidePanel', sessionKey: KEY, tab: 'plan' });
    });
    expect(screen.getByRole('separator').getAttribute('aria-valuenow')).toBe('840');
  });

  it('works with broken storage (throws on access): default width, no error', async () => {
    const user = userEvent.setup();
    vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => {
      throw new Error('SecurityError');
    });
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new Error('QuotaExceededError');
    });
    renderHost();
    act(() => {
      requestShell({ kind: 'sidePanel', sessionKey: KEY, tab: 'plan' });
    });
    const splitter = screen.getByRole('separator');
    expect(splitter.getAttribute('aria-valuenow')).toBe('630');
    splitter.focus();
    await user.keyboard('{ArrowLeft}');
    expect(splitter.getAttribute('aria-valuenow')).toBe('646');
  });

  it('below 1100 px of session area the panel lies over the transcript (overlay), Esc still closes', async () => {
    const user = userEvent.setup();
    areaWidth = 1000;
    renderHost();
    act(() => {
      requestShell({ kind: 'sidePanel', sessionKey: KEY, tab: 'plan' });
    });
    expect(panel().getAttribute('data-mode')).toBe('overlay');
    expect(panel().style.width).toBe('450px');
    // The anchor takes no room in the row: the transcript keeps the full width.
    expect(anchorWidth()).toBe('');
    // No focus trap: Tab leaves the panel.
    expect(screen.getByRole('button', { name: 'opener' })).toBeTruthy();
    await user.keyboard('{Escape}');
    expect(screen.queryByRole('complementary')).toBeNull();
  });

  it('1100 px and more: inline next to the transcript', () => {
    areaWidth = 1100;
    renderHost();
    act(() => {
      requestShell({ kind: 'sidePanel', sessionKey: KEY, tab: 'plan' });
    });
    expect(panel().getAttribute('data-mode')).toBe('inline');
  });
});
