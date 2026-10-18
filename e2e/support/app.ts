/**
 * Page objects of the Parallax UI for the E2E tests. Selectors are the test attributes of WP-14/15/16
 * and WP-20b (docs/wp/WP-20b.md §2.12): `data-slot`, `data-action`, `data-session-key`,
 * `data-decision-id`, `data-item-kind` … – texts only where the text is the thing under test.
 */
import { expect, type Locator, type Page } from '@playwright/test';
import type { E2eServer } from './server';

export class ParallaxApp {
  constructor(
    readonly page: Page,
    readonly server: E2eServer,
  ) {}

  /** Opens a fresh sign-in URL (`/#code=…`, like the launcher) and waits for the live connection. */
  async open(hash = ''): Promise<this> {
    await this.page.goto(await this.server.loginUrl(hash));
    await this.waitConnected();
    return this;
  }

  connection(): Locator {
    return this.page.locator('[data-slot="connection-indicator"]');
  }

  async waitConnected(): Promise<void> {
    await expect(this.connection()).toHaveAttribute('data-status', 'open');
  }

  /** The selected session from `#session=…`, or null. */
  async selectedSessionKey(): Promise<string | null> {
    const hash = await this.page.evaluate(() => window.location.hash);
    const match = /(?:^#|&)session=([^&]+)/.exec(hash);
    return match?.[1] === undefined ? null : decodeURIComponent(match[1]);
  }

  /** "New session" from the sidebar (dialog) for `cwd`; returns the new, selected session. */
  async newSession(cwd: string): Promise<SessionView> {
    await this.page.locator('[data-action="new-session"]').click();
    const dialog = this.page.locator('[data-slot="new-session-dialog"]');
    await expect(dialog).toBeVisible();
    await dialog.locator('input[name="cwd"]').fill(cwd);
    await dialog.locator('button[type="submit"]').click();
    await expect(dialog).toBeHidden();
    const key = await this.waitForSelection((k) => k !== null);
    const session = this.session(key);
    await expect(session.pane).toBeVisible();
    // focusSessionInput: the composer of the new session gets the focus (user action).
    await expect(session.composer).toBeFocused();
    return session;
  }

  /** Waits until `#session=` satisfies `accept`. */
  async waitForSelection(accept: (key: string | null) => boolean): Promise<string> {
    await expect.poll(async () => accept(await this.selectedSessionKey())).toBe(true);
    const key = await this.selectedSessionKey();
    if (key === null) throw new Error('no session selected');
    return key;
  }

  session(sessionKey: string): SessionView {
    return new SessionView(this.page, sessionKey);
  }

  /** Selects a session through its sidebar row. */
  async selectSession(sessionKey: string): Promise<SessionView> {
    await this.page.locator(`[data-session-row="${sessionKey}"]`).click();
    const session = this.session(sessionKey);
    await expect(session.pane).toBeVisible();
    return session;
  }

  /** Opens the settings menu (gear in the sidebar). */
  async openSettings(): Promise<Locator> {
    await this.page.getByRole('button', { name: /^(Settings|Einstellungen)$/ }).click();
    const menu = this.page.getByRole('menu');
    await expect(menu).toBeVisible();
    return menu;
  }

  notices(): Locator {
    return this.page.locator('[data-slot="notification-center"] [data-notice]');
  }

  // ---- Phase 2 (WP-35 sidebar, WP-38 settings page; WP-40) ----

  /** The session list of the sidebar (`data-view` = flat | grouped | archive). */
  sidebar(): Locator {
    return this.page.getByRole('navigation', { name: 'Sessions' });
  }

  /** The row button of a session in the sidebar. */
  row(sessionKey: string): Locator {
    return this.page.locator(`[data-session-row="${sessionKey}"]`);
  }

  /** Display status of a sidebar row (`data-status` of its status icon). */
  rowStatus(sessionKey: string): Locator {
    return this.row(sessionKey).locator('[data-slot="status-icon"]');
  }

  /** Session keys of the sidebar rows in their visible order. */
  async rowKeys(): Promise<string[]> {
    return this.sidebar()
      .locator('[data-session-row]')
      .evaluateAll((rows) => rows.map((row) => row.getAttribute('data-session-row') ?? ''));
  }

  /** Right click on a session row: its context menu (WP-35). */
  async rowMenu(sessionKey: string): Promise<Locator> {
    await this.row(sessionKey).click({ button: 'right' });
    const menu = this.page.locator(`[data-session-menu="${sessionKey}"]`);
    await expect(menu).toBeVisible();
    return menu;
  }

  /** "Settings…" in the settings menu → the settings page (WP-38), optionally on a section. */
  async openSettingsPage(section?: string): Promise<Locator> {
    const menu = await this.openSettings();
    await menu.locator('[data-action="open-settings"]').click();
    const page = this.page.locator('[data-slot="settings-page"]');
    await expect(page).toBeVisible();
    if (section !== undefined) await page.locator(`[role="tab"][data-section="${section}"]`).click();
    return page;
  }
}

export class SessionView {
  readonly pane: Locator;
  readonly header: Locator;
  readonly composerRoot: Locator;
  readonly composer: Locator;
  readonly transcript: Locator;
  readonly bar: Locator;
  readonly card: Locator;

  constructor(
    readonly page: Page,
    readonly key: string,
  ) {
    this.pane = page.locator(`section[data-session-key="${key}"]`);
    this.header = this.pane.locator('[data-slot="session-header"]');
    this.composerRoot = this.pane.locator('[data-slot="composer"]');
    this.composer = this.composerRoot.locator('textarea');
    this.transcript = this.pane.locator('[data-slot="transcript"]');
    this.bar = this.pane.locator('[data-slot="decision-bar"]');
    this.card = this.bar.locator('[data-slot="decision-card"]');
  }

  get entryId(): string {
    return this.key.slice(this.key.indexOf(':') + 1);
  }

  /** Types a message into the composer and sends it with Enter. */
  async send(text: string): Promise<void> {
    await this.composer.click();
    await this.composer.fill(text);
    await this.composer.press('Enter');
  }

  async expectStatus(kind: string, timeout?: number): Promise<void> {
    await expect(this.header).toHaveAttribute('data-status', kind, timeout === undefined ? {} : { timeout });
  }

  /** Waits for the open card of `kind` and its arm delay (600 ms) – only then a click answers. */
  async armedCard(kind: 'permission' | 'question' | 'plan'): Promise<Locator> {
    await expect(this.card).toHaveAttribute('data-decision-kind', kind);
    await expect(this.card).toHaveAttribute('data-armed', 'true');
    return this.card;
  }

  /** The (last) assistant text containing `text`. */
  assistantText(text: string | RegExp): Locator {
    return this.transcript.locator('[data-item-kind="assistant_text"]').filter({ hasText: text });
  }

  userMessages(): Locator {
    return this.transcript.locator('[data-item-kind="user_message"]');
  }

  toolCall(tool: string): Locator {
    return this.transcript.locator(`[data-item-kind="tool_call"][data-tool="${tool}"]`);
  }

  /** The scrollable list of the transcript (virtua's scroll container). */
  list(): Locator {
    return this.transcript.getByRole('region');
  }

  /** The "…" menu next to the header (WP-35 §8). */
  async headerMenu(): Promise<Locator> {
    await this.pane.locator('[data-slot="session-menu"]').click();
    const menu = this.page.getByRole('menu');
    await expect(menu).toBeVisible();
    return menu;
  }
}
