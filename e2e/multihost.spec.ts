/**
 * "Several computers" end to end (WP-82, WP-75 §7): three servers of the built bundle – A controls,
 * B and C share. Everything stays on 127.0.0.1 (the listeners bind there, never 0.0.0.0: no
 * firewall prompt), each server has its own temp home; keys go through the real Windows key store.
 * - B pairs through both UIs (code shown on B, typed on A), C over the protocol (node clients);
 * - A shows the sessions of B and C with badges, groups them by computer (A first, then the list
 *   order), answers in a session of B and starts a new session on C;
 * - a draft typed on A for a session of B shows up in B's own window (WP-77);
 * - "Unpair" on B ends the coupling at once: A shows the computer as revoked.
 */
import { createServer } from 'node:net';
import { expect, keepServerLog, test } from './support/fixtures';
import { connectNodeClient, nodeCommand, startE2eServer, type E2eServer } from './support/server';

test.use({ ownServer: 'multihost' });

const others: E2eServer[] = [];

test.afterEach(async () => {
  for (const server of others.splice(0)) await server.stop(keepServerLog(test.info()));
});

/** A free TCP port on 127.0.0.1 (≥ 1024; closed again before the server takes it). */
function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const probe = createServer();
    probe.once('error', reject);
    probe.listen({ host: '127.0.0.1', port: 0 }, () => {
      const address = probe.address();
      probe.close(() => {
        if (address === null || typeof address === 'string') reject(new Error('no port'));
        else resolve(address.port);
      });
    });
  });
}

/** Starts a server and lets it share on 127.0.0.1:<port> (role share, the checks run first). */
async function sharingServer(label: string): Promise<{ server: E2eServer; port: number }> {
  const server = await startE2eServer({ label });
  others.push(server);
  const port = await freePort();
  const client = await connectNodeClient(server);
  try {
    await nodeCommand(client, { name: 'multiHost.configure', role: 'share', port, bindAddress: '127.0.0.1' });
  } finally {
    client.socket.terminate();
  }
  return { server, port };
}

async function command(server: E2eServer, cmd: Record<string, unknown>): Promise<unknown> {
  const client = await connectNodeClient(server);
  try {
    return await nodeCommand(client, cmd);
  } finally {
    client.socket.terminate();
  }
}

