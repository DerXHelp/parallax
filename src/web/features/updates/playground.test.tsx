import { act, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { FeatureSlotsProvider, type FeatureSlots } from '@web/shell/slots';
import { unregisterConnection } from '@web/state/connection';
import { resetClientStore } from '@web/state/store';
import { TooltipProvider } from '@web/ui/tooltip';
import { demos, slots } from './playground';

vi.setConfig({ testTimeout: 30_000 });

afterEach(() => {
  act(() => {
    unregisterConnection();
  });
  resetClientStore();
});

const MARKDOWN: Partial<FeatureSlots> = {
  Markdown: ({ text }: { text: string }) => <div data-testid="markdown">{text}</div>,
};

function renderDemo(id: string) {
  const demo = demos.find((candidate) => candidate.id === id);
  if (demo === undefined) throw new Error(`demo ${id} missing`);
  return render(
    <FeatureSlotsProvider slots={MARKDOWN}>
      <TooltipProvider>{demo.render()}</TooltipProvider>
    </FeatureSlotsProvider>,
  );
}

describe('updates playground', () => {
  it('lists the demos and provides the three slots', () => {
    expect(demos.map((demo) => demo.id)).toEqual([
      'settings',
      'checkout',
      'notice-available',
      'notice-ready',
      'banners',
      'banner-back',
    ]);
    expect(Object.keys(slots).sort()).toEqual(['UpdateBanner', 'UpdateNotice', 'UpdatesSettings']);
  });

  it('the settings demo switches sample states; "What\'s new" answers from the fake', async () => {
    const user = userEvent.setup();
    renderDemo('settings');
    expect(await screen.findByText('Parallax 1.0.1 is available.')).toBeTruthy();
    await user.click(screen.getByRole('button', { name: 'ready' }));
    expect(await screen.findByText('Parallax 1.0.1 is ready. Restart to switch.')).toBeTruthy();
    await user.click(screen.getByRole('button', { name: 'What’s new in 1.0.1' }));
    const dialog = await screen.findByRole('dialog', { name: 'What’s new' });
    expect(await within(dialog).findByText(/Updates in der App/)).toBeTruthy();
  });

  it('the notice and banner demos render', async () => {
    const { unmount } = renderDemo('notice-ready');
    expect(await screen.findAllByRole('button', { name: 'Parallax 1.0.1 ready – restart' })).toHaveLength(2);
    unmount();
    renderDemo('banners');
    await waitFor(() => {
      expect(screen.getByRole('alert').textContent).toContain('Update to Parallax 1.0.1 failed');
    });
    expect(screen.getByText('Updated to Parallax 1.0.0')).toBeTruthy();
  });
});
