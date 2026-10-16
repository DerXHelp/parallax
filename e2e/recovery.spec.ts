/**
 * Recovery paths that WP-22 could not check live (WP-22 F3/F5), against the FakeBackend:
 * - F5: `claude.exe` crashes during a turn → status `error` with the error item; no automatic
 *   restart (work was in progress, A.10) – the next prompt starts the process again ("Neu
 *   starten" = send).
 * - F3: a plan card is open when the server stops ("Server beenden") → after the restart on the
 *   same PARALLAX_HOME the session is `needs-resume` with the expired card; "Continue & implement"
 *   resumes the session with the implementation prompt.
 */
import { ParallaxApp } from './support/app';
import { expect, keepServerLog, test } from './support/fixtures';
import { startE2eServer, type E2eServer } from './support/server';

let own: E2eServer | null = null;

test.afterEach(async () => {
  await own?.stop(keepServerLog(test.info()));
  own = null;
});

test('F5: a crash during a turn → error with the reason; the next prompt starts claude again', async ({
  app,
  server,
}) => {
  const session = await app.newSession(await server.makeProject('crash'));
  await session.send('fake:crash now');
  await session.expectStatus('error');
  await expect(session.transcript.getByText('The Claude Code process ended unexpectedly.')).toBeVisible();
  // No automatic restart after a crash while working (no double side effects, A.10).
  await expect(session.toolCall('Bash')).toHaveAttribute('data-status', 'interrupted');
  await session.send('hello after the crash');
  await expect(session.assistantText('Echo: hello after the crash')).toBeVisible();
  await session.expectStatus('idle');
});

test('F3: a plan card open at "Stop server" → needs-resume after the restart; continue & implement', async ({
  page,
}) => {
  const first = await startE2eServer({ label: 'f3' });
  own = first;
  const app = await new ParallaxApp(page, first).open();
  const session = await app.newSession(await first.makeProject('plan'));
  await session.send('fake:plan make hello.txt');
  await session.armedCard('plan');

  await first.requestShutdown();
  await first.assertCleanExit();
  await expect(page.getByRole('heading', { name: 'Parallax server stopped' })).toBeVisible();

  // Same data folder, new server process (new FakeBackend, the session is dormant).
  const second = await startE2eServer({ label: 'f3', reuse: first });
  own = second;
  const again = await new ParallaxApp(page, second).open(`session=${session.key}`);
  const view = again.session(session.key);
  await expect(view.pane).toBeVisible();
  await view.expectStatus('needs-resume');
  await expect(view.card).toHaveAttribute('data-decision-kind', 'plan');
  await expect(view.card).toContainText('Expired');
  await expect(view.card).toHaveAttribute('data-armed', 'true');
  const approve = view.card.locator('[data-action="approve"]');
  await expect(approve).toContainText('Continue & implement');
  await approve.click();

  await expect(view.card).toHaveCount(0);
  await expect(view.assistantText(/Echo: Implement the plan/)).toBeVisible();
  await view.expectStatus('idle');
});
