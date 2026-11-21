/**
 * WP-97 (ADR-238): "Open shell in folder" against the server build with the FakeBackend – the
 * header button, its chevron menu, the submenu of the "…" menu and Alt+K reach the server's
 * `session.openShell`, whose recording launcher only logs `session.openShell (fake): <exe> <args>`
 * (no window opens). Git Bash is left out: whether Git for Windows exists depends on the machine.
 */
import { logMessages } from './support/files';
import { expect, test } from './support/fixtures';

/**
 * The shells of this host (WP-109): Windows cmd (default) and PowerShell; Linux the login shell
 * (default) and bash – both bash in the test container – with the program the launcher logs.
 */
const SHELLS =
  process.platform === 'win32'
    ? {
        standard: { kind: 'cmd', logged: /\\System32\\cmd\.exe$/i },
        other: { kind: 'powershell', logged: /\\powershell\.exe -NoLogo$/i },
      }
    : {
        standard: { kind: 'login', logged: /\/(ba|z|fi)?sh(\s.*)?$/ },
        other: { kind: 'bash', logged: /\/bash(\s.*)?$/ },
      };

/** Log lines of the recording shell launcher. */
async function shellLines(server: Parameters<typeof logMessages>[0]): Promise<string[]> {
  return (await logMessages(server)).filter((line) => line.startsWith('session.openShell (fake): '));
}

test('header button, chevron menu, "…" submenu and Alt+K open the shell (logged with the FakeBackend)', async ({
  app,
  server,
  page,
}) => {
  const project = await server.makeProject('wp97');
  const session = await app.newSession(project);
  const group = session.pane.locator('[data-slot="console-button"]');

  // The icon: the default shell (cmd, Linux the login shell).
  await group.locator(`[data-shell="${SHELLS.standard.kind}"]`).click();
  await expect.poll(async () => (await shellLines(server)).at(-1) ?? '').toMatch(SHELLS.standard.logged);

  // The chevron: PowerShell (Linux bash).
  await group.locator('[data-slot="console-button-menu"]').click();
  await page.getByRole('menu').locator(`[data-choice="${SHELLS.other.kind}"]`).click();
  await expect.poll(async () => (await shellLines(server)).at(-1) ?? '').toMatch(SHELLS.other.logged);

  // The "…" menu: the submenu by keyboard.
  const menu = await session.headerMenu();
  await menu.locator('[data-action="openShell"]').focus();
  await page.keyboard.press('ArrowRight');
  const sub = page.locator('[data-slot="dropdown-menu-sub-content"]');
  await sub.locator(`[data-choice="${SHELLS.standard.kind}"]`).click();
  await expect.poll(async () => (await shellLines(server)).length).toBe(3);

  // Alt+K in the composer: the default shell of the selected session.
  await session.composer.click();
  await page.keyboard.press('Alt+K');
  await expect.poll(async () => (await shellLines(server)).length).toBe(4);
});
