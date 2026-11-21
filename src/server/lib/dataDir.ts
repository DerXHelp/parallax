/**
 * The productive data directory per platform (WP-103, WP-100 E7) – the ONE place for config.ts
 * (`defaultHome`, the label in the host state) and the test guard (test/setup/home.ts: tests never
 * touch it, CLAUDE.md "Tests").
 *
 * - Windows: `%LOCALAPPDATA%\Parallax` (without LOCALAPPDATA `<home>\AppData\Local\Parallax`), label
 *   `%LOCALAPPDATA%\Parallax` – unchanged.
 * - POSIX (XDG Base Directory): `$XDG_DATA_HOME/parallax`, only an absolute XDG_DATA_HOME counts (the
 *   specification says to ignore a relative one); otherwise `~/.local/share/parallax` (`HOME`, else
 *   the account's home folder). Label `~/.local/share/parallax` resp. `$XDG_DATA_HOME/parallax`.
 */
import os from 'node:os';
import path from 'node:path';
import { PRODUCT_ID, PRODUCT_NAME } from '@shared/product';

function nonEmpty(value: string | undefined): string | undefined {
  return value === undefined || value === '' ? undefined : value;
}

/** An absolute `XDG_DATA_HOME`, or undefined. */
function xdgDataHome(env: NodeJS.ProcessEnv): string | undefined {
  const value = nonEmpty(env.XDG_DATA_HOME);
  return value?.startsWith('/') === true ? value : undefined;
}

export function defaultDataDir(
  env: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform,
): string {
  if (platform === 'win32') {
    const base = nonEmpty(env.LOCALAPPDATA) ?? path.win32.join(os.homedir(), 'AppData', 'Local');
    return path.win32.join(base, PRODUCT_NAME);
  }
  const base = xdgDataHome(env) ?? path.posix.join(nonEmpty(env.HOME) ?? os.homedir(), '.local', 'share');
  return path.posix.join(base, PRODUCT_ID);
}

/** `HostState.dataDirLabel` of the productive data directory (display only). */
export function defaultDataDirLabel(
  env: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform,
): string {
  if (platform === 'win32') return `%LOCALAPPDATA%\\${PRODUCT_NAME}`;
  return xdgDataHome(env) === undefined ? `~/.local/share/${PRODUCT_ID}` : `$XDG_DATA_HOME/${PRODUCT_ID}`;
}
