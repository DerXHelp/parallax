import { act, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { STANDARD_PROFILE_ID } from '@shared/common';
import { sampleHostState, sampleId, sampleProfileSummary, sampleSummary } from '@shared/samples';
import { setSelectedSession } from '@web/state/selection';
import { resetClientStore } from '@web/state/store';
import { TooltipProvider } from '@web/ui/tooltip';
import { EmptyState } from './EmptyState';
import { startNewSessionDemo, type NewSessionDemo } from './new-session/demo-host';
import { NewSessionForm, chosenProfile } from './NewSessionForm';

// Form + menus: a few seconds in a full `pnpm test`, more under parallel load (docs/wp/FLAKES.md).
vi.setConfig({ testTimeout: 60_000 });

const WORK = sampleId('pf', 2);
const GONE = sampleId('pf', 9);

const PROFILES = [
  sampleProfileSummary(),
  sampleProfileSummary({ id: WORK, name: 'Work', color: 'blue', isDefault: false, builtin: false }),
];

let demo: NewSessionDemo | null = null;

afterEach(() => {
  demo?.stop();
  demo = null;
  resetClientStore();
  act(() => {
    setSelectedSession(null, { updateHash: false });
  });
});

function profileTrigger(): HTMLElement {
  const trigger = document.querySelector<HTMLElement>('[data-slot="profile-select"]');
  if (trigger === null) throw new Error('profile select missing');
  return trigger;
}

async function startHost(summaryCount = 0): Promise<NewSessionDemo> {
  const at = (minutesAgo: number) => new Date(Date.now() - minutesAgo * 60_000).toISOString();
  demo = startNewSessionDemo({
    immediate: true,
    hostState: sampleHostState({ profiles: PROFILES, defaultProfileId: WORK }),
    summaries: Array.from({ length: summaryCount }, (_, n) =>
      sampleSummary({
        entryId: sampleId('en', n + 1),
        cwd: `D:\\work\\p${String(n)}`,
        lastActivityAt: at(n),
        archived: n % 3 === 0,
      }),
    ),
  });
  const running = demo;
  await waitFor(() => {
    expect(running.connection.status()).toBe('open');
  });
  return running;
}

describe('chosenProfile', () => {
  it('takes the choice if it exists, else the default, else the first profile', () => {
    expect(chosenProfile(PROFILES, WORK, STANDARD_PROFILE_ID)?.id).toBe(WORK);
    expect(chosenProfile(PROFILES, GONE, WORK)?.id).toBe(WORK);
    expect(chosenProfile(PROFILES, null, STANDARD_PROFILE_ID)?.id).toBe(STANDARD_PROFILE_ID);
    expect(chosenProfile(PROFILES, null, GONE)?.id).toBe(STANDARD_PROFILE_ID);
    expect(chosenProfile([], null, null)).toBeNull();
  });
});

describe('NewSessionForm (inline, empty state)', () => {
  it('cannot create a session before the host sent its profiles', () => {
    render(
      <TooltipProvider>
        <NewSessionForm initialCwd="D:\work" />
      </TooltipProvider>,
    );
    expect(screen.getByText('No profile available')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Create session' })).toHaveProperty('disabled', true);
  });

  it('shows the host default profile and at most eight recent projects (archived included)', async () => {
    const running = await startHost(10);
    const user = userEvent.setup();
    render(
      <TooltipProvider>
        <EmptyState />
      </TooltipProvider>,
    );
    const form = await screen.findByRole('form', { name: 'New session' });
    await waitFor(() => {
      expect(profileTrigger().getAttribute('data-profile-id')).toBe(WORK);
    });
    const recent = within(form).getByRole('list', { name: 'Recent projects' });
    const folders = within(recent)
      .getAllByRole('button')
      .map((button) => button.getAttribute('data-recent-project'));
    // p0 (archived) is the newest; p8 and p9 are beyond the eight.
    expect(folders).toEqual(Array.from({ length: 8 }, (_, n) => `D:\\work\\p${String(n)}`));
    await user.click(within(recent).getByRole('button', { name: /p3$/ }));
    await user.click(within(form).getByRole('button', { name: 'Create session' }));
    await waitFor(() => {
      expect(running.commands('session.create')).toEqual([
        { name: 'session.create', cwd: 'D:\\work\\p3', profileId: WORK },
      ]);
    });
  });

  it('falls back to the default profile when the pre-selected one is gone', async () => {
    const running = await startHost();
    const user = userEvent.setup();
    render(
      <TooltipProvider>
        <NewSessionForm initialCwd="D:\work" initialProfileId={GONE} />
      </TooltipProvider>,
    );
    await waitFor(() => {
      expect(profileTrigger().getAttribute('data-profile-id')).toBe(WORK);
    });
    await user.click(screen.getByRole('button', { name: 'Create session' }));
    await waitFor(() => {
      expect(running.commands('session.create')).toEqual([{ name: 'session.create', cwd: 'D:\\work', profileId: WORK }]);
    });
  });
});
