/**
 * WP-70 sign in from Parallax in the web: the "Sign in" button (start chunk – hidden once the
 * profile signed in after the error), the shell request `login` and the lazy, non-modal sign-in
 * dialog against the FakeHost (memory transport): waiting with "Open link again"/"Copy link"/code
 * field, the pasted code signs in ("Signed in (Max)"), a refused code is the error in the dialog,
 * "Cancel" ends the sign-in. German texts; the lazy namespace mirrors English.
 */
import { act, cleanup, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { STANDARD_PROFILE_ID } from '@shared/common';
import { makeError } from '@shared/errors';
import { IDLE_PROFILE_LOGIN } from '@shared/model';
import { sampleClaudeInstallStatus, sampleProfileSummary, SAMPLE_TIME } from '@shared/samples';
import { setLanguage } from '@web/i18n';
import { startScenario, type RunningScenario } from '@web/playground/PlaygroundScenario';
import { FAKE_LOGIN_URL } from '@web/state/fake-host';
import { resetClientStore } from '@web/state/store';
import { TooltipProvider } from '@web/ui/tooltip';
import { NavigationLayer } from '../navigation/NavigationLayer';
import { registerShellRequestHandler, type ShellRequestOf } from '../requests';
import { de } from './i18n/de';
import { en } from './i18n/en';
import { LoginButton, needsSignIn } from './LoginButton';

vi.setConfig({ testTimeout: 30_000 });

let running: RunningScenario | null = null;
const cleanups: (() => void)[] = [];

afterEach(() => {
  cleanup();
  act(() => {
    setLanguage('en');
  });
  running?.stop();
  running = null;
  for (const fn of cleanups.splice(0)) fn();
  resetClientStore();
});

function start(): RunningScenario {
  running = startScenario('overview');
  return running;
}

async function openDialog(): Promise<HTMLElement> {
  const user = userEvent.setup();
  render(
    <TooltipProvider>
      <NavigationLayer />
      <LoginButton profileId={STANDARD_PROFILE_ID} />
    </TooltipProvider>,
  );
  await user.click(await screen.findByRole('button', { name: 'Sign in' }));
  return screen.findByRole('dialog', { name: 'Sign in · Standard' });
}

describe('LoginButton (WP-70)', () => {
  it('needsSignIn: a running claude that is logged out or failed its auth check', () => {
    const status = sampleClaudeInstallStatus();
    expect(needsSignIn(status)).toBe(false);
    expect(needsSignIn({ ...status, auth: { ...status.auth, state: 'logged_out' } })).toBe(true);
    expect(needsSignIn({ ...status, auth: { ...status.auth, state: 'error' } })).toBe(true);
    expect(
      needsSignIn({ ...status, state: 'not_found', auth: { ...status.auth, state: 'logged_out' } }),
    ).toBe(false);
  });

  it('asks the shell for the sign-in (modal inside a dialog); gone once signed in after the error', async () => {
    const scenario = start();
    const requests: ShellRequestOf<'login'>[] = [];
    cleanups.push(
      registerShellRequestHandler('login', (request) => {
        requests.push(request);
        return true;
      }),
    );
    const user = userEvent.setup();
    render(
      <>
        <LoginButton profileId={STANDARD_PROFILE_ID} since={SAMPLE_TIME} />
        <div role="dialog" aria-label="Outer">
          <LoginButton profileId={STANDARD_PROFILE_ID} />
        </div>
      </>,
    );
    const [atError] = await screen.findAllByRole('button', { name: 'Sign in' });
    if (atError === undefined) throw new Error('no button at the error');
    await user.click(atError);
    await user.click(
      within(screen.getByRole('dialog', { name: 'Outer' })).getByRole('button', { name: 'Sign in' }),
    );
    expect(requests).toEqual([
      { kind: 'login', profileId: STANDARD_PROFILE_ID, hostId: undefined, modal: false },
      { kind: 'login', profileId: STANDARD_PROFILE_ID, hostId: undefined, modal: true },
    ]);
    // Signed in after the error: the button at the error goes, the other one stays.
    const later = new Date(Date.parse(SAMPLE_TIME) + 60_000).toISOString();
    act(() => {
      scenario.host.patchLogin(STANDARD_PROFILE_ID, {
        ...IDLE_PROFILE_LOGIN,
        state: 'done',
        subscriptionType: 'max',
        at: later,
      });
    });
    await waitFor(() => {
      expect(screen.getAllByRole('button', { name: 'Sign in' })).toHaveLength(1);
    });
  });
});

describe('sign-in dialog (WP-70)', () => {
  it('starts the sign-in, waits with link and code field; the pasted code signs in', async () => {
    const scenario = start();
    const dialog = await openDialog();
    // Non-modal: no overlay, the window stays usable.
    expect(document.querySelector('[data-slot="dialog-overlay"]')).toBeNull();
    await waitFor(() => {
      expect(dialog.dataset.loginState).toBe('waiting');
    });
    expect(scenario.host.commands.filter((c) => c.name === 'profile.login')).toHaveLength(1);
    expect(scenario.host.linkOpens).toEqual([FAKE_LOGIN_URL]);
    expect(within(dialog).getByText(/open in your browser/)).toBeTruthy();
    const user = userEvent.setup();
    const field = within(dialog).getByRole('textbox', { name: 'Paste code' });
    expect(field.getAttribute('aria-describedby')).toBeTruthy();
    await user.type(field, '  c0de#fake-state  ');
    await user.click(within(dialog).getByRole('button', { name: 'Sign in' }));
    await waitFor(() => {
      expect(dialog.dataset.loginState).toBe('done');
    });
    expect(scenario.host.commands).toContainEqual({
      name: 'profile.loginCode',
      profileId: STANDARD_PROFILE_ID,
      code: 'c0de#fake-state',
    });
    expect(within(dialog).getByText('Signed in (Max)')).toBeTruthy();
    const close = dialog.querySelector<HTMLElement>('[data-action="login-close"]');
    if (close === null) throw new Error('no close button');
    expect(close.textContent).toBe('Close');
    await user.click(close);
    await waitFor(() => {
      expect(screen.queryByRole('dialog')).toBeNull();
    });
  });

  it('a refused code is the error in the dialog (role alert); "Try again" starts anew', async () => {
    const scenario = start();
    scenario.host.loginResult = makeError('LOGIN_FAILED', { reason: 'code' });
    const dialog = await openDialog();
    await waitFor(() => {
      expect(dialog.dataset.loginState).toBe('waiting');
    });
    const user = userEvent.setup();
    await user.type(within(dialog).getByRole('textbox', { name: 'Paste code' }), 'wrong');
    await user.click(within(dialog).getByRole('button', { name: 'Sign in' }));
    const alert = await within(dialog).findByRole('alert');
    expect(alert.textContent).toContain('The sign-in did not work');
    expect(alert.textContent).toContain('did not finish');
    scenario.host.loginResult = null;
    await user.click(within(dialog).getByRole('button', { name: 'Try again' }));
    await waitFor(() => {
      expect(dialog.dataset.loginState).toBe('waiting');
    });
    expect(scenario.host.commands.filter((c) => c.name === 'profile.login')).toHaveLength(2);
  });

  it('"Cancel" ends the sign-in; a refused command shows in the dialog', async () => {
    const scenario = start();
    const dialog = await openDialog();
    await waitFor(() => {
      expect(dialog.dataset.loginState).toBe('waiting');
    });
    const user = userEvent.setup();
    scenario.host.failNext('profile.loginCode', makeError('VALIDATION_FAILED', { field: 'code' }));
    await user.type(within(dialog).getByRole('textbox', { name: 'Paste code' }), 'x y');
    await user.click(within(dialog).getByRole('button', { name: 'Sign in' }));
    expect((await within(dialog).findByRole('alert')).textContent).toContain('Parallax could not do this');
    await user.click(within(dialog).getByRole('button', { name: 'Cancel' }));
    await waitFor(() => {
      expect(screen.queryByRole('dialog')).toBeNull();
    });
    expect(scenario.host.commands.at(-1)).toEqual({
      name: 'profile.loginCancel',
      profileId: STANDARD_PROFILE_ID,
    });
    expect(scenario.host.hostState.profiles[0]?.login.state).toBe('idle');
  });

  it('German texts; an earlier "signed in" is never shown as the new result', async () => {
    const scenario = start();
    act(() => {
      setLanguage('de');
      scenario.host.patchLogin(STANDARD_PROFILE_ID, {
        ...IDLE_PROFILE_LOGIN,
        state: 'done',
        subscriptionType: 'pro',
        at: SAMPLE_TIME,
      });
    });
    const user = userEvent.setup();
    render(
      <TooltipProvider>
        <NavigationLayer />
        <LoginButton profileId={STANDARD_PROFILE_ID} />
      </TooltipProvider>,
    );
    await user.click(await screen.findByRole('button', { name: 'Anmelden' }));
    const dialog = await screen.findByRole('dialog', { name: 'Anmelden · Standard' });
    expect(['starting', 'waiting']).toContain(dialog.dataset.loginState);
    expect(within(dialog).queryByText('Angemeldet (Pro)')).toBeNull();
    await waitFor(() => {
      expect(dialog.dataset.loginState).toBe('waiting');
    });
    expect(within(dialog).getByText('Anmeldung im Browser geöffnet – warte auf Abschluss…')).toBeTruthy();
    expect(within(dialog).getByRole('button', { name: 'Link erneut öffnen' })).toBeTruthy();
    expect(within(dialog).getByRole('button', { name: 'Link kopieren' })).toBeTruthy();
  });
});

describe('lazy namespace of the sign-in dialog (WP-70)', () => {
  it('German has the keys and placeholders of English; nothing is empty', () => {
    expect(Object.keys(de).sort()).toEqual(Object.keys(en).sort());
    for (const key of Object.keys(en) as (keyof typeof en)[]) {
      expect(de[key].trim(), key).not.toBe('');
      expect(
        [...de[key].matchAll(/\{(\w+)\}/g)].map((m) => m[1]),
        key,
      ).toEqual([...en[key].matchAll(/\{(\w+)\}/g)].map((m) => m[1]));
    }
  });

  it('a profile summary without a login field gets the idle state (schema default)', () => {
    expect(sampleProfileSummary().login).toEqual(IDLE_PROFILE_LOGIN);
  });
});
