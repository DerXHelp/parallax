import { act, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { STANDARD_PROFILE_ID } from '@shared/common';
import { makeError } from '@shared/errors';
import {
  sampleHostState,
  sampleId,
  sampleProfileIssue,
  sampleProfileSummary,
  sampleSummary,
} from '@shared/samples';
import { setLanguage } from '@web/i18n';
import { getSelectedSession, setSelectedSession } from '@web/state/selection';
import { resetClientStore } from '@web/state/store';
import { TooltipProvider } from '@web/ui/tooltip';
import { startNewSessionDemo, type NewSessionDemo } from './new-session/demo-host';
import { NewSessionDialog, closeNewSession, openNewSession } from './NewSessionDialog';
import { requestShell } from './requests';

// Dialog + menus: a few seconds in a full `pnpm test`, more under parallel load (docs/wp/FLAKES.md).
vi.setConfig({ testTimeout: 60_000 });

const WORK = sampleId('pf', 2);
const BROKEN = sampleId('pf', 3);

const PROFILES = [
  sampleProfileSummary({ defaults: { model: 'haiku', permissionMode: 'plan', effort: 'high' } }),
  sampleProfileSummary({ id: WORK, name: 'Work', color: 'blue', isDefault: false, builtin: false }),
  sampleProfileSummary({
    id: BROKEN,
    name: 'Broken',
    color: 'red',
    isDefault: false,
    builtin: false,
    issues: [sampleProfileIssue()],
  }),
];

const at = (minutesAgo: number) => new Date(Date.now() - minutesAgo * 60_000).toISOString();

function summaries() {
  return [
    sampleSummary({ entryId: sampleId('en', 1), cwd: 'D:\\work\\parallax', lastActivityAt: at(1) }),
    sampleSummary({ entryId: sampleId('en', 2), cwd: 'd:\\WORK\\Parallax', lastActivityAt: at(5) }),
    sampleSummary({ entryId: sampleId('en', 3), cwd: 'D:\\old\\archived', lastActivityAt: at(2), archived: true }),
    sampleSummary({ entryId: sampleId('en', 4), cwd: 'D:\\work\\api', lastActivityAt: at(10) }),
  ];
}

let demo: NewSessionDemo | null = null;

afterEach(() => {
  act(() => {
    closeNewSession();
    setLanguage('en');
  });
  demo?.stop();
  demo = null;
  resetClientStore();
  setSelectedSession(null, { updateHash: false });
});

async function mount(options: { failCreate?: boolean } = {}) {
  demo = startNewSessionDemo({
    immediate: true,
    hostState: sampleHostState({ profiles: PROFILES, defaultProfileId: STANDARD_PROFILE_ID }),
    summaries: summaries(),
    onCommand: (cmd) =>
      options.failCreate === true && cmd.name === 'session.create'
        ? { ok: false, error: makeError('CWD_NOT_FOUND') }
        : undefined,
  });
  const running = demo;
  render(
    <TooltipProvider>
      <NewSessionDialog />
    </TooltipProvider>,
  );
  // Wait for the host state (profiles) before opening.
  await waitFor(() => {
    expect(running.connection.status()).toBe('open');
  });
  return running;
}

async function dialog(): Promise<HTMLElement> {
  return screen.findByRole('dialog', { name: 'New session' });
}

function profileTrigger(): HTMLElement {
  const trigger = document.querySelector<HTMLElement>('[data-slot="profile-select"]');
  if (trigger === null) throw new Error('profile select missing');
  return trigger;
}

describe('"New session" dialog (WP-36)', () => {
  it('takes the request channel: pre-filled folder and profile, then session.create with both', async () => {
    const running = await mount();
    const user = userEvent.setup();
    let taken = false;
    act(() => {
      taken = requestShell({ kind: 'newSession', cwd: 'D:\\work\\api', profileId: WORK });
    });
    expect(taken).toBe(true);
    const view = await dialog();
    expect(within(view).getByLabelText<HTMLInputElement>('Project folder').value).toBe('D:\\work\\api');
    expect(profileTrigger().getAttribute('data-profile-id')).toBe(WORK);
    expect(within(view).getByRole('button', { name: /^Profile Work/ })).toBeTruthy();
    await user.click(within(view).getByRole('button', { name: 'Create session' }));
    await waitFor(() => {
      expect(screen.queryByRole('dialog')).toBeNull();
    });
    expect(running.commands('session.create')).toEqual([
      { name: 'session.create', cwd: 'D:\\work\\api', profileId: WORK },
    ]);
    expect(getSelectedSession()).toMatch(/^local:en_/);
  });

  it('pre-selects the default profile and shows its defaults; a click handler event means no prefill', async () => {
    const running = await mount();
    const user = userEvent.setup();
    act(() => {
      openNewSession(new MouseEvent('click'));
    });
    const view = await dialog();
    expect(within(view).getByLabelText<HTMLInputElement>('Project folder').value).toBe('');
    expect(profileTrigger().getAttribute('data-profile-id')).toBe(STANDARD_PROFILE_ID);
    expect(within(view).getByText('Profile defaults: model haiku · mode Plan · effort High')).toBeTruthy();
    await user.type(within(view).getByLabelText('Project folder'), 'D:\\new');
    await user.click(within(view).getByRole('button', { name: 'Create session' }));
    await waitFor(() => {
      expect(running.commands('session.create')).toEqual([
        { name: 'session.create', cwd: 'D:\\new', profileId: STANDARD_PROFILE_ID },
      ]);
    });
  });

  it('offers another profile explicitly; profiles with errors cannot be picked (reason visible)', async () => {
    const running = await mount();
    const user = userEvent.setup();
    act(() => {
      openNewSession({ cwd: 'D:\\work\\parallax' });
    });
    const view = await dialog();
    await user.click(profileTrigger());
    const menu = await screen.findByRole('menu');
    const broken = within(menu).getByRole('menuitemradio', { name: /Broken/ });
    expect(broken.getAttribute('aria-disabled')).toBe('true');
    expect(within(broken).getByText('1 error – cannot be used')).toBeTruthy();
    expect(within(menu).getByRole('menuitemradio', { name: /Standard.*Default/ }).getAttribute('aria-checked')).toBe(
      'true',
    );
    await user.click(within(menu).getByRole('menuitemradio', { name: /Work/ }));
    expect(profileTrigger().getAttribute('data-profile-id')).toBe(WORK);
    await user.click(within(view).getByRole('button', { name: 'Create session' }));
    await waitFor(() => {
      expect(running.commands('session.create')).toEqual([
        { name: 'session.create', cwd: 'D:\\work\\parallax', profileId: WORK },
      ]);
    });
  });

  it('blocks a pre-selected profile with errors and says why', async () => {
    const running = await mount();
    act(() => {
      openNewSession({ cwd: 'D:\\work', profileId: BROKEN });
    });
    const view = await dialog();
    expect(profileTrigger().getAttribute('aria-invalid')).toBe('true');
    const alert = within(view).getByText('This profile cannot start sessions:').closest('[data-slot="profile-unusable"]');
    expect(alert?.getAttribute('role')).toBe('alert');
    expect(alert).not.toBeNull();
    expect(alert?.textContent).toContain('The profile contains an argument that Parallax controls itself.');
    expect(alert?.textContent).toContain('--resume is controlled by Parallax itself.');
    expect(within(view).getByRole('button', { name: 'Create session' })).toHaveProperty('disabled', true);
    expect(running.commands('session.create')).toEqual([]);
  });

  it('lists recent projects of all sessions (archived included) once per folder, newest first', async () => {
    await mount();
    const user = userEvent.setup();
    act(() => {
      openNewSession();
    });
    const view = await dialog();
    const recent = within(view).getByRole('list', { name: 'Recent projects' });
    const folders = within(recent)
      .getAllByRole('button')
      .map((button) => button.getAttribute('data-recent-project'));
    expect(folders).toEqual(['D:\\work\\parallax', 'D:\\old\\archived', 'D:\\work\\api']);
    await user.click(within(recent).getByRole('button', { name: /api/ }));
    expect(within(view).getByLabelText<HTMLInputElement>('Project folder').value).toBe('D:\\work\\api');
    expect(within(recent).getByRole('button', { name: /api/ }).getAttribute('aria-pressed')).toBe('true');
    // Typing filters them (fuzzy).
    await user.clear(within(view).getByLabelText('Project folder'));
    await user.type(within(view).getByLabelText('Project folder'), 'archi');
    expect(
      within(within(view).getByRole('list', { name: 'Recent projects' }))
        .getAllByRole('button')
        .map((button) => button.getAttribute('data-recent-project')),
    ).toEqual(['D:\\old\\archived']);
  });

  it('fills the folder from the folder browser exactly', async () => {
    await mount();
    const user = userEvent.setup();
    act(() => {
      openNewSession({ cwd: 'D:/WORK' });
    });
    const view = await dialog();
    await user.click(within(view).getByRole('button', { name: 'Browse…' }));
    const browser = await screen.findByRole('dialog', { name: 'Choose a folder' });
    const list = within(browser).getByRole('listbox');
    await waitFor(() => {
      expect(list.getAttribute('data-path')).toBe('D:/WORK');
    });
    await user.dblClick(within(list).getByRole('option', { name: /parallax/ }));
    await waitFor(() => {
      expect(list.getAttribute('data-path')).toBe('D:/WORK/parallax');
    });
    await user.click(within(browser).getByRole('button', { name: 'Choose this folder' }));
    await waitFor(() => {
      expect(screen.queryByRole('dialog', { name: 'Choose a folder' })).toBeNull();
    });
    expect(within(view).getByLabelText<HTMLInputElement>('Project folder').value).toBe('D:/WORK/parallax');
    // Only one submit button in the dialog (E2E: `button[type="submit"]`).
    expect(view.querySelectorAll('button[type="submit"]')).toHaveLength(1);
  });

  it('Esc in the folder browser closes only the browser', async () => {
    await mount();
    const user = userEvent.setup();
    act(() => {
      openNewSession({ cwd: 'D:\\work' });
    });
    const view = await dialog();
    const browse = within(view).getByRole('button', { name: 'Browse…' });
    await user.click(browse);
    const browser = await screen.findByRole('dialog', { name: 'Choose a folder' });
    await waitFor(() => {
      expect(within(browser).getByRole('listbox').getAttribute('data-path')).toBe('D:\\work');
    });
    await user.keyboard('{Escape}');
    await waitFor(() => {
      expect(screen.queryByRole('dialog', { name: 'Choose a folder' })).toBeNull();
    });
    expect(screen.getByRole('dialog', { name: 'New session' })).toBeTruthy();
    expect(within(view).getByLabelText<HTMLInputElement>('Project folder').value).toBe('D:\\work');
    await waitFor(() => {
      expect(document.activeElement).toBe(browse);
    });
  });

  it('Esc and the close button give the focus back to the opener (V3-04)', async () => {
    await mount();
    const user = userEvent.setup();
    render(
      <button type="button" onClick={openNewSession}>
        open dialog
      </button>,
    );
    const opener = screen.getByRole('button', { name: 'open dialog' });
    await user.click(opener);
    await dialog();
    await user.keyboard('{Escape}');
    await waitFor(() => {
      expect(screen.queryByRole('dialog')).toBeNull();
    });
    await waitFor(() => {
      expect(document.activeElement).toBe(opener);
    });
    await user.click(opener);
    const view = await dialog();
    await user.click(within(view).getByRole('button', { name: 'Close' }));
    await waitFor(() => {
      expect(document.activeElement).toBe(opener);
    });
  });

  it('rejects unsafe paths before sending and shows server errors translated', async () => {
    const running = await mount({ failCreate: true });
    const user = userEvent.setup();
    act(() => {
      openNewSession({ cwd: '\\\\server\\share' });
    });
    const view = await dialog();
    await user.click(within(view).getByRole('button', { name: 'Create session' }));
    expect(await within(view).findByText(/This path cannot be used/)).toBeTruthy();
    expect(running.commands('session.create')).toEqual([]);
    await user.clear(within(view).getByLabelText('Project folder'));
    await user.type(within(view).getByLabelText('Project folder'), 'D:\\missing');
    await user.click(within(view).getByRole('button', { name: 'Create session' }));
    expect(await within(view).findByText('The folder does not exist.')).toBeTruthy();
    expect(screen.getByRole('dialog', { name: 'New session' })).toBeTruthy();
  });

  it('speaks German', async () => {
    await mount();
    act(() => {
      setLanguage('de');
      openNewSession({ cwd: 'D:\\work', profileId: BROKEN });
    });
    const view = await screen.findByRole('dialog', { name: 'Neue Session' });
    expect(within(view).getByLabelText('Projektordner')).toBeTruthy();
    expect(within(view).getByText('Mit diesem Profil lassen sich keine Sessions starten:')).toBeTruthy();
    expect(within(view).getByRole('button', { name: 'Session anlegen' })).toBeTruthy();
    expect(within(view).getByRole('button', { name: 'Durchsuchen…' })).toBeTruthy();
  });
});
