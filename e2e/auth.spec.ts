/**
 * Auth (A.8, architecture §5.1, Plan "Verifikation" Phase 1: "Ohne Token antwortet der Server mit
 * 401, ein fremder Origin wird abgewiesen"): one-time code from the launcher endpoint → cookie,
 * `#code=` leaves the URL, a reload stays signed in, no cookie / a used code / a foreign origin is
 * rejected – in the browser and on the wire.
 */
import { createServer, type Server } from 'node:http';
import { authCookieName } from '@shared/http';
import { connectWs, rawRequest } from '../src/server/http/testServer';
import { expect, test } from './support/fixtures';

test('the code leaves the URL; a reload stays signed in through the device cookie', async ({
  page,
  server,
}) => {
  const url = await server.loginUrl('session=local:en_00000000000000000000000000000000');
  expect(url).toContain('#code=');
  await page.goto(url);
  await expect(page.locator('[data-slot="connection-indicator"]')).toHaveAttribute('data-status', 'open');
  // The code is taken out of the hash at once; other parameters stay (history.replaceState).
  const hash = await page.evaluate(() => window.location.hash);
  expect(hash).not.toContain('code=');
  expect(hash).toContain('session=');

  const cookies = await page.context().cookies(server.origin);
  const device = cookies.find((cookie) => cookie.name === authCookieName(server.port));
  expect(device).toMatchObject({ httpOnly: true, sameSite: 'Strict', path: '/' });

  await page.reload();
  await expect(page.locator('[data-slot="connection-indicator"]')).toHaveAttribute('data-status', 'open');
  expect(await page.evaluate(() => window.location.href)).not.toContain('code=');
  await expect(page.getByRole('heading', { name: 'Not signed in' })).toHaveCount(0);
});

test('without a cookie, and with a used code, the window is not signed in (no WS)', async ({
  browser,
  server,
}) => {
  // First window uses the code …
  const url = await server.loginUrl();
  const first = await browser.newContext();
  try {
    const signedIn = await first.newPage();
    await signedIn.goto(url);
    await expect(signedIn.locator('[data-slot="connection-indicator"]')).toHaveAttribute(
      'data-status',
      'open',
    );

    // … a second context (own Edge profile, no cookie) with the same, now used code is rejected.
    const second = await browser.newContext();
    try {
      const page = await second.newPage();
      const ws: string[] = [];
      page.on('websocket', (socket) => ws.push(socket.url()));
      await page.goto(url);
      await expect(page.getByRole('heading', { name: 'Not signed in' })).toBeVisible();
      await expect(
        page.getByText('The sign-in link is invalid or has expired', { exact: false }),
      ).toBeVisible();
      expect(await page.evaluate(() => window.location.hash)).toBe('');
      // Plain `/` without cookie: signed out as well, and never a WebSocket.
      await page.goto(server.origin);
      await expect(page.getByRole('heading', { name: 'Not signed in' })).toBeVisible();
      expect(ws).toEqual([]);
    } finally {
      await second.close();
    }
  } finally {
    await first.close();
  }
});

test('a foreign origin is rejected: page on another port, forged requests, missing token', async ({
  app,
  server,
}) => {
  // A page of another origin on 127.0.0.1 in the SIGNED-IN context (same site: the SameSite=Strict
  // cookie is sent – only the Origin check stops it).
  const foreign: Server = createServer((_req, res) => {
    res.writeHead(200, { 'content-type': 'text/html' }).end('<!doctype html><title>foreign</title>');
  });
  await new Promise<void>((resolve) => foreign.listen(0, '127.0.0.1', resolve));
  try {
    const address = foreign.address();
    if (address === null || typeof address === 'string') throw new Error('foreign server not listening');
    const page = await app.page.context().newPage();
    await page.goto(`http://127.0.0.1:${String(address.port)}/`);
    const result = await page.evaluate(
      (port) =>
        new Promise<string>((resolve) => {
          const socket = new WebSocket(`ws://127.0.0.1:${String(port)}/api/ws`);
          socket.onmessage = () => {
            resolve('message');
          };
          socket.onclose = (event) => {
            resolve(`close ${String(event.code)}`);
          };
        }),
      server.port,
    );
    expect(result).toBe('close 1006');
    await page.close();
  } finally {
    await new Promise<void>((resolve) => {
      foreign.close(() => {
        resolve();
      });
    });
  }

  const cookie = await server.deviceCookie();
  // WS upgrade with a valid cookie but a foreign Origin → 403 ORIGIN_REJECTED.
  const forged = await connectWs(
    { port: server.port, origin: 'http://127.0.0.1:1', host: `127.0.0.1:${String(server.port)}` },
    { cookie },
  );
  expect(forged).toMatchObject({ ok: false, status: 403 });
  if (!forged.ok) expect(forged.body).toContain('ORIGIN_REJECTED');
  // WS without cookie → 401.
  const anonymous = await connectWs({
    port: server.port,
    origin: server.origin,
    host: `127.0.0.1:${String(server.port)}`,
  });
  expect(anonymous).toMatchObject({ ok: false, status: 401 });
  // POST /api/auth from a foreign origin → 403, without any Origin → 403.
  const forgedHeaders: Record<string, string>[] = [
    { origin: 'http://evil.example', 'sec-fetch-site': 'cross-site' },
    { 'sec-fetch-site': 'same-origin' },
  ];
  for (const headers of forgedHeaders) {
    const response = await rawRequest(server.port, {
      method: 'POST',
      path: '/api/auth',
      headers: { ...headers, 'content-type': 'application/json' },
      body: JSON.stringify({ code: 'A'.repeat(43) }),
    });
    expect(response.status).toBe(403);
  }
  // Launcher endpoint without / with a wrong token → 401 LAUNCHER_TOKEN_INVALID.
  for (const authorization of [undefined, `Bearer ${'B'.repeat(43)}`]) {
    const response = await rawRequest(server.port, {
      method: 'POST',
      path: '/api/launcher/code',
      headers: {
        'content-type': 'application/json',
        ...(authorization === undefined ? {} : { authorization }),
      },
      body: '{}',
    });
    expect(response.status).toBe(401);
    expect(response.body).toContain('LAUNCHER_TOKEN_INVALID');
  }
  // Auth status without cookie: 200, but not authenticated.
  const status = await rawRequest(server.port, { method: 'GET', path: '/api/auth/status' });
  expect(status.status).toBe(200);
  expect(JSON.parse(status.body)).toMatchObject({ authenticated: false });
});
