import { act, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { makeError } from '@shared/errors';
import { PAIRING_WINDOW_MS, parsePairingCode } from '@shared/pairing';
import { startScenario, type RunningScenario } from '@web/playground/PlaygroundScenario';
import { useHostState } from '@web/state/hooks';
import { resetClientStore } from '@web/state/store';
import { TooltipProvider } from '@web/ui/tooltip';
import { SettingsPage } from '../SettingsPage';
import { MultiHostCommandsProvider } from './multi-host/commands';
import { createFakeMultiHost, type FakeMultiHost } from './multi-host/fake-commands';
import { multiHostVariant, type MultiHostVariant } from './multi-host/MultiHostDemo';
import { MultiHostSection } from './MultiHostSection';

vi.setConfig({ testTimeout: 60_000 });

let running: RunningScenario | null = null;

afterEach(() => {
  running?.stop();
  running = null;
  resetClientStore();
});

function Section() {
  const hostState = useHostState();
  return <MultiHostSection hostState={hostState} />;
}

/** The section over the FakeHost; its commands answer through the fake sharing computer. */
async function start(
  variant: MultiHostVariant,
  options: { now?: () => number; real?: boolean } = {},
): Promise<{ scenario: RunningScenario; fake: FakeMultiHost }> {
  running = startScenario('empty', { select: null });
  const scenario = running;
  scenario.host.setHostState(multiHostVariant(scenario.host.hostState, variant));
  const fake = createFakeMultiHost(scenario.host, options.now === undefined ? {} : { now: options.now });
  render(
    <TooltipProvider>
      {options.real === true ? (
        <Section />
      ) : (
        <MultiHostCommandsProvider value={fake.commands}>
          <Section />
        </MultiHostCommandsProvider>
      )}
    </TooltipProvider>,
  );
  await waitFor(() => {
    expect(screen.getByRole('radio', { name: 'Off' }).hasAttribute('disabled')).toBe(false);
  });
  return { scenario, fake };
}

function part(name: string): HTMLElement {
  const found = document.querySelector<HTMLElement>(`[data-part="${name}"]`);
  if (found === null) throw new Error(`part ${name} missing`);
  return found;
}

describe('settings section "Several computers" (WP-78b)', () => {
  it('switches the role with multiHost.configure and shows the part of the role', async () => {
    const user = userEvent.setup();
    const { fake } = await start('off');
    expect(screen.getAllByRole('radio').map((radio) => radio.getAttribute('value'))).toEqual([
      'off',
      'share',
      'control',
    ]);
    expect(screen.getByRole('radio', { name: 'Off' }).getAttribute('aria-checked')).toBe('true');
    expect(document.querySelector('[data-slot="multi-host-off"]')).not.toBeNull();

    await user.click(screen.getByRole('radio', { name: 'Share' }));
    // The log loads at once; its rejected attempts count as seen.
    await waitFor(() => {
      expect(fake.calls).toEqual(['configure:{"role":"share"}', 'events:false', 'eventsSeen']);
    });
    expect(await screen.findByText('Reachable')).toBeTruthy();
    expect(screen.getByText('Listening on port 4713.')).toBeTruthy();
    expect(screen.getByText('Computer name: COMPUTER-B')).toBeTruthy();
    // Nothing coupled yet: the hint says the Windows Firewall is the user's to set up.
    expect(document.querySelector('[data-slot="firewall-hint"]')).not.toBeNull();
    expect(within(screen.getByRole('list', { name: 'Checks' })).getAllByRole('listitem')).toHaveLength(5);

    await user.click(screen.getByRole('radio', { name: 'Control others' }));
    expect(fake.calls).toContain('configure:{"role":"control"}');
    expect(document.querySelector('[data-slot="multi-host-control"]')?.textContent).toContain(
      'sharing computers in the same network',
    );
  });

  it('a role conflict shows an alert and offers to remove the pairing first', async () => {
    const user = userEvent.setup();
    const { fake } = await start('paired');
    await user.click(screen.getByRole('radio', { name: 'Control others' }));
    const alert = await screen.findByRole('alert');
    expect(alert.textContent).toContain('The role was not changed.');
    expect(alert.textContent).toContain('Remove the pairing first');
    expect(screen.getByRole('radio', { name: 'Share' }).getAttribute('aria-checked')).toBe('true');

    await user.click(within(alert).getByRole('button', { name: 'Remove pairing…' }));
    const confirm = document.querySelector<HTMLElement>('[data-slot="peer-confirm"]');
    expect(confirm?.textContent).toContain('Remove the pairing with Computer A?');
    expect(fake.calls).not.toContain('unpair');
    await user.click(within(confirm ?? document.body).getByRole('button', { name: 'Remove pairing' }));
    await waitFor(() => {
      expect(fake.calls).toContain('unpair');
    });
    expect(await screen.findByText('No computer is paired yet.')).toBeTruthy();

    await user.click(screen.getByRole('radio', { name: 'Control others' }));
    await waitFor(() => {
      expect(screen.getByRole('radio', { name: 'Control others' }).getAttribute('aria-checked')).toBe('true');
    });
  });

  it('pairing shows the code in 7 groups with countdown, computer name, address and port; cancel closes it', async () => {
    const user = userEvent.setup();
    const { fake } = await start('share');
    await user.click(screen.getByRole('button', { name: 'Pair a computer' }));
    const card = await screen.findByRole('group', { name: 'Pairing code' });
    const groups = [...card.querySelectorAll('[data-slot="pairing-code-group"]')].map(
      (group) => group.textContent,
    );
    expect(groups).toHaveLength(7);
    const code = groups.join('-');
    expect(parsePairingCode(code)).not.toBeNull();
    expect(within(card).getByRole('timer').textContent).toMatch(/^Valid for (10:00|9:5\d)$/);
    expect(within(card).getByText('The pairing code is valid for 10 more minutes.')).toBeTruthy();
    expect(card.querySelector('[data-slot="pairing-host-name"]')?.textContent).toBe('COMPUTER-B');
    expect(card.querySelector('[data-slot="pairing-addresses"]')?.textContent).toBe('192.0.2.20');
    expect(card.querySelector('[data-slot="pairing-port"]')?.textContent).toBe('4713');
    // The code never reaches the store (only this component has it).
    expect(JSON.stringify(running?.host.hostState)).not.toContain(code);

    await user.click(within(card).getByRole('button', { name: 'Cancel pairing' }));
    expect(await screen.findByText('Pairing was cancelled.')).toBeTruthy();
    expect(screen.queryByRole('group', { name: 'Pairing code' })).toBeNull();
    expect(fake.calls).toContain('cancelPairing');
  });

  it('a successful pairing closes the window with "Paired with …"', async () => {
    const user = userEvent.setup();
    const { fake } = await start('share');
    await user.click(screen.getByRole('button', { name: 'Pair a computer' }));
    await screen.findByRole('group', { name: 'Pairing code' });
    act(() => {
      fake.completePairing('Computer A');
    });
    expect(await screen.findByText('Paired with Computer A.')).toBeTruthy();
    expect(screen.queryByRole('group', { name: 'Pairing code' })).toBeNull();
    expect(part('peer').querySelector('[data-slot="peer-name"]')?.textContent).toBe('Computer A');
    expect(part('peer').textContent).toContain('Connected (1 connection)');
  });

  it('an expired code goes away with a hint', async () => {
    const user = userEvent.setup();
    // The window ends 1.5 s after it opens.
    await start('share', { now: () => Date.now() - PAIRING_WINDOW_MS + 1500 });
    await user.click(screen.getByRole('button', { name: 'Pair a computer' }));
    await screen.findByRole('group', { name: 'Pairing code' });
    expect(await screen.findByText(/The code expired/, {}, { timeout: 5000 })).toBeTruthy();
    expect(screen.queryByRole('group', { name: 'Pairing code' })).toBeNull();
  });

  it('an existing pairing is replaced only after asking', async () => {
    const user = userEvent.setup();
    const { fake } = await start('paired');
    await user.click(screen.getByRole('button', { name: 'Pair a computer' }));
    const question = document.querySelector<HTMLElement>('[data-slot="pairing-replace-confirm"]');
    expect(question?.textContent).toContain('Replace the pairing with Computer A?');
    expect(fake.calls).not.toContain('pair');
    await user.click(screen.getByRole('button', { name: 'Keep the pairing' }));
    expect(document.querySelector('[data-slot="pairing-replace-confirm"]')).toBeNull();

    await user.click(screen.getByRole('button', { name: 'Pair a computer' }));
    await user.click(screen.getByRole('button', { name: 'Pair a new computer' }));
    expect(await screen.findByRole('group', { name: 'Pairing code' })).toBeTruthy();
    expect(fake.calls.filter((call) => call === 'pair')).toHaveLength(1);
  });

  it('a window opened in another window shows without a code (new code or cancel)', async () => {
    const user = userEvent.setup();
    const { scenario, fake } = await start('share');
    act(() => {
      const access = scenario.host.hostState.remoteAccess;
      if (access === null) throw new Error('no remote access');
      scenario.host.setHostState({
        ...scenario.host.hostState,
        remoteAccess: { ...access, pairingExpiresAt: new Date(Date.now() + 300_000).toISOString() },
      });
    });
    const notice = await waitFor(() => {
      const found = document.querySelector<HTMLElement>('[data-slot="pairing-elsewhere"]');
      expect(found).not.toBeNull();
      return found ?? document.body;
    });
    expect(notice.textContent).toContain('Its code was shown in another window.');
    await user.click(within(notice).getByRole('button', { name: 'Show a new code' }));
    expect(await screen.findByRole('group', { name: 'Pairing code' })).toBeTruthy();
    expect(fake.calls).toContain('pair');
  });

  it('the paired computer: details, remove pairing and renew key after asking', async () => {
    const user = userEvent.setup();
    const { fake } = await start('paired');
    const peer = part('peer');
    expect(peer.querySelector('[data-slot="peer-name"]')?.textContent).toBe('Computer A');
    expect(within(peer).getByText('Connected (2 connections)')).toBeTruthy();
    expect(within(peer).getByText('Paired since')).toBeTruthy();
    expect(within(peer).getByText('192.0.2.10')).toBeTruthy();

    await user.click(within(peer).getByRole('button', { name: 'Renew key…' }));
    const confirm = peer.querySelector<HTMLElement>('[data-slot="peer-confirm"]');
    expect(confirm?.textContent).toContain('also removes the pairing with Computer A');
    // The harmless choice has the focus.
    expect(document.activeElement?.textContent).toBe('Cancel');
    await user.click(within(confirm ?? peer).getByRole('button', { name: 'Cancel' }));
    expect(peer.querySelector('[data-slot="peer-confirm"]')).toBeNull();
    expect(fake.calls).not.toContain('renewKey');

    await user.click(within(peer).getByRole('button', { name: 'Renew key…' }));
    await user.click(within(peer).getByRole('button', { name: 'Renew key' }));
    expect(await within(peer).findByText('The key was renewed.')).toBeTruthy();
    expect(fake.calls).toContain('renewKey');
    expect(within(peer).getByText('No computer is paired yet.')).toBeTruthy();
  });

  it('a failed unpair shows the error in the panel', async () => {
    const user = userEvent.setup();
    const { fake } = await start('paired');
    fake.failNext('unpair', makeError('REMOTE_ROLE_CONFLICT', { role: 'off' }));
    const peer = part('peer');
    await user.click(within(peer).getByRole('button', { name: 'Remove pairing…' }));
    await user.click(within(peer).getByRole('button', { name: 'Remove pairing' }));
    const alert = await within(peer).findByRole('alert');
    expect(alert.textContent).toContain('The action failed.');
    expect(alert.textContent).toContain('Not possible in the current role of this computer.');
    expect(peer.querySelector('[data-slot="peer-name"]')?.textContent).toBe('Computer A');
  });

  it('"Check again" runs remoteAccess.check and updates the checks', async () => {
    const user = userEvent.setup();
    const { fake } = await start('errors');
    const status = part('status');
    expect(status.querySelector('[data-check="port"]')?.getAttribute('data-status')).toBe('error');
    await user.click(within(status).getByRole('button', { name: 'Check again' }));
    await waitFor(() => {
      expect(status.querySelector('[data-check="port"]')?.getAttribute('data-status')).toBe('ok');
    });
    expect(fake.calls).toContain('check');
    expect(status.querySelector('[data-check="firewall"]')).toBeNull();
  });

  it('shows a listener that could not start, failed checks and a computer with another version', async () => {
    await start('errors');
    const status = part('status');
    expect(within(status).getByText('Not reachable')).toBeTruthy();
    const alert = within(status).getAllByRole('alert')[0];
    expect(alert?.textContent).toContain('Remote access could not start.');
    expect(alert?.textContent).toContain('Another program uses port 4713.');
    expect(within(status).getByText('Another program uses the port.')).toBeTruthy();
    // A coupled computer connected before – no firewall hint any more.
    expect(document.querySelector('[data-slot="firewall-hint"]')).toBeNull();
    const peer = part('peer');
    expect(within(peer).getByText('Not connected')).toBeTruthy();
    expect(within(peer).getByText('Other Parallax version')).toBeTruthy();
    expect(peer.textContent).toContain('Parallax 9.9.9');
    // Without a listener there is nothing to pair with.
    expect(screen.getByRole('button', { name: 'Pair a computer' }).hasAttribute('disabled')).toBe(true);
  });

  it('port changes go through multiHost.configure; a failure falls back and says so', async () => {
    const user = userEvent.setup();
    const { fake } = await start('share');
    const listener = part('listener');
    const port = within(listener).getByRole('textbox', { name: 'Port' });
    await user.clear(port);
    await user.type(port, '4800{Enter}');
    await waitFor(() => {
      expect(fake.calls).toContain('configure:{"port":4800}');
    });
    expect((port as HTMLInputElement).value).toBe('4800');

    fake.failNext('configure', makeError('REMOTE_ACCESS_FAILED', { reason: 'port_in_use' }));
    await user.clear(port);
    await user.type(port, '4900{Enter}');
    const alert = await within(listener).findByRole('alert');
    expect(alert.textContent).toContain('The setting was not saved.');
    await waitFor(() => {
      expect((port as HTMLInputElement).value).toBe('4800');
    });

    // Out of range: no command, an error at the field.
    await user.clear(port);
    await user.type(port, '80{Enter}');
    expect(await within(listener).findByText('Enter a whole number from 1024 to 65535.')).toBeTruthy();
    expect(fake.calls.filter((call) => call.startsWith('configure:'))).toHaveLength(2);
  });

  it('the connection log: rows, unverified names, filter, marks seen and reloads on new rejections', async () => {
    const user = userEvent.setup();
    const { scenario, fake } = await start('paired');
    const log = part('log');
    const table = await within(log).findByRole('table');
    expect(within(table).getAllByRole('row')).toHaveLength(6);
    expect(
      within(table)
        .getAllByRole('columnheader')
        .map((cell) => cell.textContent),
    ).toEqual(['Time', 'IP address', 'Event', 'Count', 'Name']);
    const failed = table.querySelector<HTMLElement>('tr[data-event="pair_failed"]');
    expect(failed?.textContent).toContain('192.0.2.77:61000');
    expect(failed?.textContent).toContain('3×');
    expect(failed?.querySelector('[data-slot="unverified-name"]')).not.toBeNull();
    expect(table.querySelector('tr[data-event="pair_ok"] [data-slot="unverified-name"]')).toBeNull();
    expect(table.querySelector('tr[data-event="tls_failed"]')?.textContent).toContain('192.0.2.99');
    // Viewing marks the rejected attempts as seen.
    await waitFor(() => {
      expect(fake.calls).toContain('eventsSeen');
    });
    expect(scenario.host.hostState.remoteAccess?.unseenRejected).toBe(0);

    await user.click(within(log).getByRole('checkbox', { name: 'Only rejected attempts' }));
    await waitFor(() => {
      expect(table.querySelectorAll('tbody tr')).toHaveLength(3);
    });
    expect(fake.calls).toContain('events:true');

    const loads = fake.eventLoads;
    act(() => {
      fake.rejectAttempt('pair_failed', 'Visitor');
    });
    await waitFor(() => {
      expect(table.querySelectorAll('tbody tr')).toHaveLength(4);
    });
    expect(fake.eventLoads).toBe(loads + 1);
  });

  it('a failed log load offers to try again', async () => {
    const user = userEvent.setup();
    const { fake } = await start('off');
    fake.failNext('events', makeError('INTERNAL_ERROR'));
    await user.click(screen.getByRole('radio', { name: 'Share' }));
    const log = await waitFor(() => part('log'));
    const alert = await within(log).findByRole('alert');
    expect(alert.textContent).toContain('The log could not be loaded.');
    await user.click(within(alert).getByRole('button', { name: 'Try again' }));
    expect(await within(log).findByRole('table')).toBeTruthy();
    expect(fake.calls.filter((call) => call === 'events:false')).toHaveLength(2);
  });

  it('uses the real host commands by default (FakeHost: not implemented → alert, role unchanged)', async () => {
    const user = userEvent.setup();
    const { scenario } = await start('off', { real: true });
    await user.click(screen.getByRole('radio', { name: 'Share' }));
    const alert = await screen.findByRole('alert');
    expect(alert.textContent).toContain('This is not available yet.');
    expect(scenario.host.commands).toContainEqual({ name: 'multiHost.configure', role: 'share' });
    expect(screen.getByRole('radio', { name: 'Off' }).getAttribute('aria-checked')).toBe('true');
  });

  it('the settings page lists the section after "Server"', async () => {
    const user = userEvent.setup();
    running = startScenario('empty', { select: null });
    render(
      <TooltipProvider>
        <SettingsPage section="server" onClose={() => undefined} />
      </TooltipProvider>,
    );
    const dialog = await screen.findByRole('dialog', { name: 'Settings' });
    const tabs = within(dialog)
      .getAllByRole('tab')
      .map((tab) => tab.textContent);
    expect(tabs.indexOf('Several computers')).toBe(tabs.indexOf('Server') + 1);
    await user.click(within(dialog).getByRole('tab', { name: 'Several computers' }));
    expect(await within(dialog).findByRole('radio', { name: 'Share' })).toBeTruthy();
  });
});

describe('access of the pairing (WP-107, WP-76 §B.13)', () => {
  it('the access is chosen before the code shows; the card and the paired computer name it', async () => {
    const user = userEvent.setup();
    const { fake } = await start('share');
    const choice = document.querySelector<HTMLElement>('[data-slot="pairing-level-choice"]');
    if (choice === null) throw new Error('no level choice');
    expect(within(choice).getByRole('radio', { name: 'Control' }).getAttribute('aria-checked')).toBe('true');
    expect(within(choice).getByText(/Only needed when this computer runs without a desktop/)).toBeTruthy();
    await user.click(within(choice).getByRole('radio', { name: 'Manage' }));
    await user.click(screen.getByRole('button', { name: 'Pair a computer' }));
    const card = await screen.findByRole('group', { name: 'Pairing code' });
    expect(fake.calls).toContain('pair:manage');
    expect(card.querySelector('[data-slot="pairing-level"]')?.textContent).toBe('Manage');
    act(() => {
      fake.completePairing('Computer A');
    });
    expect(await screen.findByText('Paired with Computer A.')).toBeTruthy();
    expect(part('peer').querySelector('[data-slot="peer-level"]')?.textContent).toBe('Manage');
  });

  it('the default stays control (plain `pair`)', async () => {
    const user = userEvent.setup();
    const { fake } = await start('share');
    await user.click(screen.getByRole('button', { name: 'Pair a computer' }));
    const card = await screen.findByRole('group', { name: 'Pairing code' });
    expect(fake.calls).toContain('pair');
    expect(card.querySelector('[data-slot="pairing-level"]')?.textContent).toBe('Control');
  });

  it('changes the access of the paired computer after asking, both ways', async () => {
    const user = userEvent.setup();
    const { fake } = await start('paired');
    const peer = part('peer');
    expect(peer.querySelector('[data-slot="peer-level"]')?.textContent).toBe('Control');

    await user.click(within(peer).getByRole('button', { name: 'Allow managing…' }));
    const raise = peer.querySelector<HTMLElement>('[data-slot="peer-confirm"]');
    expect(raise?.getAttribute('data-confirm')).toBe('level');
    expect(raise?.textContent).toContain('Let Computer A manage this computer?');
    expect(raise?.textContent).toContain('environment values');
    // The harmless choice has the focus; "Cancel" sends nothing.
    expect(document.activeElement?.textContent).toBe('Cancel');
    await user.click(within(raise ?? peer).getByRole('button', { name: 'Cancel' }));
    expect(fake.calls.some((call) => call.startsWith('setPeerLevel'))).toBe(false);

    await user.click(within(peer).getByRole('button', { name: 'Allow managing…' }));
    await user.click(within(peer).getByRole('button', { name: 'Allow managing' }));
    expect(await within(peer).findByText('The access was changed.')).toBeTruthy();
    expect(fake.calls).toContain('setPeerLevel:manage');
    expect(peer.querySelector('[data-slot="peer-level"]')?.textContent).toBe('Manage');

    await user.click(within(peer).getByRole('button', { name: 'Control only…' }));
    expect(peer.querySelector('[data-slot="peer-confirm"]')?.textContent).toContain(
      'Let Computer A only control this computer?',
    );
    await user.click(within(peer).getByRole('button', { name: 'Control only' }));
    await waitFor(() => {
      expect(fake.calls).toContain('setPeerLevel:control');
    });
    expect(peer.querySelector('[data-slot="peer-level"]')?.textContent).toBe('Control');
  });

  it('a refused change shows the error in the panel and keeps the access', async () => {
    const user = userEvent.setup();
    const { fake } = await start('paired');
    fake.failNext('setPeerLevel', makeError('REMOTE_ACCESS_FAILED', { reason: 'store' }));
    const peer = part('peer');
    await user.click(within(peer).getByRole('button', { name: 'Allow managing…' }));
    await user.click(within(peer).getByRole('button', { name: 'Allow managing' }));
    const alert = await within(peer).findByRole('alert');
    expect(alert.textContent).toContain('The action failed.');
    expect(peer.querySelector('[data-slot="peer-level"]')?.textContent).toBe('Control');
  });
});
