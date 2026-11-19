import { render } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { makeError } from '@shared/errors';
import { STORAGE_KEYS, readStorage, writeStorage } from '@web/lib/storage';
import { createHostConnection, registerConnection, unregisterConnection } from './connection';
import { FakeHost } from './fake-host';
import { selectSettings, useSettings } from './settings';
import { clientStore, resetClientStore } from './store';
import { createMemoryTransport } from './transport';
import {
  applyInitialZoom,
  applyZoom,
  getZoom,
  requestZoom,
  resetZoomState,
  useZoom,
  useZoomController,
} from './zoom';

let host: FakeHost | null = null;
const root = () => document.documentElement;

afterEach(() => {
  unregisterConnection();
  host?.dispose();
  host = null;
  resetClientStore();
  resetZoomState();
  localStorage.clear();
});

/** A connected FakeHost that records every `settings.update`; `fail` makes it refuse them. */
async function connect(fail = false): Promise<{ updates: unknown[] }> {
  const updates: unknown[] = [];
  const transport = createMemoryTransport();
  host = new FakeHost({
    transport,
    onCommand: (cmd) => {
      if (cmd.name !== 'settings.update') return undefined;
      updates.push(cmd.patch);
      return fail ? { ok: false, error: makeError('STORE_WRITE_FAILED') } : undefined;
    },
  });
  const connection = createHostConnection({ hostId: 'local', createTransport: () => transport });
  registerConnection(connection);
  connection.start();
  await expect.poll(() => clientStore.getState().hosts.local?.hostState ?? null).not.toBeNull();
  return { updates };
}

const storedZoom = () => selectSettings(clientStore.getState()).zoom;

function Controller({ zoom }: { zoom: number }) {
  useZoomController(zoom);
  return <span data-testid="zoom">{useZoom()}</span>;
}

describe('zoom of the window (WP-92)', () => {
  it('sets the root font size (none at 100 %) and caches the value', () => {
    applyZoom(125);
    expect(root().style.fontSize).toBe('125%');
    expect(getZoom()).toBe(125);
    expect(readStorage('local', STORAGE_KEYS.zoom)).toBe('125');
    applyZoom(100);
    expect(root().style.fontSize).toBe('');
    applyZoom(400);
    expect(getZoom()).toBe(200);
  });

  it('starts with the cached zoom; a broken cache means 100 %', () => {
    writeStorage('local', STORAGE_KEYS.zoom, '150');
    expect(applyInitialZoom()).toBe(150);
    expect(root().style.fontSize).toBe('150%');
    for (const broken of ['abc', '300', '12.5', '']) {
      writeStorage('local', STORAGE_KEYS.zoom, broken);
      expect(applyInitialZoom()).toBe(100);
    }
  });

  it('before host.state the window keeps the cached zoom (ShellEffects mounts first)', () => {
    writeStorage('local', STORAGE_KEYS.zoom, '150');
    applyInitialZoom();
    expect(storedZoom()).toBe(150);
    function Effects() {
      useZoomController(useSettings().zoom);
      return null;
    }
    render(<Effects />);
    expect(root().style.fontSize).toBe('150%');
    expect(readStorage('local', STORAGE_KEYS.zoom)).toBe('150');
  });

  it('applies the setting and follows its changes', () => {
    const view = render(<Controller zoom={110} />);
    expect(root().style.fontSize).toBe('110%');
    expect(view.getByTestId('zoom').textContent).toBe('110');
    view.rerender(<Controller zoom={80} />);
    expect(root().style.fontSize).toBe('80%');
    expect(view.getByTestId('zoom').textContent).toBe('80');
  });

  it('a burst of key steps applies at once and saves once, the stale setting does not jump back', async () => {
    const { updates } = await connect();
    const view = render(<Controller zoom={storedZoom()} />);
    requestZoom(110);
    requestZoom(125);
    requestZoom(150);
    expect(root().style.fontSize).toBe('150%');
    // A re-render with the (still old) setting meanwhile keeps the requested zoom.
    view.rerender(<Controller zoom={90} />);
    expect(getZoom()).toBe(150);
    await expect.poll(() => storedZoom()).toBe(150);
    await expect.poll(() => updates).toEqual([{ zoom: 150 }]);
    expect(getZoom()).toBe(150);
  });

  it('a refused save restores the stored setting and says so', async () => {
    await connect(true);
    render(<Controller zoom={storedZoom()} />);
    requestZoom(175);
    expect(getZoom()).toBe(175);
    await expect.poll(() => getZoom()).toBe(100);
    expect(root().style.fontSize).toBe('');
    expect(clientStore.getState().notices.map((notice) => notice.id)).toEqual(['settings.saveFailed']);
  });
});
