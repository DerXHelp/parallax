/**
 * Live smoke (WP-22, Plan B "Tests ohne Token-Verbrauch" level 5, docs/sdk-upgrade.md): the core
 * flows of the Phase-1 verification against the INSTALLED `claude` with `--backend=sdk`, Haiku and
 * the subscription login. Runs only with `PARALLAX_LIVE=1`:
 *
 *   $env:PARALLAX_LIVE='1'; pnpm e2e e2e/live
 *
 * One server for the file (serial), mini prompts, a budget guard (support/live.ts). The flows: the
 * displayed CLI version = `claude --version`; a permission card → "Allow once" → the real file;
 * subscription + Haiku after the first turn; an AskUserQuestion card; Stop during a running tool;
 * reload with an open card; no contract slip of real SDK data in the server log; clean shutdown
 * (fixture teardown: exit, lock file gone, no child process, no error line).
 */
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { ParallaxApp, type SessionView } from '../support/app';
import { expect, test as base } from '../support/fixtures';
import {
  LIVE,
  assertBudget,
  assertSubscriptionHaiku,
  claudeVersion,
  collectUnknownCounts,
  liveCostUsd,
  startLiveServer,
  validationDrops,
  type LiveServer,
} from './support/live';

/** A live turn (start, model, tools) – generous, the CLI starts cold after a reboot/virus scan. */
const TURN_MS = 150_000;

const test = base.extend<object, { live: LiveServer }>({
  live: [
    // eslint-disable-next-line no-empty-pattern -- Playwright requires the object pattern
    async ({}, use, workerInfo) => {
      const live = await startLiveServer();
      try {
        await use(live);
      } finally {
        // The temp home is removed by stop(): keep the usage estimate (and the log) as artifacts.
        await mkdir(workerInfo.project.outputDir, { recursive: true });
        const cost = await liveCostUsd(live.server.home);
        await writeFile(
          path.join(workerInfo.project.outputDir, 'live-cost.txt'),
          `estimated cost of this live run: ${cost.toFixed(4)} USD (turn_result.costUsdTotal)\n`,
        );
        await live.server.stop(async (lines) => {
          await writeFile(
            path.join(workerInfo.project.outputDir, 'server-live.log'),
            `${lines.join('\n')}\n`,
          );
        });
      }
    },
    { scope: 'worker', timeout: 120_000 },
  ],
});

test.describe.configure({ mode: 'serial' });
test.skip(!LIVE, 'live smoke only with PARALLAX_LIVE=1 (real claude, subscription login, Haiku)');
test.setTimeout(4 * TURN_MS);

/** The session of the file (serial tests share it: one process, cheap cache reads). */
let sessionKey: string | null = null;

/** Normalizer `unknownCounts` seen in the WS frames (docs/sdk-upgrade.md step 6). */
const unknownCounts: Record<string, number> = {};

async function openApp(page: ParallaxApp['page'], live: LiveServer): Promise<ParallaxApp> {
  page.on('websocket', (socket) => {
    socket.on('framereceived', (frame) => {
      collectUnknownCounts(frame.payload, unknownCounts);
    });
  });
  return new ParallaxApp(page, live.server).open(sessionKey === null ? '' : `session=${sessionKey}`);
}

async function currentSession(app: ParallaxApp): Promise<SessionView> {
  if (sessionKey === null) throw new Error('no live session (the first test failed)');
  const session = app.session(sessionKey);
  await expect(session.pane).toBeVisible();
  return session;
}

/** Waits for an armed card of `kind` (the 600 ms arm delay, WP-16) with the live timeout. */
async function armedCard(session: SessionView, kind: 'permission' | 'question' | 'plan') {
  await expect(session.card).toHaveAttribute('data-decision-kind', kind, { timeout: TURN_MS });
  await expect(session.card).toHaveAttribute('data-armed', 'true');
  return session.card;
}

async function sendLive(live: LiveServer, session: SessionView, text: string): Promise<void> {
  await assertBudget(live.server.home);
  await session.send(text);
}

/**
 * "Manual" (`default`) BEFORE the first prompt: without a mode the CLI decides, and that default
 * changed during WP-22 from `default` to `auto` (no card at all – docs/wp/WP-22.md, WP22-04).
 */
async function chooseManualMode(app: ParallaxApp, session: SessionView): Promise<void> {
  await session.composerRoot.getByRole('button', { name: /^(Permission mode|Berechtigungsmodus)/ }).click();
  await app.page.getByRole('menuitemradio', { name: /^Manual/ }).click();
  await expect(session.composerRoot.getByRole('button', { name: /Manual/ })).toBeVisible();
}

/** A tool either asks (card → "Allow once") or runs right away (rule/mode) – both are fine here. */
async function allowIfAsked(session: SessionView): Promise<void> {
  const running = session.transcript.locator('[data-item-kind="tool_call"][data-status="running"]');
  await expect(session.card.or(running).first()).toBeVisible({ timeout: TURN_MS });
  if ((await session.card.count()) > 0) {
    const card = await armedCard(session, 'permission');
    await card.locator('[data-action="allow-once"]').click();
  }
}

