/**
 * The pseudo console of this platform for the terminal service (WP-105): ConPTY on Windows x64
 * (`conpty.ts`, WP-99), the Linux pseudo terminal on Linux x64 (`unixPty.ts`), nothing elsewhere. The
 * composition (`app/compose.ts`) spreads the result into `createTerminalService` for the SDK backend;
 * the FakeBackend keeps `createFakePtyFactory()`.
 */
import { conPtyUnavailableReason, createConPtyFactory } from './conpty';
import type { PtyFactory } from './ports';
import { createUnixPtyFactory, unixPtyUnavailableReason, type UnixPtyDeps } from './unixPty';

/** A factory, or why there is none (`TERMINAL_UNAVAILABLE.params.reason`): `platform` or `ffi`. */
export type PlatformPty = { pty: PtyFactory } | { pty: null; unavailableReason: 'platform' | 'ffi' };

export interface PlatformPtyOptions {
  /** Linux: seams of the pseudo terminal (tree kill, `/proc`, logger). */
  unix?: UnixPtyDeps;
}

/** The pty of `platform` (default `process.platform`); see the file comment. */
export function createPlatformPty(
  platform: NodeJS.Platform = process.platform,
  options: PlatformPtyOptions = {},
): PlatformPty {
  if (platform === 'win32') {
    const pty = createConPtyFactory();
    return pty === null ? { pty, unavailableReason: conPtyUnavailableReason() } : { pty };
  }
  if (platform === 'linux') {
    const pty = createUnixPtyFactory(options.unix);
    return pty === null ? { pty, unavailableReason: unixPtyUnavailableReason() } : { pty };
  }
  return { pty: null, unavailableReason: 'platform' };
}