test('control two sharing computers: pair, badges, groups, answer, new session, draft, unpair', async ({
  app,
  server,
  page,
  newWindow,
}) => {
  test.setTimeout(240_000);
  const b = await sharingServer('share-b');
  const c = await sharingServer('share-c');
  const projectB = await b.server.makeProject('api-b');
  const projectC = await c.server.makeProject('web-c');
  const created = (await command(b.server, { name: 'session.create', cwd: projectB, title: 'Auf B' })) as {
    entryId: string;
  };

  // ---- A: role "Control others", add B with the code B shows ----
  const settings = await app.openSettingsPage('multiHost');
  await settings.locator('[role="radio"][value="control"]').click();
  await expect(settings.locator('[data-slot="multi-host-control"]')).toBeVisible();

  const windowB = await newWindow({ server: b.server });
  const settingsB = await windowB.openSettingsPage('multiHost');
  await settingsB.locator('[data-action="pairing-start"]').click();
  const codeB = (await settingsB.locator('[data-slot="pairing-code"]').innerText()).replace(/\s+/g, '');
  expect(codeB.length).toBeGreaterThanOrEqual(26);

  await page.bringToFront();
  await settings.locator('[data-action="host-add"]').click();
  const form = page.locator('[data-slot="host-form"]');
  await form.locator('input[name="name"]').fill('Rechner B');
  await form.locator('input[name="address"]').fill('127.0.0.1');
  await form.locator('input[name="port"]').fill(String(b.port));
  await form.locator('input[name="code"]').fill(codeB);
  await form.locator('[data-action="host-form-submit"]').click();
  await expect(form).toBeHidden({ timeout: 60_000 });
  const rowB = settings.locator('[data-host-row]').first();
  await expect(rowB).toHaveAttribute('data-status', 'connected', { timeout: 60_000 });
  const hostB = (await rowB.getAttribute('data-host-row')) ?? '';
  expect(hostB).not.toBe('');
  // B sees the coupling (name as A gave it, connected).
  await expect(settingsB.locator('[data-slot="pairing-code"]')).toBeHidden({ timeout: 30_000 });

  // ---- C over the protocol ----
  const pairC = (await command(c.server, { name: 'remoteAccess.pair' })) as { code: string };
  const addedC = (await command(server, {
    name: 'hosts.add',
    address: '127.0.0.1',
    port: c.port,
    code: pairC.code,
    displayName: 'Rechner C',
  })) as { hostId: string };
  const hostC = addedC.hostId;
  await expect(settings.locator(`[data-host-row="${hostC}"]`)).toHaveAttribute('data-status', 'connected', {
    timeout: 60_000,
  });

  // ---- sidebar: the session of B with its badge, groups by computer ----
  const keyB = `${hostB}:${created.entryId}`;
  await page.keyboard.press('Escape');
  await expect(app.row(keyB)).toBeVisible({ timeout: 60_000 });
  await expect(app.row(keyB).locator('[data-slot="host-badge"]')).toBeVisible();
  await page.locator('[data-slot="sidebar-mode"]').click();
  await page.locator('[data-group-by="host"]').click();
  await page.keyboard.press('Escape');
  await expect
    .poll(() =>
      page
        .locator('[data-host-group]')
        .evaluateAll((groups) => groups.map((group) => group.getAttribute('data-host-group'))),
    )
    .toEqual(['local', hostB, hostC]);

  // ---- answer in the session of B (FakeBackend echo on B) ----
  const sessionB = await app.selectSession(keyB);
  await sessionB.send('hallo von A');
  await expect(sessionB.assistantText('Echo: hallo von A')).toBeVisible({ timeout: 60_000 });

  // ---- new session on C from A ----
  await page.locator('[data-action="new-session"]').click();
  const dialog = page.locator('[data-slot="new-session-dialog"]');
  await expect(dialog).toBeVisible();
  await dialog.locator('[data-slot="host-select"]').click();
  await page.locator(`[data-host-option="${hostC}"]`).click();
  await expect(dialog.locator('[data-slot="host-select"]')).toHaveAttribute('data-host-id', hostC);
  await dialog.locator('input[name="cwd"]').fill(projectC);
  await dialog.locator('button[type="submit"]').click();
  await expect(dialog).toBeHidden({ timeout: 60_000 });
  const keyC = await app.waitForSelection((key) => key?.startsWith(`${hostC}:`) === true);
  const entryC = keyC.slice(keyC.indexOf(':') + 1);
  const clientC = await connectNodeClient(c.server);
  try {
    const snapshot = clientC.all('summaries.snapshot').at(-1);
    expect(snapshot?.summaries.map((summary) => summary.entryId)).toContain(entryC);
  } finally {
    clientC.socket.terminate();
  }

  // ---- a draft typed on A appears in B's own window ----
  const draftB = await app.selectSession(keyB);
  await draftB.composer.click();
  await draftB.composer.fill('Entwurf von A');
  await windowB.page.bringToFront();
  await windowB.page.keyboard.press('Escape');
  const ownB = await windowB.selectSession(`local:${created.entryId}`);
  await expect(ownB.composer).toHaveValue('Entwurf von A', { timeout: 30_000 });

  // B logged the connections and rejected nothing (A's key and proof were right every time).
  const events = (await command(b.server, { name: 'remoteAccess.events', onlyRejected: true })) as {
    events: unknown[];
  };
  expect(events.events).toEqual([]);

  // ---- B lifts the coupling: A shows the computer as revoked ----
  await command(b.server, { name: 'remoteAccess.unpair' });
  await page.bringToFront();
  const settingsAgain = await app.openSettingsPage('multiHost');
  await expect(settingsAgain.locator(`[data-host-row="${hostB}"]`)).toHaveAttribute(
    'data-status',
    'revoked',
    {
      timeout: 60_000,
    },
  );
  await windowB.page.close();
});
