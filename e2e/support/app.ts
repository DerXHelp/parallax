/**
 * Page objects of the Parallax UI for the E2E tests. Selectors are the test attributes of WP-14/15/16
 * and WP-20b (docs/wp/WP-20b.md §2.12): `data-slot`, `data-action`, `data-session-key`,
 * `data-decision-id`, `data-item-kind` … – texts only where the text is the thing under test.
 */
import { expect, type Locator, type Page } from '@playwright/test';
import type { E2eServer } from './server';

/**
 * Every Radix menu of the page (dropdown and context menus), open or still closing – also one that
 * a modal dialog hides from the accessibility tree (`aria-hidden`), hence CSS, not `getByRole`.
 */
function menus(page: Page): Locator {
  return page.locator('[role="menu"]');
}

/**
 * Chooses `item` of an open menu and waits until the menu is gone (FIX-E2E-EDGE157).
 *
 * A closed Radix menu stays mounted for its exit animation (`animate-out`, 150 ms from the next
 * frame on) and stays a full layer of Radix' layer stack until then: its outside-`pointerdown`
 * listener closes the same menu again when its trigger is clicked (the trigger reopens it first),
 * as the top layer it takes the next Escape before a dialog opened meanwhile becomes the top layer
 * (that update runs in a React effect Chromium defers past the next frame after an input), and its
 * unmount gives the focus back to its trigger. A user is never that fast; a test acting within
 * milliseconds is. So every menu choice waits for the state a user sees: no menu left.
 */
export async function chooseMenuItem(item: Locator): Promise<void> {
  await item.click();
  await expect(menus(item.page())).toHaveCount(0);
}

/**
 * Opens a menu with `open` (click or right click on its trigger) and returns it once visible. A menu
 * still closing would close the new one right away (see `chooseMenuItem`) – none may be left.
 */
async function openMenu(page: Page, open: () => Promise<void>, menu: Locator): Promise<Locator> {
  await expect(menus(page)).toHaveCount(0);
  await open();
  await expect(menu).toBeVisible();
  return menu;
}

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

  /** The gear button of the settings menu in the sidebar. */
  settingsButton(): Locator {
    return this.page.locator('[data-action="settings"]');
  }

  /** Opens the settings menu (gear in the sidebar). */
  async openSettings(): Promise<Locator> {
    return openMenu(this.page, () => this.settingsButton().click(), this.page.getByRole('menu'));
  }

  notices(): Locator {
    return this.page.locator('[data-slot="notification-center"] [data-notice]');
  }

  // ---- Phase 2 (WP-35 sidebar, WP-38 settings page; WP-40) ----

  /** The session list of the sidebar (`data-view` = flat | grouped | archive; no text, R4W-27). */
  sidebar(): Locator {
    return this.page.locator('nav[data-view]');
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
    return openMenu(
      this.page,
      () => this.row(sessionKey).click({ button: 'right' }),
      this.page.locator(`[data-session-menu="${sessionKey}"]`),
    );
  }

  /** Chooses the action `action` (`data-action`) in the context menu of a session row. */
  async rowAction(sessionKey: string, action: string): Promise<void> {
    await chooseMenuItem((await this.rowMenu(sessionKey)).locator(`[data-action="${action}"]`));
  }

  /** "Settings…" in the settings menu → the settings page (WP-38), optionally on a section. */
  async openSettingsPage(section?: string): Promise<Locator> {
    const menu = await this.openSettings();
    await chooseMenuItem(menu.locator('[data-action="open-settings"]'));
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
  /** Phase 3: the side panel of the session (`data-tab`, `data-mode` = inline | overlay). */
  readonly sidePanel: Locator;
  /** Phase 3: the file viewer in the side panel (`data-kind` = the file kind). */
  readonly filePanel: Locator;

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
    this.sidePanel = page.locator(`[data-side-panel="${key}"]`);
    this.filePanel = this.sidePanel.locator('[data-slot="file-panel"]');
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

  /** WP-63: the group lines of the compact transcript (`data-state` = open | closed). */
  stepGroups(): Locator {
    return this.transcript.locator('[data-slot="step-group"]');
  }

  /**
   * WP-63: opens every closed step group – the compact view (default) shows a run of work steps as
   * one line; tests that look at single tool rows open them first.
   */
  async expandSteps(): Promise<void> {
    const closed = this.transcript.locator(
      '[data-slot="step-group"][data-state="closed"] [data-action="toggle-group"]',
    );
    for (let count = await closed.count(); count > 0; count--) {
      await closed.first().click();
      await expect(closed).toHaveCount(count - 1);
    }
  }

  /** The "…" menu next to the header (WP-35 §8). */
  async headerMenu(): Promise<Locator> {
    return openMenu(
      this.page,
      () => this.pane.locator('[data-slot="session-menu"]').click(),
      this.page.getByRole('menu'),
    );
  }

  /** Chooses the action `action` (`data-action`) in the "…" menu of the header. */
  async headerAction(action: string): Promise<void> {
    await chooseMenuItem((await this.headerMenu()).locator(`[data-action="${action}"]`));
  }

  // ---- Phase 3 (WP-54 viewer, WP-55 tasks, WP-56 plan, WP-58 header/side panel; WP-60) ----

  /** A side panel button next to the header ("Plan" only once the session has a plan). */
  panelButton(tab: 'plan' | 'files' | 'tasks'): Locator {
    return this.pane.locator(`[data-slot="header-panel"][data-tab="${tab}"]`);
  }

  /** Opens `tab` with its header button (a click on the open tab would close it). */
  async openPanel(tab: 'plan' | 'files' | 'tasks'): Promise<Locator> {
    const open = (await this.sidePanel.count()) > 0 ? await this.sidePanel.getAttribute('data-tab') : null;
    if (open !== tab) await this.panelButton(tab).click();
    await expect(this.sidePanel).toHaveAttribute('data-tab', tab);
    return this.sidePanel;
  }

  /** A tab of the open side panel's tab row (also "Plan" before the header shows its button). */
  panelTab(tab: 'plan' | 'file' | 'files' | 'tasks' | 'subagent'): Locator {
    return this.sidePanel.locator(`[role="tab"][data-tab="${tab}"]`);
  }

  /** The working file links (`data-state="link"`) in `scope` with `text`. */
  fileLink(scope: Locator, text: string | RegExp): Locator {
    return scope.locator('[data-slot="file-link"][data-state="link"]').filter({ hasText: text });
  }

  /** Clicks a file link and waits for the viewer of the file `name` (kind `kind`). */
  async openFile(link: Locator, name: string, kind: string): Promise<Locator> {
    await link.click();
    await expect(this.sidePanel).toHaveAttribute('data-tab', 'file');
    await expect(this.filePanel.locator('[data-slot="file-panel-title"]')).toContainText(name);
    await expect(this.filePanel).toHaveAttribute('data-kind', kind);
    return this.filePanel;
  }
}
