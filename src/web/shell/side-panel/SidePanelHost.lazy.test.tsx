import { act, cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { LOCAL_HOST_ID, makeSessionKey } from '@shared/common';
import { SAMPLE_IDS } from '@shared/samples';
import { TooltipProvider } from '@web/ui/tooltip';
import { requestShell } from '../requests';
import { FeatureSlotsProvider, type FeatureSlots } from '../slots';
import { SidePanelHost } from './SidePanelHost';
import { resetSidePanelState } from './state';

// Own file: a fresh module registry, so the frame chunk is not loaded yet when the host mounts.

const KEY = makeSessionKey(LOCAL_HOST_ID, SAMPLE_IDS.entry);
const SLOTS: Partial<FeatureSlots> = { PlanPanel: () => <p>plan content</p> };

afterEach(() => {
  cleanup();
  resetSidePanelState();
});

describe('SidePanelHost before its frame chunk is loaded', () => {
  it('takes the request at once and focuses the panel when the frame arrives', async () => {
    render(
      <TooltipProvider>
        <FeatureSlotsProvider slots={SLOTS}>
          <button type="button">opener</button>
          <SidePanelHost sessionKey={KEY} />
        </FeatureSlotsProvider>
      </TooltipProvider>,
    );
    screen.getByRole('button', { name: 'opener' }).focus();
    let taken = false;
    act(() => {
      taken = requestShell({ kind: 'sidePanel', sessionKey: KEY, tab: 'plan' });
    });
    expect(taken).toBe(true);
    const panel = await screen.findByRole('complementary', { name: 'Plan' });
    expect(panel.textContent).toContain('plan content');
    expect(document.activeElement).toBe(panel);
  });
});
