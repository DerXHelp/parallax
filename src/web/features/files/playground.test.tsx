import { act, cleanup, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { resetSidePanelState } from '@web/shell/side-panel/state';
import { unregisterConnection } from '@web/state/connection';
import { resetClientStore } from '@web/state/store';
import { TooltipProvider } from '@web/ui/tooltip';
import { demos, slots } from './playground';
import { installResizeObserver } from './testing';

vi.setConfig({ testTimeout: 60_000 });

let restoreResizeObserver: () => void;

beforeEach(() => {
  restoreResizeObserver = installResizeObserver();
});

afterEach(() => {
  cleanup();
  act(() => {
    unregisterConnection();
  });
  resetClientStore();
  resetSidePanelState();
  restoreResizeObserver();
});

function demo(id: string) {
  const found = demos.find((candidate) => candidate.id === id);
  if (found === undefined) throw new Error(`demo ${id} missing`);
  return found;
}

describe('files playground', () => {
  it('has the host, every viewer kind, the links and the files panel', () => {
    expect(demos.map((d) => d.id)).toEqual([
      'host',
      'narrow',
      'files-panel',
      'viewer-markdown',
      'viewer-code',
      'viewer-truncated',
      'viewer-image',
      'viewer-pdf',
      'viewer-binary',
      'viewer-folder',
      'viewer-error',
      'links',
    ]);
    expect(Object.keys(slots).sort()).toEqual(['FileLink', 'FilePanel', 'FilesPanel']);
  });

  it('the host demo opens the viewer tab with the code view at the line', async () => {
    render(<TooltipProvider>{demo('host').render()}</TooltipProvider>);
    expect(await screen.findByRole('complementary', { name: 'File' })).toBeTruthy();
    expect(await screen.findByRole('region', { name: 'Content of main.ts' })).toBeTruthy();
  });

  it('the files panel demo lists the session files', async () => {
    render(<TooltipProvider>{demo('files-panel').render()}</TooltipProvider>);
    await waitFor(() => {
      expect(document.querySelectorAll('[data-slot="files-row"]').length).toBeGreaterThan(3);
    });
  });

  it('the links demo shows verified links, refused and unsafe references as text', async () => {
    render(<TooltipProvider>{demo('links').render()}</TooltipProvider>);
    await waitFor(() => {
      expect(document.querySelector('[data-state="refused"]')).not.toBeNull();
    });
    expect(document.querySelectorAll('[data-state="unsafe"]')).toHaveLength(2);
    expect(document.querySelector('[data-variant="chip"][data-kind="image"]')).not.toBeNull();
  });

  it('the error demo shows the alert', async () => {
    render(<TooltipProvider>{demo('viewer-error').render()}</TooltipProvider>);
    expect((await screen.findByRole('alert')).textContent).toContain('The file could not be shown');
  });
});
