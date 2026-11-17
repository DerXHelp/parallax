import { act, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { LOCAL_HOST_ID } from '@shared/common';
import type { UpdateState } from '@shared/model';
import { SAMPLE_UPDATE_STATES } from '@shared/samples';
import { EN_DICTIONARY, getDictionary, setLanguage, translate } from '@web/i18n';
import { deDictionary } from '@web/i18n/dictionary.de';
import { clientStore, resetClientStore } from '@web/state/store';
import { TooltipProvider } from '@web/ui/tooltip';
import { de } from './i18n/de';
import { en } from './i18n/en';
import { UPDATES_SLOTS } from './index';
import { startUpdatesHost, updateHostState, type UpdatesHost } from './testing';

// The slots load lazy chunks: generous limits for parallel checks.
vi.setConfig({ testTimeout: 30_000 });

let running: UpdatesHost | null = null;

afterEach(() => {
  running?.stop();
  running = null;
  act(() => {
    setLanguage('en');
  });
  resetClientStore();
});

async function start(update: UpdateState): Promise<void> {
  running = startUpdatesHost({ hostState: updateHostState(update) });
  await waitFor(() => {
    expect(clientStore.getState().hosts[LOCAL_HOST_ID]?.hostState ?? null).not.toBeNull();
  });
}

const { UpdateNotice, UpdateBanner, UpdatesSettings } = UPDATES_SLOTS;

describe('UPDATES_SLOTS (WP-89 wires them in App.tsx)', () => {
  it('provides exactly the three update slots', () => {
    expect(Object.keys(UPDATES_SLOTS).sort()).toEqual(['UpdateBanner', 'UpdateNotice', 'UpdatesSettings']);
  });

  it('notice and banner load nothing without an update to show', async () => {
    await start(SAMPLE_UPDATE_STATES.idle);
    const { container } = render(
      <TooltipProvider>
        <UpdateNotice compact={false} />
        <UpdateBanner />
      </TooltipProvider>,
    );
    expect(container.innerHTML).toBe('');
  });

  it('the notice and the banner appear once there is something to show (lazy chunks)', async () => {
    await start(SAMPLE_UPDATE_STATES.available);
    render(
      <TooltipProvider>
        <UpdateNotice compact={false} />
        <UpdateBanner />
      </TooltipProvider>,
    );
    expect(await screen.findByRole('button', { name: 'Parallax 1.0.1 available' })).toBeTruthy();
    act(() => {
      const host = running?.host;
      host?.setHostState({ ...host.hostState, update: SAMPLE_UPDATE_STATES.justUpdated });
    });
    expect(await screen.findByText('Updated to Parallax 1.0.0')).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Parallax 1.0.1 available' })).toBeNull();
  });

  it('the settings section loads its chunk', async () => {
    await start(SAMPLE_UPDATE_STATES.idle);
    render(
      <TooltipProvider>
        <UpdatesSettings />
      </TooltipProvider>,
    );
    expect(await screen.findByRole('button', { name: 'Check now' })).toBeTruthy();
  });
});

describe('namespace updates', () => {
  it('is registered in both languages', () => {
    expect(EN_DICTIONARY.updates).toBe(en);
    expect(deDictionary.updates).toBe(de);
    expect(getDictionary('de')?.updates).toBe(de);
    expect(translate('de', 'updates.settings.installFile')).toBe('Aus Datei installieren…');
  });
});
