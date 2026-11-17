/**
 * Update in the app (WP-89e, docs/wp/WP-87.md §2.5 "E2E"), against real processes: an installation
 * root below `<repo>\test-results\update-e2e\` with version A (9.9.0), started like parallax.cmd
 * (`start.mjs --print-url`, FakeBackend, fixed port), a local release server and a fake registry.
 * The packages are signed with a test key and built from the update test bundles
 * (`__PARALLAX_UPDATE_TEST__`): B (9.9.1), B-broken (9.9.2, `dist/server.js` exits at once with 1),
 * a package with a wrong SDK hash (9.9.3). The tests build on each other (serial, one worker):
 *
 * 1. 404 on latest.json → "Check now" shows no update (and auto-check goes off for the rest).
 * 2. Hint → prepare → restart → "restarting" banner → the window reloads → "Updated to 9.9.1".
 * 3. "Back to 9.9.0".
 * 4. B-broken → the orchestrator goes back → banner `failedUpdate`, current.json byte for byte as
 *    before, the data (session, setting, last-version.json) back.
 * 5. Upload of a foreign file → UPDATE_INVALID_PACKAGE.
 * 6. Upload of a package with a wrong SDK hash → UPDATE_SDK_FAILED (the registry was asked).
 *
 * After every switch no process of it is left (old server, orchestrator); at the end the server
 * stops cleanly (`assertCleanExit`). Details and run times: docs/wp/WP-89e.md.
 */
