import {
  REMOTE_ACCESS_CHECK_IDS,
  multiHostConfigSchema,
  type RemoteAccessCheck,
  type RemoteAccessState,
  type RemoteEvent,
} from '@shared/model';
import { numberRange, type NumberRange } from '@web/lib/zod-range';

/**
 * Pure helpers of the section "Several computers" (WP-78b): pairing code display, countdown,
 * connection log rows, listener settings. Ranges come from the contract (`multiHostConfigSchema`).
 */

/** `multiHost.port` of a sharing computer (1024–65535). */
export const REMOTE_PORT_RANGE: NumberRange = numberRange(multiHostConfigSchema.shape.port.unwrap());

/** `bindAddress` for "every IPv4 address of this computer". */
export const ALL_ADDRESSES = '0.0.0.0';

/** The groups of a pairing code as the server formats it (`XXXX-XXXX-…`, 7 groups of 4). */
export function pairingGroups(code: string): string[] {
  return code.split('-').filter((group) => group !== '');
}

/** Whole seconds until `expiresAt` (never negative; an unparsable time counts as expired). */
export function secondsLeft(expiresAt: string, now: number): number {
  const end = Date.parse(expiresAt);
  if (!Number.isFinite(end)) return 0;
  return Math.max(0, Math.ceil((end - now) / 1000));
}

/** `m:ss` of a countdown. */
export function countdownText(seconds: number): string {
  const whole = Math.max(0, Math.floor(seconds));
  return `${String(Math.floor(whole / 60))}:${String(whole % 60).padStart(2, '0')}`;
}

/** Minutes for the screen reader announcement (changes once a minute, never 0 while running). */
export function minutesLeft(seconds: number): number {
  return Math.max(1, Math.ceil(seconds / 60));
}

/**
 * A name in the log the other side gave itself without proof: every rejected attempt (pairing
 * requests, unknown keys …). Names of accepted events come from the paired computer.
 */
export function isUnverifiedName(event: Pick<RemoteEvent, 'claimedName' | 'rejected'>): boolean {
  return event.claimedName !== null && event.rejected;
}

/** `192.0.2.10:51234`, `[fe80::1]:51234`, or the address alone without a port. */
export function formatEndpoint(address: string, port: number | null): string {
  if (port === null) return address;
  return address.includes(':') ? `[${address}]:${String(port)}` : `${address}:${String(port)}`;
}

/** The checks in the contract's order (unknown or missing ones are left out). */
export function orderedChecks(checks: readonly RemoteAccessCheck[]): RemoteAccessCheck[] {
  const result: RemoteAccessCheck[] = [];
  for (const id of REMOTE_ACCESS_CHECK_IDS) {
    const check = checks.find((candidate) => candidate.id === id);
    if (check !== undefined) result.push(check);
  }
  return result;
}

/**
 * The firewall hint while no computer is coupled. Parallax neither checks nor changes the Windows
 * Firewall (ADR-228) – setting it up is the user's part.
 */
export function needsFirewallHint(state: Pick<RemoteAccessState, 'peer'>): boolean {
  return state.peer === null;
}

const bindAddressSchema = multiHostConfigSchema.shape.bindAddress.unwrap();

/** Choices of the bind address: all addresses, the detected IPv4 ones, and a stored other one. */
export function bindAddressChoices(current: string, addresses: readonly string[]): string[] {
  const choices = [ALL_ADDRESSES];
  for (const address of [...addresses, current]) {
    if (!choices.includes(address) && bindAddressSchema.safeParse(address).success) choices.push(address);
  }
  return choices;
}
