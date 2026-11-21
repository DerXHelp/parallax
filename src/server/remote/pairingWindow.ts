/**
 * The pairing window of the sharing computer (docs/wp/WP-76.md §B.7): opened only by a local
 * window (`remoteAccess.pair`), `code = randomBytes(16)`, 10 minutes, at most 3 failed attempts
 * per address and PAIRING_MAX_FAILURES_TOTAL in all (security review: garbage from another device
 * must not close the window for the right one; the 128-bit code needs no tighter limit), single use. A new window replaces an open one. The code never leaves this module except as the
 * formatted string in the ack of `remoteAccess.pair`; the buffer is zeroed when the window closes.
 *
 * WP-107 (§B.13): the window holds the coupling level chosen on site (`control`/`manage`) next to its
 * id – in memory only, never sent; a successful pairing writes exactly this level into the peer.
 */
import { randomBytes, randomUUID } from 'node:crypto';
import {
  PAIRING_CODE_BYTES,
  PAIRING_MAX_FAILURES,
  PAIRING_WINDOW_MS,
  formatPairingCode,
} from '@shared/pairing';
import type { RemotePeerLevel } from '@shared/model';
import { registerSecret, unregisterSecret } from '../lib/logger';

/**
 * `lapsed` = a request found the window past its end (before the timer fired); like `used` and
 * `failures` the caller still answers on its own socket and ends the others itself.
 */
export type PairingWindowCloseReason =
  'replaced' | 'expired' | 'lapsed' | 'failures' | 'used' | 'cancelled' | 'stopped';

/** Failed attempts of one window from all addresses together before it closes. */
export const PAIRING_MAX_FAILURES_TOTAL = 20;

export interface OpenPairingWindow {
  readonly id: string;
  readonly expiresAt: Date;
  /** Failed attempts from all addresses. */
  readonly failures: number;
  /** WP-107: the level a pairing through this window gets. */
  readonly level: RemotePeerLevel;
}

export interface PairingWindowOptions {
  now?: () => Date;
  windowMs?: number;
  /** Per address. */
  maxFailures?: number;
  maxFailuresTotal?: number;
  /** Called after a window closed (any reason); not called for `open()` without a previous window. */
  onClose?: (id: string, reason: PairingWindowCloseReason) => void;
}

interface WindowState {
  id: string;
  code: Buffer;
  formatted: string;
  expiresAt: Date;
  level: RemotePeerLevel;
  failures: number;
  byAddress: Map<string, number>;
  timer: NodeJS.Timeout;
}

export class PairingWindow {
  private state: WindowState | null = null;
  private readonly now: () => Date;
  private readonly windowMs: number;
  private readonly maxFailures: number;
  private readonly maxFailuresTotal: number;
  private readonly onClose: (id: string, reason: PairingWindowCloseReason) => void;

  constructor(options: PairingWindowOptions = {}) {
    this.now = options.now ?? (() => new Date());
    this.windowMs = options.windowMs ?? PAIRING_WINDOW_MS;
    this.maxFailures = options.maxFailures ?? PAIRING_MAX_FAILURES;
    this.maxFailuresTotal = options.maxFailuresTotal ?? PAIRING_MAX_FAILURES_TOTAL;
    this.onClose = options.onClose ?? (() => undefined);
  }

  /** Opens a new window (replacing an open one); returns the formatted code for the ack only. */
  open(level: RemotePeerLevel = 'control'): {
    id: string;
    code: string;
    expiresAt: Date;
    level: RemotePeerLevel;
  } {
    this.close('replaced');
    const code = randomBytes(PAIRING_CODE_BYTES);
    const formatted = formatPairingCode(code);
    registerSecret(formatted);
    const expiresAt = new Date(this.now().getTime() + this.windowMs);
    const id = randomUUID();
    const timer = setTimeout(() => {
      if (this.state?.id === id) this.close('expired');
    }, this.windowMs);
    timer.unref();
    this.state = { id, code, formatted, expiresAt, level, failures: 0, byAddress: new Map(), timer };
    return { id, code: formatted, expiresAt, level };
  }

  /** The open window (also one past its end until the timer fired – callers check `isExpired`). */
  current(): OpenPairingWindow | null {
    const state = this.state;
    return state === null
      ? null
      : { id: state.id, expiresAt: state.expiresAt, failures: state.failures, level: state.level };
  }

  /** WP-107: the level of window `id`, or null when `id` is not the open window. */
  levelFor(id: string): RemotePeerLevel | null {
    const state = this.state;
    return state?.id === id ? state.level : null;
  }

  /** End of the open window, or null. */
  expiresAt(): Date | null {
    return this.state?.expiresAt ?? null;
  }

  /** Is `id` the open window? */
  isCurrent(id: string | null): boolean {
    return id !== null && this.state?.id === id;
  }

  isExpired(id: string): boolean {
    const state = this.state;
    return state?.id !== id || state.expiresAt.getTime() <= this.now().getTime();
  }

  /**
   * A copy of the code of window `id` for one check (the caller zeroes it), or null when `id` is
   * not the open window.
   */
  codeFor(id: string): Buffer | null {
    const state = this.state;
    return state?.id === id ? Buffer.from(state.code) : null;
  }

  /**
   * Counts a failed attempt of window `id` from `address`; closes it at the limit of that address or
   * the total one. Returns true when it closed.
   */
  fail(id: string, address: string): boolean {
    const state = this.state;
    if (state?.id !== id) return false;
    state.failures += 1;
    const fromAddress = (state.byAddress.get(address) ?? 0) + 1;
    state.byAddress.set(address, fromAddress);
    if (fromAddress < this.maxFailures && state.failures < this.maxFailuresTotal) return false;
    this.close('failures');
    return true;
  }

  /** Uses up window `id` (single use); false when it is no longer the open window. */
  consume(id: string): boolean {
    if (this.state?.id !== id) return false;
    this.close('used');
    return true;
  }

  close(reason: PairingWindowCloseReason): void {
    const state = this.state;
    if (state === null) return;
    this.state = null;
    clearTimeout(state.timer);
    state.code.fill(0);
    unregisterSecret(state.formatted);
    this.onClose(state.id, reason);
  }
}
