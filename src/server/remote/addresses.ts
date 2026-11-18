/**
 * Addresses and names of the sharing computer and of the other side (docs/wp/WP-75.md §3.7, §4.2).
 * No reverse DNS: names from the network are not trustworthy and cost time.
 */
import { hostname, networkInterfaces, type NetworkInterfaceInfo } from 'node:os';
import { LIMITS } from '@shared/common';

/** Largest address string kept (the event and peer schemas allow 64). */
const ADDRESS_CHARS = 64;
const MAX_ADDRESSES = 32;

/** The remote address of a socket for logs and the connection log (IPv4-mapped IPv6 → IPv4). */
export function normalizeRemoteAddress(address: string | undefined): string {
  if (address === undefined || address.length === 0) return 'unknown';
  const mapped = /^::ffff:(\d{1,3}(?:\.\d{1,3}){3})$/iu.exec(address);
  return (mapped?.[1] ?? address).slice(0, ADDRESS_CHARS);
}

export function normalizeRemotePort(port: number | undefined): number | null {
  return port !== undefined && Number.isInteger(port) && port >= 0 && port <= 65_535 ? port : null;
}

/** Detected IPv4 addresses of this computer (no loopback, no link-local), for the pairing display. */
export function detectIpv4Addresses(
  interfaces: NodeJS.Dict<NetworkInterfaceInfo[]> = networkInterfaces(),
): string[] {
  const found = new Set<string>();
  for (const list of Object.values(interfaces)) {
    for (const info of list ?? []) {
      if (info.family !== 'IPv4' || info.internal) continue;
      if (info.address.startsWith('169.254.')) continue;
      found.add(info.address);
      if (found.size >= MAX_ADDRESSES) return [...found];
    }
  }
  return [...found];
}

/** Addresses shown for a listener bound to `bindAddress` (`0.0.0.0` = every detected address). */
export function listenerAddresses(
  bindAddress: string,
  detect: () => string[] = detectIpv4Addresses,
): string[] {
  return bindAddress === '0.0.0.0' ? detect() : [bindAddress];
}

/** The Windows computer name (display only). */
export function computerName(read: () => string = hostname): string {
  let name = '';
  try {
    name = read().trim();
  } catch {
    name = '';
  }
  return (name.length > 0 ? name : 'parallax').slice(0, LIMITS.hostAddressChars);
}

/** An unverified name from the network: control characters removed, trimmed, at most hostNameChars. */
export function sanitizeClaimedName(name: string | null | undefined): string | null {
  if (typeof name !== 'string') return null;
  // eslint-disable-next-line no-control-regex -- removing control characters is the point
  const clean = name.replace(/[\u0000-\u001f\u007f-\u009f\u2028\u2029]/gu, '').trim();
  return clean.length > 0 ? clean.slice(0, LIMITS.hostNameChars).trim() : null;
}