test('the displayed claude version equals `claude --version`', async ({ page, live }) => {
  const app = await openApp(page, live);
  const menu = await app.openSettings();
  const info = menu.locator('[data-slot="host-info"] [data-info="claude"]');
  await expect(info).toContainText(/Claude Code \d+\.\d+\.\d+/, { timeout: 60_000 });
  const shown = /Claude Code (\d+\.\d+\.\d+)/.exec((await info.textContent()) ?? '')?.[1];
  const executable = (await info.locator('.font-mono').textContent())?.trim() ?? '';
  expect(path.isAbsolute(executable), executable).toBe(true);
  expect(shown).toBe(await claudeVersion(executable, live.root));
  await page.keyboard.press('Escape');
});

test('permission "Allow once" writes the real file; subscription login + Haiku', async ({ page, live }) => {
  const app = await openApp(page, live);
  const cwd = await live.server.makeProject('permission');
  const session = await app.newSession(cwd);
  sessionKey = session.key;
  await chooseManualMode(app, session);
  await sendLive(live, session, 'lege test.txt mit dem Inhalt hallo an');
  const card = await armedCard(session, 'permission');
  await expect(card).toContainText('test.txt');
  await card.locator('[data-action="allow-once"]').click();
  await session.expectStatus('idle', TURN_MS);
  expect((await readFile(path.join(cwd, 'test.txt'), 'utf8')).trim()).toBe('hallo');

  // Guard before any further prompt: subscription (apiKeySource none) and Haiku, else STOP.
  const { cliVersion } = await assertSubscriptionHaiku(live.server.home, session.entryId);
  await expect(session.header.locator('[data-slot="header-model"]')).toContainText(/haiku/i);
  // The actual mode reported by the CLI (C.3): the one chosen before the first prompt.
  await expect(session.header.locator('[data-slot="header-mode"]')).toHaveText('Manual');
  if (cliVersion !== null) {
    await expect(session.header.locator('[data-slot="header-cli-version"]')).toContainText(cliVersion);
  }
});

test('an AskUserQuestion card can be answered', async ({ page, live }) => {
  const app = await openApp(page, live);
  const session = await currentSession(app);
  await sendLive(
    live,
    session,
    'Benutze das AskUserQuestion-Tool und frag mich, ob ich Rot oder Blau bevorzuge (genau zwei Optionen). ' +
      'Antworte danach nur mit meiner Wahl.',
  );
  const card = await armedCard(session, 'question');
  const option = card.getByRole('radio').nth(1);
  const label = ((await option.getAttribute('aria-label')) ?? (await option.textContent()) ?? '').trim();
  await option.click();
  const answer = card.locator('[data-action="answer"]');
  await expect(answer).toBeEnabled();
  await answer.click();
  await session.expectStatus('idle', TURN_MS);
  await expect(session.toolCall('AskUserQuestion').last()).toContainText('Answered');
  const word = /Blau|Rot|Blue|Red/i.exec(label)?.[0];
  if (word !== undefined) await expect(session.assistantText(new RegExp(word, 'i')).last()).toBeVisible();
});

test('Stop interrupts a running tool', async ({ page, live }) => {
  const app = await openApp(page, live);
  const session = await currentSession(app);
  await sendLive(
    live,
    session,
    'Führe mit dem PowerShell-Tool genau diesen Befehl aus: ping -n 30 127.0.0.1 | Out-Null — danach antworte nur mit FERTIG.',
  );
  await allowIfAsked(session);
  await expect(session.transcript.locator('[data-item-kind="tool_call"][data-status="running"]')).toHaveCount(
    1,
    {
      timeout: TURN_MS,
    },
  );
  await session.composerRoot.locator('[data-action="stop"]').click();
  await expect(session.composerRoot.locator('[data-action="stop"]')).toHaveCount(0, { timeout: 30_000 });
  await expect(session.transcript.locator('[data-item-kind="turn_result"]').last()).toContainText(
    'Interrupted',
  );
  await expect(session.header).not.toHaveAttribute('data-status', 'working');
});

test('a reload keeps the open card; it can be answered afterwards', async ({ page, live }) => {
  const app = await openApp(page, live);
  const session = await currentSession(app);
  await sendLive(
    live,
    session,
    'Führe mit dem PowerShell-Tool genau diesen Befehl aus: Set-Content -Path reload.txt -Value reload',
  );
  const card = await armedCard(session, 'permission');
  const decisionId = await card.getAttribute('data-decision-id');
  await page.reload();
  await app.waitConnected();
  const again = app.session(session.key);
  const restored = await armedCard(again, 'permission');
  expect(await restored.getAttribute('data-decision-id')).toBe(decisionId);
  await restored.locator('[data-action="deny"]').click();
  await expect(again.card).toHaveCount(0);
  await again.expectStatus('idle', TURN_MS);
});

test('real SDK data: no contract slip in the server log; usage within the budget', async ({ live }) => {
  const drops = await validationDrops(live.server);
  const cost = await liveCostUsd(live.server.home);
  test.info().annotations.push({ type: 'live-cost-usd', description: cost.toFixed(4) });
  test.info().annotations.push({ type: 'validation-drops', description: String(drops.length) });
  // Informational: new keys are candidates for the normalizer/contract (not a failure).
  test.info().annotations.push({ type: 'unknown-counts', description: JSON.stringify(unknownCounts) });
  await writeFile(
    test.info().outputPath('unknown-counts.json'),
    `${JSON.stringify(unknownCounts, null, 2)}\n`,
  );
  expect(drops, 'invalid outgoing values / transcript lines (R3-05)').toEqual([]);
  await assertBudget(live.server.home);
});
