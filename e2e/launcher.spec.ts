/**
 * The real start path (`pnpm start` = launcher, WP-21) with the FakeBackend: the launcher checks
 * the build, starts `dist/server.js` hidden and detached, waits for lock file + health, fetches a
 * one-time code and prints the sign-in address (`--print-url` instead of an Edge window). The test
 * waits for the launcher's `exit` (not for its output to end – the detached server inherits the
 * handles, docs/wp/WP-20a.md gap 3), opens the address in Edge and stops the server again.
 */
import { spawn } from 'node:child_process';
import { mkdir, mkdtemp, open, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { REPO_ROOT } from './support/paths';
import { ParallaxApp } from './support/app';
import { adoptE2eServer, type E2eServer } from './support/server';
import { expect, keepServerLog, test } from './support/fixtures';

const TSX_CLI = path.join(REPO_ROOT, 'node_modules', 'tsx', 'dist', 'cli.mjs');

let adopted: E2eServer | null = null;
let root: string | null = null;

test.afterEach(async () => {
  await adopted?.stop(keepServerLog(test.info()));
  adopted = null;
  if (root !== null) await rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
  root = null;
});

test('launcher (pnpm start, PARALLAX_BACKEND=fake) starts the server and hands over a sign-in URL', async ({
  page,
}) => {
  root = await mkdtemp(path.join(os.tmpdir(), 'parallax-e2e-launcher-'));
  const home = path.join(root, 'home');
  await mkdir(home);
  const startedAt = new Date(Date.now() - 1000);
  // Output into a file: the detached server inherits the handle, a pipe would stay open with it.
  const outFile = path.join(root, 'launcher.out.txt');
  const out = await open(outFile, 'w');
  const env: NodeJS.ProcessEnv = {};
  for (const [key, value] of Object.entries(process.env)) if (!key.startsWith('PARALLAX_')) env[key] = value;
  Object.assign(env, { PARALLAX_BACKEND: 'fake', PARALLAX_HOME: home, PARALLAX_PORT: '0', NODE_ENV: 'test' });
  const launcher = spawn(
    process.execPath,
    [TSX_CLI, '--tsconfig', 'src/server/tsconfig.json', 'src/server/launcher/main.ts', '--print-url'],
    { cwd: REPO_ROOT, env, stdio: ['ignore', out.fd, out.fd], windowsHide: true },
  );
  const code = await new Promise<number | null>((resolve) => {
    launcher.once('exit', (exitCode) => {
      resolve(exitCode);
    });
  });
  await out.close();
  const text = await readFile(outFile, 'utf8');
  expect(code, text).toBe(0);
  const url = /Open this address within 60 seconds[^:]*: (http:\/\/127\.0\.0\.1:\d+\/#code=\S+)/.exec(
    text,
  )?.[1];
  expect(url, text).toBeDefined();

  adopted = await adoptE2eServer({ root, home, startedAt });
  expect(url).toContain(`${adopted.origin}/#code=`);
  await page.goto(url ?? '');
  const app = new ParallaxApp(page, adopted);
  await app.waitConnected();
  expect(await page.evaluate(() => window.location.hash)).toBe('');
  const session = await app.newSession(await adopted.makeProject('launcher'));
  await session.send('hello from the launcher path');
  await expect(session.assistantText('Echo: hello from the launcher path')).toBeVisible();

  // "Stop server" over the protocol; the detached process ends cleanly.
  await adopted.requestShutdown();
  await expect(page.getByRole('heading', { name: 'Parallax server stopped' })).toBeVisible();
  await adopted.assertCleanExit();
});
