import { act, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { STANDARD_PROFILE_ID } from '@shared/common';
import { sampleClaudeInstallStatus } from '@shared/samples';
import { setLanguage } from '@web/i18n';
import { resetClientStore } from '@web/state/store';
import { TooltipProvider } from '@web/ui/tooltip';
import type { ProfileSelection } from './components/ProfileList';
import { DEMO_PROFILE_IDS, demoProfiles, startProfilesDemo, type ProfilesDemo } from './lib/demo-host';
import { ProfilesSettings } from './ProfilesSettings';

// A long form with live checks (400 ms debounce): seconds in a full `pnpm test`, more under parallel
// load (docs/wp/FLAKES.md). Waits are conditions, never fixed sleeps.
vi.setConfig({ testTimeout: 60_000 });

let demo: ProfilesDemo | null = null;

afterEach(() => {
  demo?.stop();
  demo = null;
  resetClientStore();
  act(() => {
    setLanguage('en');
  });
});

async function mount(selection?: ProfileSelection, options: Parameters<typeof startProfilesDemo>[0] = {}) {
  demo = startProfilesDemo({ immediate: true, ...options });
  const running = demo;
  render(
    <TooltipProvider>
      <ProfilesSettings initialSelection={selection} />
    </TooltipProvider>,
  );
  await screen.findByRole('list', { name: 'Profiles' });
  return { running, user: userEvent.setup() };
}

/** The editor form of a saved profile, or `'new'` for the draft of a new one. */
async function editor(profileId: string): Promise<HTMLElement> {
  return waitFor(() => {
    const form = document.querySelector<HTMLElement>(
      `[data-slot="profile-editor"][data-profile-id="${profileId}"]`,
    );
    if (form === null) throw new Error(`editor of ${profileId} not shown`);
    return form;
  });
}

function argRow(form: HTMLElement, index: number): HTMLElement {
  const row = form.querySelectorAll<HTMLElement>('[data-arg-row]')[index];
  if (row === undefined) throw new Error(`argument row ${String(index)} missing`);
  return row;
}

const work = DEMO_PROFILE_IDS.work;

describe('ProfilesSettings – list', () => {
  it('lists every profile with color, name, default, Claude Code state, sessions and findings', async () => {
    await mount();
    const list = screen.getByRole('list', { name: 'Profiles' });
    const rows = within(list).getAllByRole('button');
    expect(rows.map((row) => row.getAttribute('data-profile-row'))).toEqual(demoProfiles().map((p) => p.id));
    const standard = within(list).getByRole('button', { name: /^Standard/ });
    expect(standard.textContent).toContain('Default');
    expect(standard.textContent).toContain('Built-in');
    expect(standard.textContent).toContain('3 sessions');
    expect(standard.textContent).toContain('Claude Code 2.1.300 · max');
    const broken = within(list).getByRole('button', { name: /^Broken/ });
    // `--resume` (blocked) and the missing executable.
    expect(broken.textContent).toContain('2 errors');
    // The default profile is opened first.
    expect(standard.getAttribute('aria-current')).toBe('true');
    await editor(STANDARD_PROFILE_ID);
  });
});

describe('ProfilesSettings – editor', () => {
  it('masks secret values with an eye button per row; other values stay visible', async () => {
    const { user } = await mount({ kind: 'profile', id: work });
    const form = await editor(work);
    const value = (index: number) =>
      within(form).getByLabelText<HTMLInputElement>(`Value of variable ${String(index)}`);
    // ANTHROPIC_API_KEY, HTTPS_PROXY, GITHUB_TOKEN
    expect(value(1).type).toBe('password');
    expect(value(1).autocomplete).toBe('new-password');
    expect(value(2).type).toBe('text');
    expect(value(3).type).toBe('password');
    const eye = within(form).getByRole('button', { name: 'Show the value of variable 1' });
    expect(eye.getAttribute('aria-pressed')).toBe('false');
    await user.click(eye);
    expect(value(1).type).toBe('text');
    expect(value(1).value).toBe('sk-demo-not-a-real-key');
    expect(eye.getAttribute('aria-pressed')).toBe('true');
    expect(value(3).type).toBe('password');
    // Renaming a key to a secret name masks it.
    await user.clear(within(form).getByLabelText('Name of variable 2'));
    await user.type(within(form).getByLabelText('Name of variable 2'), 'PROXY_PASSWORD');
    expect(value(2).type).toBe('password');
    // No secret value in the visible text.
    expect(document.body.textContent).not.toContain('ghp_demo_value');
  });

  it('shows findings at their line, marks bypass red and blocks saving on errors', async () => {
    const { user, running } = await mount({ kind: 'profile', id: DEMO_PROFILE_IDS.gateway });
    const form = await editor(DEMO_PROFILE_IDS.gateway);
    const bypass = argRow(form, 0);
    expect(bypass.getAttribute('data-bypass')).toBe('true');
    expect(within(bypass).getByText('Bypass')).toBeTruthy();
    expect(within(bypass).getByLabelText('Argument 1').className).toContain('text-destructive');
    expect(bypass.textContent).toContain(
      '--dangerously-skip-permissions lets Claude Code act without asking',
    );
    expect(argRow(form, 1).textContent).toContain('--verbose is passed to Claude Code unchecked.');
    const missing = argRow(form, 2);
    expect(missing.getAttribute('data-invalid')).toBe('true');
    expect(missing.textContent).toContain('--add-dir needs a value');
    expect(within(missing).getByLabelText('Argument 3').getAttribute('aria-invalid')).toBe('true');
    // The env reference that this machine does not resolve – on its variable.
    expect(form.textContent).toContain(
      'The variable GATEWAY_TOKEN (used in ANTHROPIC_AUTH_TOKEN) is not set',
    );
    // Bypass is allowed here, so the mode menu offers it (red).
    await user.click(within(form).getByRole('button', { name: /^Permission mode/ }));
    const menu = await screen.findByRole('menu');
    expect(within(menu).getByRole('menuitemradio', { name: /Bypass permissions/ }).className).toContain(
      'text-destructive',
    );
    await user.keyboard('{Escape}');
    expect(within(form).getByRole('button', { name: 'Save' })).toHaveProperty('disabled', true);
    expect(within(form).getByText('A profile with errors cannot be saved – fix them first.')).toBeTruthy();
    // Fixing the line (live check after 400 ms) unblocks saving. Under load typing is slower than the
    // debounce, so a check may run mid-word: wait for the check of the whole value (V3-08).
    await user.type(within(form).getByLabelText('Argument 3'), '{Enter}D:\\shared');
    await waitFor(() => {
      expect(running.commands('profile.validate').at(-1)?.profile.args).toEqual([
        '--dangerously-skip-permissions',
        '--verbose',
        '--add-dir',
        'D:\\shared',
      ]);
      expect(within(form).getByRole('button', { name: 'Save' })).toHaveProperty('disabled', false);
    });
    await user.click(within(form).getByRole('button', { name: 'Save' }));
    expect(await screen.findByText('Profile “Gateway” saved.')).toBeTruthy();
    expect(running.server.profiles.find((p) => p.id === DEMO_PROFILE_IDS.gateway)?.args).toHaveLength(4);
  });

  it('warns before changing the config folder of a profile in use', async () => {
    const { user } = await mount({ kind: 'profile', id: work });
    const form = await editor(work);
    const field = within(form).getByLabelText<HTMLInputElement>('Config folder (CLAUDE_CONFIG_DIR)');
    expect(form.querySelector('[data-slot="config-dir-warning"]')).toBeNull();
    await user.type(field, '2');
    expect(
      within(form).getByText(/2 sessions use this profile\. With a different config folder/),
    ).toBeTruthy();
    // Only the case changed: the same folder on Windows – no warning.
    await user.clear(field);
    await user.type(field, 'c:\\users\\USER\\.claude-work');
    expect(form.querySelector('[data-slot="config-dir-warning"]')).toBeNull();
  });

  it('picks the config folder with the folder browser', async () => {
    const { user } = await mount({ kind: 'profile', id: work });
    const form = await editor(work);
    await user.click(within(form).getByRole('button', { name: 'Browse…' }));
    const browser = await screen.findByRole('dialog', { name: 'Choose a folder' });
    const list = within(browser).getByRole('listbox');
    await waitFor(() => {
      expect(list.getAttribute('data-path')).toBe('C:\\Users\\user\\.claude-work');
    });
    await user.keyboard('{Backspace}');
    await waitFor(() => {
      expect(list.getAttribute('data-path')).toBe('C:\\Users\\user');
    });
    await user.click(within(browser).getByRole('switch', { name: 'Show hidden folders' }));
    await user.dblClick(await within(list).findByRole('option', { name: /^\.claude Hidden/ }));
    await waitFor(() => {
      expect(list.getAttribute('data-path')).toBe('C:\\Users\\user\\.claude');
    });
    await user.click(within(browser).getByRole('button', { name: 'Choose this folder' }));
    await waitFor(() => {
      expect(within(form).getByLabelText<HTMLInputElement>('Config folder (CLAUDE_CONFIG_DIR)').value).toBe(
        'C:\\Users\\user\\.claude',
      );
    });
    expect(form.querySelector('[data-slot="config-dir-warning"]')).not.toBeNull();
  });

  it('cannot delete the built-in profile or one in use – the reason is visible', async () => {
    const { user } = await mount();
    const standard = await editor(STANDARD_PROFILE_ID);
    expect(within(standard).getByRole('button', { name: /Delete/ })).toHaveProperty('disabled', true);
    expect(within(standard).getByText('The built-in profile cannot be deleted.')).toBeTruthy();
    await user.click(screen.getByRole('button', { name: /^Work/ }));
    const form = await editor(work);
    const remove = within(form).getByRole('button', { name: /Delete/ });
    expect(remove).toHaveProperty('disabled', true);
    expect(remove.getAttribute('aria-describedby')).not.toBeNull();
    expect(
      within(form).getByText('Cannot be deleted: 2 sessions use this profile (archived ones count too).'),
    ).toBeTruthy();
  });

  it('deletes an unused profile after asking', async () => {
    const { user, running } = await mount({ kind: 'profile', id: DEMO_PROFILE_IDS.gateway });
    const form = await editor(DEMO_PROFILE_IDS.gateway);
    const remove = within(form).getByRole('button', { name: 'Delete…' });
    await user.click(remove);
    const confirm = within(form).getByRole('button', { name: 'Delete profile' });
    // R4W-24: "Cancel" has the focus – Enter again deletes nothing; Cancel returns to "Delete…".
    expect(document.activeElement).toBe(within(form).getByRole('button', { name: 'Cancel' }));
    await user.keyboard('{Enter}');
    expect(within(form).queryByRole('button', { name: 'Delete profile' })).toBeNull();
    expect(document.activeElement).toBe(remove);
    expect(running.commands('profile.delete')).toEqual([]);
    await user.click(remove);
    await user.click(within(form).getByRole('button', { name: 'Delete profile' }));
    const notice = await screen.findByText('Profile “Gateway” deleted.');
    // V3-14: the focus goes to the notice, not to <body>.
    await waitFor(() => {
      expect(document.activeElement).toBe(notice.closest('[data-slot="profile-notice"]'));
    });
    expect(confirm.isConnected).toBe(false);
    expect(running.commands('profile.delete')).toEqual([
      { name: 'profile.delete', profileId: DEMO_PROFILE_IDS.gateway },
    ]);
    await waitFor(() => {
      expect(screen.queryByRole('button', { name: /^Gateway/ })).toBeNull();
    });
    await editor(STANDARD_PROFILE_ID);
  });

  it('tests a profile and shows version, sign-in and plan', async () => {
    const { user, running } = await mount(
      { kind: 'profile', id: work },
      {
        server: {
          profiles: demoProfiles(),
          entryCounts: { [work]: 2 },
          testResults: {
            [work]: sampleClaudeInstallStatus({
              version: '2.1.310',
              auth: {
                state: 'logged_in',
                method: 'claude.ai',
                apiProvider: 'firstParty',
                subscriptionType: 'team',
              },
            }),
          },
        },
      },
    );
    const form = await editor(work);
    const scrollIntoView = vi.spyOn(Element.prototype, 'scrollIntoView');
    await user.click(within(form).getByRole('button', { name: 'Test profile' }));
    const panel = await waitFor(() => {
      const element = form.querySelector<HTMLElement>('[data-slot="profile-test-result"]');
      if (element === null) throw new Error('no test result');
      return element;
    });
    // V3-14: the result below the fold is scrolled into view.
    await waitFor(() => {
      expect(
        scrollIntoView.mock.contexts.some((element) => element instanceof Element && element.contains(panel)),
      ).toBe(true);
    });
    expect(scrollIntoView).toHaveBeenCalledWith({ block: 'nearest' });
    scrollIntoView.mockRestore();
    expect(running.commands('profile.test')).toEqual([{ name: 'profile.test', profileId: work }]);
    expect(within(panel).getByText('2.1.310')).toBeTruthy();
    expect(within(panel).getByText('Signed in (claude.ai)')).toBeTruthy();
    expect(within(panel).getByText('team')).toBeTruthy();
  });

  it('makes a profile the default', async () => {
    const { user, running } = await mount({ kind: 'profile', id: work });
    const form = await editor(work);
    await user.click(within(form).getByRole('button', { name: 'Make default' }));
    expect(await screen.findByText('“Work” is now the default profile for new sessions.')).toBeTruthy();
    expect(running.commands('profile.setDefault')).toEqual([{ name: 'profile.setDefault', profileId: work }]);
    await waitFor(() => {
      expect(within(form).getByRole('button', { name: 'Default profile' })).toHaveProperty('disabled', true);
    });
  });

  it('creates a new profile (no id, env and arguments as typed)', async () => {
    const { user, running } = await mount();
    await editor(STANDARD_PROFILE_ID);
    await user.click(screen.getByRole('button', { name: 'New profile' }));
    const form = await editor('new');
    await user.click(within(form).getByRole('button', { name: 'Save' }));
    expect(within(form).getByText('Enter a name.')).toBeTruthy();
    expect(running.commands('profile.save')).toEqual([]);
    await user.type(within(form).getByLabelText('Name'), 'Private');
    await user.click(within(form).getByRole('radio', { name: 'Teal' }));
    await user.click(within(form).getByRole('button', { name: 'Add variable' }));
    await user.type(within(form).getByLabelText('Name of variable 1'), 'MY_TOKEN');
    await user.type(within(form).getByLabelText('Value of variable 1'), 'abc');
    expect(within(form).getByLabelText<HTMLInputElement>('Value of variable 1').type).toBe('password');
    await user.click(within(form).getByRole('button', { name: 'Add argument' }));
    await user.type(within(form).getByLabelText('Argument 1'), '--add-dir{Enter}D:\\shared');
    await user.click(within(form).getByRole('button', { name: 'Save' }));
    const saved = await screen.findByText('Profile “Private” saved.');
    // V3-14: the editor is shown anew – the focus goes to the notice, not to <body>.
    await waitFor(() => {
      expect(document.activeElement).toBe(saved.closest('[data-slot="profile-notice"]'));
    });
    expect(running.commands('profile.save')).toEqual([
      {
        name: 'profile.save',
        profile: {
          name: 'Private',
          color: 'teal',
          executable: { kind: 'auto' },
          configDir: null,
          env: { MY_TOKEN: 'abc' },
          contextWindow: null,
          args: ['--add-dir', 'D:\\shared'],
          passRawArgs: false,
          defaults: { model: null, permissionMode: null, effort: null },
        },
      },
    ]);
    const stored = running.server.profiles.at(-1);
    expect(stored?.name).toBe('Private');
    await editor(stored?.id ?? 'missing');
  });

  it('asks before leaving unsaved changes', async () => {
    const { user } = await mount({ kind: 'profile', id: work });
    const form = await editor(work);
    await user.type(within(form).getByLabelText('Name'), ' 2');
    expect(within(form).getByText('Unsaved changes')).toBeTruthy();
    await user.click(screen.getByRole('button', { name: /^Standard/ }));
    expect(screen.getByText('Discard the unsaved changes of this profile?')).toBeTruthy();
    // R4W-24: the harmless choice has the focus.
    expect(document.activeElement).toBe(screen.getByRole('button', { name: 'Keep editing' }));
    await user.click(screen.getByRole('button', { name: 'Keep editing' }));
    expect(within(form).getByLabelText<HTMLInputElement>('Name').value).toBe('Work 2');
    // The question is gone: the focus is on the profile being edited, not on <body>.
    await waitFor(() => {
      expect(document.activeElement).toBe(screen.getByRole('button', { name: /^Work/ }));
    });
    await user.click(screen.getByRole('button', { name: /^Standard/ }));
    await user.click(screen.getByRole('button', { name: 'Discard changes' }));
    await editor(STANDARD_PROFILE_ID);
    await waitFor(() => {
      expect(document.activeElement).toBe(screen.getByRole('button', { name: /^Standard/ }));
    });
  });

  it('an untouched new profile has nothing to lose: switching away does not ask', async () => {
    demo = startProfilesDemo({ immediate: true });
    const onDirtyChange = vi.fn();
    render(
      <TooltipProvider>
        <ProfilesSettings initialSelection={{ kind: 'new' }} onDirtyChange={onDirtyChange} />
      </TooltipProvider>,
    );
    const user = userEvent.setup();
    const form = await editor('new');
    // Saving is still offered (a new profile), but nothing is unsaved yet.
    expect(within(form).getByRole('button', { name: 'Save' })).toHaveProperty('disabled', false);
    expect(onDirtyChange).toHaveBeenLastCalledWith(false);
    await user.click(screen.getByRole('button', { name: /^Work/ }));
    expect(screen.queryByText('Discard the unsaved changes of this profile?')).toBeNull();
    await editor(work);
  });

  it('labels: color and program name their groups; no <label> without a field (V3-12)', async () => {
    await mount({ kind: 'profile', id: work });
    const form = await editor(work);
    for (const text of ['Color', 'Program']) {
      const label = within(form).getByText(text, { selector: 'span' });
      expect(within(form).getByRole('radiogroup', { name: text }).getAttribute('aria-labelledby')).toBe(label.id);
    }
    for (const label of form.querySelectorAll('label')) {
      const target = label.getAttribute('for');
      expect(target === null || document.getElementById(target) !== null, label.textContent).toBe(true);
    }
  });

  it('reports unsaved changes to the settings page (slot prop onDirtyChange, R4W-01)', async () => {
    demo = startProfilesDemo({ immediate: true });
    const onDirtyChange = vi.fn();
    render(
      <TooltipProvider>
        <ProfilesSettings initialSelection={{ kind: 'profile', id: work }} onDirtyChange={onDirtyChange} />
      </TooltipProvider>,
    );
    const user = userEvent.setup();
    const form = await editor(work);
    expect(onDirtyChange).toHaveBeenLastCalledWith(false);
    await user.type(within(form).getByLabelText('Name'), ' 2');
    expect(onDirtyChange).toHaveBeenLastCalledWith(true);
  });

  it('speaks German', async () => {
    act(() => {
      setLanguage('de');
    });
    demo = startProfilesDemo({ immediate: true });
    render(
      <TooltipProvider>
        <ProfilesSettings initialSelection={{ kind: 'profile', id: work }} />
      </TooltipProvider>,
    );
    const form = await editor(work);
    expect(within(form).getByLabelText('Konfigurationsordner (CLAUDE_CONFIG_DIR)')).toBeTruthy();
    expect(within(form).getByLabelText('Kontextfenster (Tokens)')).toBeTruthy();
    expect(within(form).getByRole('button', { name: 'Wert der Variable 1 anzeigen' })).toBeTruthy();
    // V3-13: the default badge differs from the name of the built-in profile „Standard“.
    expect(screen.getByRole('button', { name: /^Standard/ }).textContent).toContain('Standardprofil');
    expect(
      within(form).getByText('Nicht löschbar: 2 Sessions nutzen dieses Profil (archivierte zählen mit).'),
    ).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Neues Profil' })).toBeTruthy();
  });
});
