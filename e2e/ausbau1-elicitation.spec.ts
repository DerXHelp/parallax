/**
 * WP-117 (Ausbau 1): input requests of MCP servers (elicitation; card WP-116, server WP-112) with the
 * FakeBackend keywords of `backend/fake/elicit.ts`:
 * - `fake:elicit-form` – the card in the decision bar (status "needs answer"), four fields (text,
 *   integer with default, choice, yes/no); "Send" with the required field empty sends nothing and
 *   marks the field; filled in → the card goes, the fake MCP tool reports the accepted content;
 *   a second form → "Cancel" → cancelled;
 * - `fake:elicit-unsupported` – a form outside the subset: the reason and only "Decline";
 * - `fake:elicit-url` – the url card (host on its own line, the server's message); the fake server
 *   finishes the request after at most 3 s (`elicitation_complete`), the card closes by itself with
 *   the hint "… was closed" (noted by a page recorder – the card lives only those seconds);
 * - "Cancel" on the url card answers cancel (the server's ack says `cancelled {reason: 'user'}`). The
 *   click races the fake server's 3 s: a lost race (the card closed first) starts another request,
 *   at most three (docs/wp/WP-117.md, E2E).
 * Own server (worker) for the file.
 */
import type { Locator, Page } from '@playwright/test';
import { z } from 'zod';
import { ParallaxApp, type SessionView } from './support/app';
import { recordTexts, seenTexts } from './support/files';
import { expect, test } from './support/fixtures';

test.use({ ownServer: 'a1elicit' });

const sentRespondSchema = z.object({
  type: z.literal('cmd'),
  cmdId: z.string(),
  cmd: z.object({
    name: z.literal('decision.respond'),
    response: z.object({ kind: z.literal('elicitation'), response: z.object({ action: z.string() }) }),
  }),
});
const ackSchema = z.object({
  type: z.literal('ack'),
  cmdId: z.string(),
  ok: z.boolean(),
  result: z.object({ outcome: z.object({ type: z.string(), reason: z.string().optional() }) }).optional(),
});

interface RecordedResponse {
  action: string;
  /** The outcome of an accepted answer (`type` or `type:reason`); null = refused or no ack yet. */
  outcome: string | null;
}

/** The elicitation answers the page sends and the outcomes the server acks (register before opening). */
function recordElicitationResponses(page: Page): RecordedResponse[] {
  const responses: RecordedResponse[] = [];
  const byCmd = new Map<string, RecordedResponse>();
  const parse = (payload: string | Buffer): unknown => {
    try {
      return JSON.parse(typeof payload === 'string' ? payload : payload.toString('utf8'));
    } catch {
      return null;
    }
  };
  page.on('websocket', (socket) => {
    socket.on('framesent', (frame) => {
      const sent = sentRespondSchema.safeParse(parse(frame.payload));
      if (!sent.success) return;
      const entry = { action: sent.data.cmd.response.response.action, outcome: null };
      responses.push(entry);
      byCmd.set(sent.data.cmdId, entry);
    });
    socket.on('framereceived', (frame) => {
      const ack = ackSchema.safeParse(parse(frame.payload));
      if (!ack.success) return;
      const entry = byCmd.get(ack.data.cmdId);
      const outcome = ack.data.result?.outcome;
      if (entry === undefined || !ack.data.ok || outcome === undefined) return;
      entry.outcome = outcome.reason === undefined ? outcome.type : `${outcome.type}:${outcome.reason}`;
    });
  });
  return responses;
}

/** The open elicitation card once its arm delay is over (only then a click answers). */
async function armedElicitation(session: SessionView): Promise<Locator> {
  await expect(session.card).toHaveAttribute('data-decision-kind', 'elicitation');
  await expect(session.card).toHaveAttribute('data-armed', 'true');
  return session.card;
}

