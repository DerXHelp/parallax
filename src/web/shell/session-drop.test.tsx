import { act, cleanup, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { LOCAL_HOST_ID, makeSessionKey } from '@shared/common';
import { SAMPLE_IDS } from '@shared/samples';
import { NAVIGATION_SESSION_KEYS } from '@web/playground/navigation-scenario';
import { startScenario, type RunningScenario } from '@web/playground/PlaygroundScenario';
import type { ScenarioId } from '@web/playground/scenarios';
import { resetClientStore } from '@web/state/store';
import { AppShell } from './AppShell';
import { installDropGuard } from './drop-guard';
import { resetSidebarView } from './navigation/sidebar-view';
import { registerShellRequestHandler, type ShellRequestOf } from './requests';
import { SessionDropOverlay, useSessionDropZone } from './session-drop';
import { installShortcutListener } from './shortcuts';

vi.setConfig({ testTimeout: 60_000 });

const KEY = makeSessionKey(LOCAL_HOST_ID, SAMPLE_IDS.entry);

/** A `DataTransfer` item with its entry (happy-dom has neither `items` nor `webkitGetAsEntry`). */
interface FakeItem {
  kind: string;
  getAsFile(): File | null;
  webkitGetAsEntry(): { isDirectory: boolean } | null;
}

interface FakeTransfer {
  types: string[];
  files: File[];
  items?: FakeItem[];
  dropEffect: string;
}

/** A drag event like the browser's (happy-dom has no DataTransfer): bubbling, cancelable. */
function drag(
  type: 'dragover' | 'dragleave' | 'drop',
  target: Element,
  types: string[] = ['Files'],
  files: File[] = [],
  init: { relatedTarget?: EventTarget | null; items?: FakeItem[] } = {},
): { event: Event; transfer: FakeTransfer } {
  const event = new Event(type, { bubbles: true, cancelable: true });
  const transfer: FakeTransfer = { types, files, dropEffect: 'uninitialized' };
  if (init.items !== undefined) transfer.items = init.items;
  Object.defineProperty(event, 'dataTransfer', { value: transfer });
  Object.defineProperty(event, 'relatedTarget', { value: init.relatedTarget ?? null });
  act(() => {
    target.dispatchEvent(event);
  });
  return { event, transfer };
}

const cleanups: (() => void)[] = [];
let running: RunningScenario | null = null;

afterEach(() => {
  cleanup();
  for (const done of cleanups.splice(0)) done();
  running?.stop();
  running = null;
  act(() => {
    resetSidebarView();
  });
  resetClientStore();
  window.history.replaceState(null, '', '/');
});

function captureAttach(): ShellRequestOf<'attachFiles'>[] {
  const requests: ShellRequestOf<'attachFiles'>[] = [];
  cleanups.push(
    registerShellRequestHandler('attachFiles', (request) => {
      requests.push(request);
      return true;
    }),
  );
  return requests;
}

function png(name: string): File {
  return new File([new Uint8Array([137, 80, 78, 71])], name, { type: 'image/png' });
}

function Harness({ enabled }: { enabled: boolean }) {
  const drop = useSessionDropZone(KEY, enabled);
  return (
    <section data-testid="pane" className="relative" {...drop.handlers}>
      {drop.dragging ? <SessionDropOverlay /> : null}
      <p data-testid="transcript">transcript</p>
      <div
        data-testid="composer"
        onDragOver={(event) => {
          event.preventDefault();
        }}
        onDrop={(event) => {
          event.preventDefault();
        }}
      >
        composer
      </div>
    </section>
  );
}

function overlay(): Element | null {
  return document.querySelector('[data-slot="session-drop-overlay"]');
}

describe('session drop zone (R4W-02, WP-58)', () => {
  it('files over the pane show the hint; dropped they go to the composer as attachFiles', () => {
    const requests = captureAttach();
    render(<Harness enabled />);
    const transcript = screen.getByTestId('transcript');
    const over = drag('dragover', transcript);
    expect(over.event.defaultPrevented).toBe(true);
    expect(over.transfer.dropEffect).toBe('copy');
    expect(overlay()).not.toBeNull();
    expect(screen.getByText('Drop to attach')).toBeTruthy();

    const files = [png('a.png'), png('b.png')];
    const dropped = drag('drop', transcript, ['Files'], files);
    expect(dropped.event.defaultPrevented).toBe(true);
    expect(requests).toEqual([{ kind: 'attachFiles', sessionKey: KEY, files, folders: 0 }]);
    expect(overlay()).toBeNull();
  });

  it('an inner zone (the composer) handles its own drops; the pane leaves them alone', () => {
    const requests = captureAttach();
    render(<Harness enabled />);
    drag('dragover', screen.getByTestId('transcript'));
    expect(overlay()).not.toBeNull();
    // Moving onto the composer: its own hint, the pane's goes away.
    drag('dragover', screen.getByTestId('composer'));
    expect(overlay()).toBeNull();
    drag('drop', screen.getByTestId('composer'), ['Files'], [png('c.png')]);
    expect(requests).toEqual([]);
  });

  it('a folder is known by its entry and left out: the composer gets the files and the folder count (CR3-01)', () => {
    const requests = captureAttach();
    render(<Harness enabled />);
    const transcript = screen.getByTestId('transcript');
    // Chrome lists a dropped folder in `files` too: a `File` without type and with 0 bytes.
    const folder = new File([], 'src', { type: '' });
    const notes = new File(['# notes'], 'notes.md', { type: 'text/markdown' });
    const items: FakeItem[] = [
      { kind: 'file', getAsFile: () => folder, webkitGetAsEntry: () => ({ isDirectory: true }) },
      { kind: 'file', getAsFile: () => notes, webkitGetAsEntry: () => ({ isDirectory: false }) },
    ];
    drag('dragover', transcript);
    drag('drop', transcript, ['Files'], [folder, notes], { items });
    expect(requests).toEqual([{ kind: 'attachFiles', sessionKey: KEY, files: [notes], folders: 1 }]);

    // Only a folder: still a request, so the composer shows its hint ("insert the path with @").
    drag('dragover', transcript);
    drag('drop', transcript, ['Files'], [folder], { items: items.slice(0, 1) });
    expect(requests.at(-1)).toEqual({ kind: 'attachFiles', sessionKey: KEY, files: [], folders: 1 });
  });

  it('a drop without files (empty list) sends no attachFiles request', () => {
    const requests = captureAttach();
    render(<Harness enabled />);
    const transcript = screen.getByTestId('transcript');
    drag('dragover', transcript);
    const dropped = drag('drop', transcript, ['Files'], []);
    // Still taken (the guard would refuse it anyway), but nothing goes to the composer.
    expect(dropped.event.defaultPrevented).toBe(true);
    expect(requests).toEqual([]);
    expect(overlay()).toBeNull();
  });

  it('text drags and leaving the pane do not show the hint; a cancelled drag hides it', () => {
    render(<Harness enabled />);
    const transcript = screen.getByTestId('transcript');
    expect(drag('dragover', transcript, ['text/plain']).event.defaultPrevented).toBe(false);
    expect(overlay()).toBeNull();
    drag('dragover', transcript);
    // Within the pane: stays.
    drag('dragleave', transcript, ['Files'], [], { relatedTarget: screen.getByTestId('composer') });
    expect(overlay()).not.toBeNull();
    drag('dragleave', transcript, ['Files'], [], { relatedTarget: document.body });
    expect(overlay()).toBeNull();
    drag('dragover', transcript);
    act(() => {
      window.dispatchEvent(new Event('dragend'));
    });
    expect(overlay()).toBeNull();
  });

  it('without a composer taking the files: a hint instead of losing them silently', async () => {
    running = startScenario('navigation');
    cleanups.push(installShortcutListener());
    render(<AppShell />);
    await screen.findByRole('heading', { level: 1 });
    const pane = document.querySelector(`[data-session-key="${NAVIGATION_SESSION_KEYS.auth}"]`);
    if (pane === null) throw new Error('pane missing');
    expect(pane.getAttribute('data-drop-zone')).toBe('true');
    drag('drop', pane, ['Files'], [png('d.png')]);
    expect(await screen.findByText('Files cannot be attached to this session here.')).toBeTruthy();
  });

  it('a disabled zone takes nothing: the window-wide drop guard refuses as everywhere else', () => {
    const requests = captureAttach();
    cleanups.push(installDropGuard(window));
    render(<Harness enabled={false} />);
    const over = drag('dragover', screen.getByTestId('transcript'));
    expect(over.event.defaultPrevented).toBe(true);
    expect(over.transfer.dropEffect).toBe('none');
    expect(overlay()).toBeNull();
    drag('drop', screen.getByTestId('transcript'), ['Files'], [png('e.png')]);
    expect(requests).toEqual([]);
  });

  it.each<[ScenarioId, string]>([
    ['navigation-archived', NAVIGATION_SESSION_KEYS.prototype],
    ['navigation-external', NAVIGATION_SESSION_KEYS.external],
  ])('%s: no zone over the pane (drop guard stays)', async (scenario, key) => {
    const requests = captureAttach();
    running = startScenario(scenario);
    cleanups.push(installShortcutListener(), installDropGuard(window));
    render(<AppShell />);
    await screen.findByRole('heading', { level: 1 });
    const pane = document.querySelector(`[data-session-key="${key}"]`);
    if (pane === null) throw new Error('pane missing');
    expect(pane.hasAttribute('data-drop-zone')).toBe(false);
    const header = pane.querySelector('[data-slot="session-header"]') ?? pane;
    const over = drag('dragover', header);
    expect(over.transfer.dropEffect).toBe('none');
    expect(overlay()).toBeNull();
    drag('drop', header, ['Files'], [png('f.png')]);
    expect(requests).toEqual([]);
  });

  it('the overview (no session) has no zone', async () => {
    running = startScenario('navigation', { select: null });
    cleanups.push(installShortcutListener());
    render(<AppShell />);
    await waitFor(() => {
      expect(document.querySelectorAll('[data-session-row]').length).toBeGreaterThan(0);
    });
    expect(document.querySelector('[data-session-key]')).toBeNull();
    expect(document.querySelector('[data-drop-zone]')).toBeNull();
  });
});
