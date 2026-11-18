import { act, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { makeError } from '@shared/errors';
import { formatPairingCode } from '@shared/pairing';
import { startScenario, type RunningScenario } from '@web/playground/PlaygroundScenario';
import { DEMO_HOSTS, startHostsDemo, type RunningHostsDemo } from '@web/shell/hosts/hosts-demo';
import { resetClientStore } from '@web/state/store';
import { TooltipProvider } from '@web/ui/tooltip';
import { ControlPart } from './ControlPart';

/**
 * WP-80 (WP-75 §4.3): part "Control others" – the list of sharing computers with status and
 * version, add with pairing code, edit, order, reconnect, pair again, remove after asking.
 * Commands go to this computer's FakeHost ("Several computers" switched on, two other computers).
 */

vi.setConfig({ testTimeout: 60_000 });

const CODE = formatPairingCode(new Uint8Array(16).fill(9));

let demo: RunningHostsDemo | null = null;
let single: RunningScenario | null = null;

afterEach(() => {
  demo?.stop();
  demo = null;
  single?.stop();
  single = null;
  resetClientStore();
});

async function start(): Promise<RunningHostsDemo> {
  demo = startHostsDemo({ select: null });
  render(
    <TooltipProvider>
      <ControlPart />
    </TooltipProvider>,
  );
  await waitFor(() => {
    expect(rows()).toHaveLength(2);
  });
  return demo;
}

function rows(): HTMLElement[] {
  return [...document.querySelectorAll<HTMLElement>('[data-host-row]')];
}

function row(hostId: string): HTMLElement {
  const found = document.querySelector<HTMLElement>(`[data-host-row="${hostId}"]`);
  if (found === null) throw new Error(`row ${hostId} missing`);
  return found;
}

function commands(running: RunningHostsDemo, prefix = 'hosts.'): unknown[] {
  return running.scenario.host.commands.filter((cmd) => cmd.name.startsWith(prefix));
}

async function openAdd(): Promise<HTMLElement> {
  await userEvent.setup().click(screen.getByRole('button', { name: 'Add computer…' }));
  return screen.findByRole('dialog', { name: 'Add a computer' });
}

describe('ControlPart (WP-80)', () => {
  it('without computers: an empty list with the way to add one', () => {
    single = startScenario('empty', { select: null });
    render(
      <TooltipProvider>
        <ControlPart />
      </TooltipProvider>,
    );
    expect(screen.getByText(/No computer added yet/)).toBeTruthy();
    // MultiHostSection.test (WP-78b) checks this part by its words.
    expect(document.querySelector('[data-slot="multi-host-control"]')?.textContent).toContain(
      'sharing computers in the same network',
    );
  });

  it('lists the computers in sidebar order with status, address and version', async () => {
    const running = await start();
    expect(rows().map((element) => element.dataset.hostRow)).toEqual([DEMO_HOSTS.b, DEMO_HOSTS.c]);
    expect(within(row(DEMO_HOSTS.b)).getByText('Connected')).toBeTruthy();
    expect(row(DEMO_HOSTS.c).querySelector('[data-slot="host-address"]')?.textContent).toBe(
      'Address 192.0.2.30, port 4713',
    );
    expect(row(DEMO_HOSTS.b).querySelector('[data-slot="host-version"]')?.textContent).toContain(
      'Parallax 0.0.0',
    );
    act(() => {
      running.computers.setReachable(DEMO_HOSTS.c, false);
    });
    await waitFor(() => {
      expect(row(DEMO_HOSTS.c).dataset.status).toBe('unreachable');
    });
    expect(within(row(DEMO_HOSTS.c)).getByText('Not reachable')).toBeTruthy();
  });

  it('adds a computer with its pairing code; a code that is not complete is named first', async () => {
    const running = await start();
    const user = userEvent.setup();
    const dialog = await openAdd();
    await user.type(within(dialog).getByRole('textbox', { name: 'Name' }), 'Computer D');
    await user.type(within(dialog).getByRole('textbox', { name: 'Address' }), '192.0.2.40');
    const code = within(dialog).getByRole('textbox', { name: 'Pairing code' });
    await user.type(code, CODE.slice(0, -1) + (CODE.endsWith('0') ? '1' : '0'));
    expect(dialog.querySelector('[data-slot="host-form-code-hint"]')?.textContent).toBe(
      'This is not a complete pairing code – check every character.',
    );
    expect(code.getAttribute('aria-invalid')).toBe('true');
    await user.click(within(dialog).getByRole('button', { name: 'Pair and add' }));
    expect(commands(running)).toEqual([]);
    await user.clear(code);
    await user.type(code, CODE.toLowerCase());
    await user.click(within(dialog).getByRole('button', { name: 'Pair and add' }));
    await waitFor(() => {
      expect(screen.queryByRole('dialog')).toBeNull();
    });
    expect(commands(running)).toEqual([
      {
        name: 'hosts.add',
        address: '192.0.2.40',
        port: 4713,
        code: CODE.toLowerCase(),
        displayName: 'Computer D',
      },
    ]);
    await waitFor(() => {
      expect(rows().map((element) => element.dataset.hostRow)).toEqual([
        DEMO_HOSTS.b,
        DEMO_HOSTS.c,
        'computer-d',
      ]);
    });
  });

  it('a failed pairing shows its error in the dialog, which stays open', async () => {
    const running = await start();
    running.scenario.host.multiHost = { unreachableAddresses: ['192.0.2.99'] };
    const user = userEvent.setup();
    const dialog = await openAdd();
    await user.type(within(dialog).getByRole('textbox', { name: 'Name' }), 'Far away');
    await user.type(within(dialog).getByRole('textbox', { name: 'Address' }), '192.0.2.99');
    const port = within(dialog).getByRole('textbox', { name: 'Port' });
    await user.clear(port);
    await user.type(port, '5000');
    await user.type(within(dialog).getByRole('textbox', { name: 'Pairing code' }), CODE);
    await user.click(within(dialog).getByRole('button', { name: 'Pair and add' }));
    const alert = await within(dialog).findByRole('alert');
    expect(alert.textContent).toContain('The computer was not added.');
    expect(alert.textContent).toContain('The other computer cannot be reached.');
    expect(commands(running)).toEqual([
      { name: 'hosts.add', address: '192.0.2.99', port: 5000, code: CODE, displayName: 'Far away' },
    ]);
    expect(screen.getByRole('dialog', { name: 'Add a computer' })).toBeTruthy();
  });

  it('edits name and color: only what changed goes to hosts.update', async () => {
    const running = await start();
    const user = userEvent.setup();
    await user.click(within(row(DEMO_HOSTS.b)).getByRole('button', { name: 'Edit…' }));
    const dialog = await screen.findByRole('dialog', { name: 'Edit Computer B' });
    expect(within(dialog).queryByRole('textbox', { name: 'Pairing code' })).toBeNull();
    const name = within(dialog).getByRole('textbox', { name: 'Name' });
    await user.clear(name);
    await user.type(name, 'Build server');
    await user.click(within(dialog).getByRole('radio', { name: 'Amber' }));
    await user.click(within(dialog).getByRole('button', { name: 'Save' }));
    await waitFor(() => {
      expect(screen.queryByRole('dialog')).toBeNull();
    });
    expect(commands(running)).toEqual([
      { name: 'hosts.update', hostId: DEMO_HOSTS.b, displayName: 'Build server', color: 'amber' },
    ]);
    await waitFor(() => {
      expect(row(DEMO_HOSTS.b).textContent).toContain('Build server');
    });
  });

  it('changes the order and reconnects', async () => {
    const running = await start();
    const user = userEvent.setup();
    expect(within(row(DEMO_HOSTS.b)).getByRole('button', { name: 'Move Computer B up' })).toHaveProperty(
      'disabled',
      true,
    );
    await user.click(within(row(DEMO_HOSTS.b)).getByRole('button', { name: 'Move Computer B down' }));
    await waitFor(() => {
      expect(rows().map((element) => element.dataset.hostRow)).toEqual([DEMO_HOSTS.c, DEMO_HOSTS.b]);
    });
    expect(within(row(DEMO_HOSTS.c)).getByRole('button', { name: 'Reconnect' })).toHaveProperty(
      'disabled',
      true,
    );
    act(() => {
      running.computers.setReachable(DEMO_HOSTS.c, false);
    });
    await waitFor(() => {
      expect(row(DEMO_HOSTS.c).dataset.status).toBe('unreachable');
    });
    await user.click(within(row(DEMO_HOSTS.c)).getByRole('button', { name: 'Reconnect' }));
    await waitFor(() => {
      expect(commands(running)).toEqual([
        { name: 'hosts.move', hostId: DEMO_HOSTS.b, index: 1 },
        { name: 'hosts.reconnect', hostId: DEMO_HOSTS.c },
      ]);
    });
  });

  it('removes a computer after asking; an unreachable one with the hint to remove the pairing there', async () => {
    const running = await start();
    const user = userEvent.setup();
    await user.click(within(row(DEMO_HOSTS.b)).getByRole('button', { name: 'Remove…' }));
    const confirm = document.querySelector<HTMLElement>('[data-slot="host-remove-confirm"]');
    if (confirm === null) throw new Error('confirmation missing');
    expect(confirm.textContent).toContain('Remove Computer B?');
    expect(confirm.textContent).toContain('asks Computer B to drop the pairing');
    await user.click(within(confirm).getByRole('button', { name: 'Cancel' }));
    expect(commands(running)).toEqual([]);

    act(() => {
      running.computers.setReachable(DEMO_HOSTS.c, false);
    });
    await waitFor(() => {
      expect(row(DEMO_HOSTS.c).dataset.status).toBe('unreachable');
    });
    await user.click(within(row(DEMO_HOSTS.c)).getByRole('button', { name: 'Remove…' }));
    const second = document.querySelector<HTMLElement>('[data-slot="host-remove-confirm"]');
    if (second === null) throw new Error('confirmation missing');
    expect(second.textContent).toContain('remove the pairing yourself');
    await user.click(within(second).getByRole('button', { name: 'Remove' }));
    await waitFor(() => {
      expect(rows().map((element) => element.dataset.hostRow)).toEqual([DEMO_HOSTS.b]);
    });
    expect(commands(running)).toEqual([{ name: 'hosts.remove', hostId: DEMO_HOSTS.c }]);
    expect(document.querySelector('[data-slot="host-done"]')?.textContent).toBe(
      'Computer C was removed here. Remove the pairing on Computer C yourself.',
    );
  });

  it('another version: the hint to update Parallax there; a failed action shows its error', async () => {
    const running = await start();
    act(() => {
      running.computers.makeIncompatible(DEMO_HOSTS.b, '9.9.9');
    });
    await waitFor(() => {
      expect(row(DEMO_HOSTS.b).dataset.status).toBe('incompatible');
    });
    expect(row(DEMO_HOSTS.b).querySelector('[data-slot="host-hint"]')?.textContent).toBe(
      'Update Parallax on Computer B to 0.0.0.',
    );
    expect(row(DEMO_HOSTS.b).querySelector('[data-slot="host-version"]')?.textContent).toContain(
      'Parallax 9.9.9',
    );
    running.scenario.host.failNext(
      'hosts.reconnect',
      makeError('HOST_INCOMPATIBLE', { version: '9.9.9', protocol: 9 }),
    );
    await userEvent.setup().click(within(row(DEMO_HOSTS.b)).getByRole('button', { name: 'Reconnect' }));
    const alert = await screen.findByRole('alert');
    expect(alert.textContent).toContain('The change was not saved.');
  });

  it('pairing removed on the other side: pair again keeps name, color and place', async () => {
    const running = await start();
    act(() => {
      running.computers.revoke(DEMO_HOSTS.b);
    });
    await waitFor(() => {
      expect(row(DEMO_HOSTS.b).dataset.status).toBe('revoked');
    });
    expect(within(row(DEMO_HOSTS.b)).queryByRole('button', { name: 'Reconnect' })).toBeNull();
    const user = userEvent.setup();
    await user.click(within(row(DEMO_HOSTS.b)).getByRole('button', { name: 'Pair again…' }));
    const dialog = await screen.findByRole('dialog', { name: 'Pair Computer B again' });
    expect(within(dialog).getByRole<HTMLInputElement>('textbox', { name: 'Address' }).value).toBe(
      '192.0.2.20',
    );
    await user.type(within(dialog).getByRole('textbox', { name: 'Pairing code' }), CODE);
    await user.click(within(dialog).getByRole('button', { name: 'Pair again' }));
    await waitFor(() => {
      expect(screen.queryByRole('dialog')).toBeNull();
    });
    // One step: the entry keeps its id, color and place (replaceHostId).
    expect(commands(running)).toEqual([
      {
        name: 'hosts.add',
        address: '192.0.2.20',
        port: 4713,
        code: CODE,
        displayName: 'Computer B',
        replaceHostId: DEMO_HOSTS.b,
      },
    ]);
    await waitFor(() => {
      expect(row(DEMO_HOSTS.b).dataset.status).toBe('connected');
    });
    expect(rows().map((element) => element.dataset.hostRow)).toEqual([DEMO_HOSTS.b, DEMO_HOSTS.c]);
  });
});