test('form elicitation: required field, send → accepted; cancel; unsupported form → decline only', async ({
  app,
  server,
}) => {
  const session = await app.newSession(await server.makeProject('elicit-form'));
  await session.send('fake:elicit-form');
  const card = await armedElicitation(session);
  await session.expectStatus('needs-answer');
  await expect(card.locator('[data-slot="elicitation-message"]')).toHaveText(
    'Fake: please fill in the reservation.',
  );
  const fields = card.locator('[data-slot="elicitation-field"]');
  await expect(fields).toHaveCount(4);
  const name = fields.nth(0).locator('input');
  const guests = fields.nth(1).locator('input');
  await expect(guests).toHaveValue('2');

  // "Send" with the required name empty: nothing is sent, the field says why and gets the focus.
  await card.locator('[data-action="send"]').click();
  await expect(fields.nth(0).locator('[data-slot="elicitation-error"]')).toBeVisible();
  await expect(name).toHaveAttribute('aria-invalid', 'true');
  await expect(name).toBeFocused();
  await expect(session.card).toHaveCount(1);

  // Filled in: name, 3 guests, 7 pm, vegetarian → accepted with exactly that.
  await name.fill('Ada Example');
  await guests.fill('3');
  await fields.nth(2).getByLabel('7 pm').click();
  await fields.nth(3).getByRole('checkbox').click();
  await card.locator('[data-action="send"]').click();
  await expect(session.card).toHaveCount(0);
  const accepted = session.assistantText(/Fake: accepted with/);
  await expect(accepted).toContainText('"name":"Ada Example"');
  await expect(accepted).toContainText('"guests":3');
  await expect(accepted).toContainText('"time":"19:00"');
  await expect(accepted).toContainText('"vegetarian":true');
  await session.expectStatus('idle');

  // A second form: "Cancel" answers cancel.
  await session.send('fake:elicit-form');
  await (await armedElicitation(session)).locator('[data-action="cancel"]').click();
  await expect(session.card).toHaveCount(0);
  await expect(session.assistantText('Fake: cancelled.')).toBeVisible();

  // Outside the subset (multi-select): the reason and "Decline" only.
  await session.send('fake:elicit-unsupported');
  const unsupported = await armedElicitation(session);
  await expect(unsupported.locator('[data-slot="elicitation-unsupported"]')).toBeVisible();
  await expect(unsupported.locator('[data-action="send"]')).toHaveCount(0);
  await unsupported.locator('[data-action="decline"]').click();
  await expect(session.card).toHaveCount(0);
  await expect(session.assistantText('Fake: declined.')).toBeVisible();
});

test('url elicitation: the card shows host and message; the server finishes the request and the card closes', async ({
  app,
  server,
  page,
}) => {
  const session = await app.newSession(await server.makeProject('elicit-url'));
  await recordTexts(
    page,
    '[data-slot="elicitation-url-host"], [data-slot="elicitation-message"], [data-slot="notification-center"] [data-notice]',
  );
  await session.send('fake:elicit-url');
  await expect(session.assistantText('Fake: the sign-in finished.')).toBeVisible();
  await expect(session.card).toHaveCount(0);
  await expect.poll(() => seenTexts(page)).toContain('auth.example');
  const seen = await seenTexts(page);
  expect(seen).toContain('Fake: sign in to continue.');
  await expect
    .poll(async () =>
      (await seenTexts(page)).some((text) =>
        text.includes('The request for input from fake-mcp was closed.'),
      ),
    )
    .toBe(true);
  await session.expectStatus('idle');
});

test('url elicitation: "Cancel" answers cancel before the server finishes', async ({ server, page }) => {
  const responses = recordElicitationResponses(page);
  const app = await new ParallaxApp(page, server).open();
  const session = await app.newSession(await server.makeProject('elicit-url-cancel'));
  const finished = session.assistantText('Fake: the sign-in finished.');
  let cancelled = false;
  for (let attempt = 1; attempt <= 3 && !cancelled; attempt++) {
    await session.send('fake:elicit-url');
    const card = await armedElicitation(session);
    await expect(card.locator('[data-slot="elicitation-url-host"]')).toHaveText('auth.example');
    await expect(card.locator('[data-action="open-url"]')).toBeVisible();
    // The fake server closes the request after at most 3 s – a click after that finds no card.
    await card
      .locator('[data-action="cancel"]')
      .click({ timeout: 3_000 })
      .catch(() => undefined);
    await expect(finished).toHaveCount(attempt);
    await session.expectStatus('idle');
    cancelled = responses.some((r) => r.action === 'cancel' && r.outcome === 'cancelled:user');
  }
  expect(cancelled, 'one "Cancel" reached the server before it finished the request').toBe(true);
  await expect(session.card).toHaveCount(0);
});