import { access, mkdir, mkdtemp, readdir, readFile, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import type { BrowserContext, Locator, Page, TestInfo } from '@playwright/test';
import { makeTestKey, type TestKey } from '../src/server/install/testPackage';
import { readLastBuildId } from '../src/server/store/backup';
import { UPDATE_RESULT_FILE } from '../src/server/update/marker';
import { ParallaxApp } from './support/app';
import { expect, test } from './support/fixtures';
import { REPO_ROOT } from './support/paths';
import { serverSettings, type E2eServer } from './support/server';
import {
  freePort,
  installFirstVersion,
  installationEnv,
  killInstallation,
  originOf,
  readCurrentFile,
  removeQuietly,
  startInstalled,
  updateLogs,
  waitForRestart,
  type Installation,
} from './support/update-install';
import {
  changelogUpTo,
  ensureTestBuilds,
  makeMiniSdk,
  notesOf,
  serverBanner,
  webBuildInfo,
  writeTestPackage,
  wrongIntegrity,
  type TestBuild,
  type TestPackage,
} from './support/update-packages';
import { startReleaseServer, type OfferedRelease, type ReleaseServer } from './support/update-release-server';

const A = '9.9.0';
const B = '9.9.1';
const BROKEN = '9.9.2';
const BAD_SDK = '9.9.3';
const VERSIONS = [A, B, BROKEN, BAD_SDK] as const;
/**
 * The hint of features/updates in the sidebar head (the shell's frame around the slot carries the
 * same `data-slot`, without `data-state`).
 */
const NOTICE = '[data-slot="update-notice"][data-state]';
/** Packages and root below the checkout: their bundles resolve `<repo>\node_modules`. */
const E2E_ROOT = path.join(REPO_ROOT, 'test-results', 'update-e2e');

interface World {
  inst: Installation;
  release: ReleaseServer;
  key: TestKey;
  builds: { a: TestBuild; b: TestBuild };
  packages: Record<string, TestPackage>;
  /** The server that answers now. */
  server: E2eServer;
  /** Every server of the run (cleanup after a failure). */
  seen: E2eServer[];
  /** A session made before the first switch (data that must survive every switch). */
  sessionKey: string | null;
}

let world: World | null = null;
let failed = false;
/** Cleanup of a beforeAll that stopped before `world` was set (run in order). */
const pending: (() => Promise<void>)[] = [];

function need(): World {
  if (world === null) throw new Error('the update installation was not set up');
  return world;
}

function seconds(since: number): string {
  return String(Math.round((Date.now() - since) / 1000));
}

function log(line: string): void {
  process.stdout.write(`[update-e2e] ${line}\n`);
}

test.describe.configure({ mode: 'serial' });

test.beforeAll(async () => {
  // Cold: two Vite builds + update test bundles (seconds to a minute); cached afterwards.
  test.setTimeout(10 * 60_000);
  const started = Date.now();
  await removeQuietly(E2E_ROOT);
  await mkdir(E2E_ROOT, { recursive: true });
  const [a, b] = await ensureTestBuilds([A, B], log);
  if (a === undefined || b === undefined) throw new Error('missing test builds');
  log(`builds ready after ${seconds(started)} s`);

  const key = makeTestKey();
  const sdk = await makeMiniSdk(path.join(E2E_ROOT, 'sdk'));
  const out = path.join(E2E_ROOT, 'packages');
  const common = { key, sdk: sdk.spec, versions: VERSIONS };
  const brokenId = b.buildId.replace(`${B}+`, `${BROKEN}+`);
  const badSdkId = b.buildId.replace(`${B}+`, `${BAD_SDK}+`);
  const packages: Record<string, TestPackage> = {
    [A]: await writeTestPackage(out, {
      ...common,
      version: A,
      buildId: a.buildId,
      distFrom: path.join(a.dir, 'dist'),
    }),
    [B]: await writeTestPackage(out, {
      ...common,
      version: B,
      buildId: b.buildId,
      distFrom: path.join(b.dir, 'dist'),
    }),
    // B-broken: B's files, but a server that ends at once with exit code 1 (banner and web build id fit).
    [BROKEN]: await writeTestPackage(out, {
      ...common,
      version: BROKEN,
      buildId: brokenId,
      distFrom: path.join(b.dir, 'dist'),
      files: {
        'dist/server.js': `${serverBanner(brokenId)}\nprocess.exit(1);\n`,
        'dist/server.js.map': null,
        'dist/web/build.json': webBuildInfo(brokenId),
      },
    }),
    // A complete, signed package whose release.json names another SDK hash than the tarball has.
    [BAD_SDK]: await writeTestPackage(out, {
      ...common,
      sdk: { ...sdk.spec, integrity: wrongIntegrity() },
      version: BAD_SDK,
      buildId: badSdkId,
      files: {
        'dist/server.js': `${serverBanner(badSdkId)}\nprocess.exit(1);\n`,
        'dist/launcher.js': `// Parallax launcher, build ${badSdkId}\n`,
        'dist/web/build.json': webBuildInfo(badSdkId),
        'dist/web/index.html': '<!doctype html>\n',
      },
    }),
  };

  log(`packages written after ${seconds(started)} s`);
  const release = await startReleaseServer(key, sdk);
  pending.push(() => release.close());
  const work = await mkdtemp(path.join(os.tmpdir(), 'parallax-e2e-update-'));
  pending.push(() => removeQuietly(work));
  const home = path.join(work, 'home');
  await mkdir(home);
  await mkdir(path.join(work, 'projects'));
  const env = await installationEnv({ work, key, release });
  const root = path.join(E2E_ROOT, 'root');
  const pkgA = packages[A];
  if (pkgA === undefined) throw new Error('no package A');
  await installFirstVersion({ root, pkg: pkgA, key, sdk, env, log: () => undefined });
  log(`${A} installed after ${seconds(started)} s`);
  const port = await freePort();
  const inst: Installation = { root, home, port, origin: originOf(port), work, env };
  // A server started by a launcher that failed afterwards still ends (via the lock file).
  pending.unshift(() => killInstallation(inst, []));
  const { server } = await startInstalled(inst);
  world = { inst, release, key, builds: { a, b }, packages, server, seen: [server], sessionKey: null };
  pending.length = 0;
  log(`installation of ${A} runs on ${inst.origin} after ${seconds(started)} s`);
});

test.afterEach(async () => {
  const testInfo = test.info();
  if (testInfo.status === testInfo.expectedStatus) return;
  failed = true;
  const w = world;
  if (w === null) return;
  await attachText(testInfo, 'server-log.txt', (await w.server.logLines()).slice(-300).join('\n'));
  for (const file of await updateLogs(w.inst.home)) await attachText(testInfo, file.name, file.text);
  for (const name of (await readdir(w.inst.work)).filter((n) => n.startsWith('launcher-'))) {
    await attachText(testInfo, name, await readFile(path.join(w.inst.work, name), 'utf8'));
  }
  await attachText(testInfo, 'release-requests.txt', w.release.requests.join('\n'));
});

test.afterAll(async () => {
  const w = world;
  world = null;
  if (w === null) {
    for (const step of pending.splice(0)) await step();
    return;
  }
  try {
    // The server of the last test stops cleanly: exit, lock file gone, no child, no error line.
    if (!failed) {
      await w.server.requestShutdown();
      await w.server.assertCleanExit();
    }
  } finally {
    await killInstallation(w.inst, w.seen);
    await w.release.close();
    await removeQuietly(w.inst.work);
    if (!failed) await removeQuietly(E2E_ROOT);
  }
});

async function attachText(testInfo: TestInfo, name: string, text: string): Promise<void> {
  const file = testInfo.outputPath(name);
  await writeFile(file, text, 'utf8');
  await testInfo.attach(name, { path: file, contentType: 'text/plain' });
}

/** Release offered by the release server for a package (zip, its changelog, its notes). */
async function offerOf(pkg: TestPackage | undefined): Promise<OfferedRelease> {
  if (pkg === undefined) throw new Error('unknown package');
  const zip = await pkg.zip();
  return {
    version: pkg.version,
    zip: zip.bytes,
    changelog: changelogUpTo(pkg.version, VERSIONS),
    notes: notesOf(pkg.version),
  };
}

/** Notes when the "Parallax restarts" banner shows in any document of the context (also across a reload). */
async function recordRestartBanner(context: BrowserContext): Promise<{ seen: () => boolean }> {
  let seen = false;
  await context.exposeFunction('__e2eRestartBanner', () => {
    seen = true;
  });
  await context.addInitScript(() => {
    let reported = false;
    const check = () => {
      if (reported || document.querySelector('[data-slot="restart-banner"]') === null) return;
      reported = true;
      void window.__e2eRestartBanner?.();
    };
    new MutationObserver(check).observe(document, { subtree: true, childList: true });
  });
  return { seen: () => seen };
}

declare global {
  interface Window {
    /** update.spec.ts: the restart banner showed (exposed function, survives the reload). */
    __e2eRestartBanner?: () => Promise<void>;
  }
}

async function openApp(page: Page, server: E2eServer): Promise<ParallaxApp> {
  return new ParallaxApp(page, server).open();
}

/** Settings page, section "Updates". */
async function updatesSection(app: ParallaxApp): Promise<Locator> {
  await app.openSettingsPage('updates');
  const section = app.page.locator('[data-slot="updates-settings"]');
  await expect(section).toBeVisible();
  return section;
}

async function closeSettings(page: Page): Promise<void> {
  await page.keyboard.press('Escape');
  await expect(page.locator('[data-slot="settings-page"]')).toBeHidden();
}

function statusOf(section: Locator): Locator {
  return section.locator('[data-info="status"]');
}

function registryRequests(requests: readonly string[]): string[] {
  return requests.filter((request) => request.startsWith('/registry/'));
}

async function exists(file: string): Promise<boolean> {
  return access(file).then(
    () => true,
    () => false,
  );
}

/** "Restart now" / "Back to …" → confirmation → the server of the next version (no process left). */
async function confirmSwitch(page: Page, section: Locator, kind: 'apply' | 'rollback'): Promise<void> {
  const w = need();
  await section.locator(`[data-action="${kind === 'apply' ? 'update-restart' : 'update-rollback'}"]`).click();
  const dialog = page.locator(`[data-slot="update-switch"][data-kind="${kind}"]`);
  await expect(dialog).toBeVisible();
  await dialog.locator('[data-action="update-switch-confirm"]').click();
  const next = await waitForRestart(w.inst, w.server);
  w.server = next;
  w.seen.push(next);
}

test('404 on latest.json: "Check now" finds no update', async ({ page }) => {
  const w = need();
  w.release.offer(null);
  const app = await openApp(page, w.server);
  const section = await updatesSection(app);
  await expect(section.locator('[data-info="version"]')).toHaveText(`Parallax ${A}`);
  await expect(section.locator('[data-info="build"]')).toHaveText(`Build ${w.builds.a.buildId}`);
  // No automatic check during the run (60 s after each start): the switch goes off and stays off.
  const auto = section.locator('[data-block="auto-check"] [role="switch"]');
  await expect(auto).toHaveAttribute('aria-checked', 'true');
  await auto.click();
  await expect(auto).toHaveAttribute('aria-checked', 'false');
  await expect.poll(async () => (await serverSettings(w.server)).updates.check).toBe(false);

  await expect(section.locator('[data-info="checked"]')).toHaveText('Not checked yet.');
  await section.locator('[data-action="update-check"]').click();
  await expect(section.locator('[data-info="checked"]')).toHaveText(/^Last checked /);
  await expect(statusOf(section)).toHaveText('Parallax is up to date.');
  await expect(section.locator('[data-slot="update-error"]')).toHaveCount(0);
  await expect(section.locator('[data-action="update-prepare"]')).toHaveCount(0);
  expect(w.release.requests).toContain('/releases/latest/download/latest.json');
  await closeSettings(page);
  await expect(page.locator(NOTICE)).toHaveCount(0);
});

test('update: hint → prepare → restart → "restarting" → reload → "Updated to 9.9.1"', async ({
  page,
  context,
}) => {
  test.setTimeout(300_000);
  const w = need();
  const banner = await recordRestartBanner(context);
  const app = await openApp(page, w.server);
  // Data from before the switch: a session with a turn.
  const session = await app.newSession(await w.server.makeProject('before-update'));
  await session.send('before the update');
  await expect(session.assistantText('Echo: before the update')).toBeVisible();
  w.sessionKey = await app.selectedSessionKey();

  w.release.offer(await offerOf(w.packages[B]));
  let section = await updatesSection(app);
  await section.locator('[data-action="update-check"]').click();
  await expect(statusOf(section)).toHaveText(`Parallax ${B} is available.`);
  await closeSettings(page);

  // The hint in the sidebar head opens the section.
  const notice = page.locator(NOTICE);
  await expect(notice).toHaveAttribute('data-state', 'available');
  await expect(notice).toContainText(`Parallax ${B} available`);
  await notice.locator('[data-action="open-updates"]').click();
  section = page.locator('[data-slot="updates-settings"]');
  await expect(section).toBeVisible();
  await section.locator('[data-action="update-prepare"]').click();
  await expect(statusOf(section)).toHaveText(`Parallax ${B} is ready. Restart to switch.`, {
    timeout: 120_000,
  });
  // The SDK came from <root>\cache (filled when A was staged): no registry request.
  expect(registryRequests(w.release.requests)).toEqual([]);
  await closeSettings(page);
  await expect(notice).toHaveAttribute('data-state', 'ready');
  await notice.locator('[data-action="open-updates"]').click();
  await expect(section).toBeVisible();

  const reloaded = page.waitForEvent('load', { timeout: 240_000 });
  await confirmSwitch(page, section, 'apply');
  await reloaded;
  expect(banner.seen(), 'the "Parallax is restarting" banner').toBe(true);
  await app.waitConnected();
  const done = page.locator('[data-slot="update-done"]');
  await expect(done).toHaveAttribute('data-direction', 'forward');
  await expect(done).toContainText(`Updated to Parallax ${B}`);

  // What's new: the sections after 9.9.0 from the installed CHANGELOG.md.
  await done.locator('[data-action="update-whats-new"]').click();
  const whatsNew = page.locator('[data-slot="whats-new"]');
  await expect(whatsNew).toContainText(`Testversion ${B} des Update-E2E.`);
  await expect(whatsNew).not.toContainText(`Testversion ${A} des Update-E2E.`);
  await page.keyboard.press('Escape');
  await expect(whatsNew).toBeHidden();

  expect((await readCurrentFile(w.inst.root)).json).toEqual({ schemaVersion: 1, version: B, previous: A });
  expect(await exists(path.join(w.inst.home, UPDATE_RESULT_FILE)), 'marker consumed').toBe(false);
  expect(await readLastBuildId(w.inst.home)).toBe(w.builds.b.buildId);
  if (w.sessionKey !== null) await expect(app.row(w.sessionKey)).toBeVisible();
  section = await updatesSection(app);
  await expect(section.locator('[data-info="version"]')).toHaveText(`Parallax ${B}`);
  await expect(section.locator('[data-info="build"]')).toHaveText(`Build ${w.builds.b.buildId}`);
  await expect(section.locator('[data-action="update-rollback"]')).toHaveText(`Back to ${A}`);
});

test('"Back to 9.9.0" switches back and reloads the window', async ({ page, context }) => {
  test.setTimeout(240_000);
  const w = need();
  const banner = await recordRestartBanner(context);
  const app = await openApp(page, w.server);
  await page.locator('[data-action="dismiss-update-done"]').click();
  await expect(page.locator('[data-slot="update-done"]')).toHaveCount(0);
  const section = await updatesSection(app);
  const reloaded = page.waitForEvent('load', { timeout: 240_000 });
  await confirmSwitch(page, section, 'rollback');
  await reloaded;
  expect(banner.seen(), 'the "Parallax is restarting" banner').toBe(true);
  await app.waitConnected();
  const done = page.locator('[data-slot="update-done"]');
  await expect(done).toHaveAttribute('data-direction', 'back');
  await expect(done).toContainText(`Switched to Parallax ${A} (was ${B})`);
  expect((await readCurrentFile(w.inst.root)).json).toEqual({ schemaVersion: 1, version: A, previous: B });
  expect(await readLastBuildId(w.inst.home)).toBe(w.builds.a.buildId);
  if (w.sessionKey !== null) await expect(app.row(w.sessionKey)).toBeVisible();
});

test('B-broken: the orchestrator goes back – failedUpdate, current.json and data unchanged', async ({
  page,
  context,
}) => {
  test.setTimeout(300_000);
  const w = need();
  const banner = await recordRestartBanner(context);
  w.release.offer(await offerOf(w.packages[BROKEN]));
  const app = await openApp(page, w.server);
  const section = await updatesSection(app);
  await section.locator('[data-action="update-check"]').click();
  await expect(statusOf(section)).toHaveText(`Parallax ${BROKEN} is available.`);
  await section.locator('[data-action="update-prepare"]').click();
  await expect(statusOf(section)).toHaveText(`Parallax ${BROKEN} is ready. Restart to switch.`, {
    timeout: 120_000,
  });
  const current = await readCurrentFile(w.inst.root);
  expect(current.json).toEqual({ schemaVersion: 1, version: A, previous: B });

  await confirmSwitch(page, section, 'apply');
  await app.waitConnected();
  expect(banner.seen(), 'the "Parallax is restarting" banner').toBe(true);
  await closeSettings(page);
  const failedBanner = page.locator('[data-slot="update-failed"]');
  await expect(failedBanner).toContainText(`Update to Parallax ${BROKEN} failed – back on ${A}`);
  await expect(failedBanner.locator('[data-slot="update-error-detail"]')).toHaveText(
    'The new version stopped right after its start.',
  );
  const logPath = (await failedBanner.locator('[data-slot="update-log"] .font-mono').textContent()) ?? '';
  expect(path.dirname(logPath).toLowerCase()).toBe(path.join(w.inst.home, 'logs').toLowerCase());
  expect(await readFile(logPath, 'utf8')).toContain(BROKEN);

  // Back exactly: current.json byte for byte, the data of version A (session, setting, last version).
  expect((await readCurrentFile(w.inst.root)).text).toBe(current.text);
  expect(await readLastBuildId(w.inst.home)).toBe(w.builds.a.buildId);
  expect(await exists(path.join(w.inst.home, UPDATE_RESULT_FILE)), 'marker consumed').toBe(false);
  expect((await serverSettings(w.server)).updates.check).toBe(false);
  if (w.sessionKey !== null) await expect(app.row(w.sessionKey)).toBeVisible();
  const again = await updatesSection(app);
  await expect(again.locator('[data-info="version"]')).toHaveText(`Parallax ${A}`);
});

test('upload of a foreign file → UPDATE_INVALID_PACKAGE', async ({ page }) => {
  const w = need();
  const app = await openApp(page, w.server);
  const section = await updatesSection(app);
  await section.locator('[data-slot="update-file-input"]').setInputFiles({
    name: 'not-a-package.zip',
    mimeType: 'application/zip',
    buffer: Buffer.from('This is a text file, not a Parallax package.\n', 'utf8'),
  });
  const error = section.locator('[data-slot="update-error"][data-code="UPDATE_INVALID_PACKAGE"]');
  await expect(error).toBeVisible({ timeout: 60_000 });
  await expect(error.locator('[data-slot="update-error-detail"]')).toHaveText(
    'The file is not a readable zip archive.',
  );
  await expect(statusOf(section)).toHaveText('Parallax is up to date.');
  // The upload is gone from <root>\downloads.
  await expect
    .poll(async () => (await readdir(path.join(w.inst.root, 'downloads')).catch((): string[] => [])).length)
    .toBe(0);
});

test('upload of a package with a wrong SDK hash → UPDATE_SDK_FAILED', async ({ page }) => {
  test.setTimeout(180_000);
  const w = need();
  const app = await openApp(page, w.server);
  const section = await updatesSection(app);
  const pkg = w.packages[BAD_SDK];
  if (pkg === undefined) throw new Error('no package with a wrong SDK hash');
  const zip = await pkg.zip();
  const before = w.release.requests.length;
  await section.locator('[data-slot="update-file-input"]').setInputFiles(zip.file);
  const error = section.locator('[data-slot="update-error"][data-code="UPDATE_SDK_FAILED"]');
  await expect(error).toBeVisible({ timeout: 120_000 });
  await expect(statusOf(section)).toHaveText('Parallax is up to date.');
  expect(await exists(path.join(w.inst.root, 'versions', BAD_SDK)), 'nothing staged').toBe(false);
  // The cache did not match – the SDK came from the (fake) registry and failed its check.
  const asked = registryRequests(w.release.requests.slice(before));
  expect(asked).toContain('/registry/@anthropic-ai%2Fclaude-agent-sdk');
  expect(asked.some((request) => request.startsWith('/registry/sdk/'))).toBe(true);
});
