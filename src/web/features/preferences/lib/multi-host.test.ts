import { describe, expect, it } from 'vitest';
import { formatPairingCode } from '@shared/pairing';
import { sampleRemoteAccessCheck, sampleRemoteEvent, sampleRemotePeer } from '@shared/samples';
import {
  ALL_ADDRESSES,
  REMOTE_PORT_RANGE,
  bindAddressChoices,
  countdownText,
  formatEndpoint,
  isUnverifiedName,
  minutesLeft,
  needsFirewallHint,
  orderedChecks,
  pairingGroups,
  secondsLeft,
} from './multi-host';

describe('multi-host helpers (WP-78b)', () => {
  it('splits a formatted pairing code into its 7 groups', () => {
    const code = formatPairingCode(Uint8Array.from({ length: 16 }, (_, i) => i * 13));
    const groups = pairingGroups(code);
    expect(groups).toHaveLength(7);
    expect(groups.every((group) => group.length === 4)).toBe(true);
    expect(groups.join('-')).toBe(code);
  });

  it('counts down in whole seconds and formats m:ss', () => {
    const now = Date.parse('2026-10-15T08:00:00.000Z');
    expect(secondsLeft('2026-10-15T08:10:00.000Z', now)).toBe(600);
    expect(secondsLeft('2026-10-15T08:00:00.400Z', now)).toBe(1);
    expect(secondsLeft('2026-10-15T07:59:00.000Z', now)).toBe(0);
    expect(secondsLeft('not a time', now)).toBe(0);
    expect(countdownText(600)).toBe('10:00');
    expect(countdownText(61)).toBe('1:01');
    expect(countdownText(0)).toBe('0:00');
    expect(minutesLeft(600)).toBe(10);
    expect(minutesLeft(61)).toBe(2);
    expect(minutesLeft(1)).toBe(1);
  });

  it('marks names of rejected attempts as unverified', () => {
    expect(isUnverifiedName(sampleRemoteEvent({ kind: 'pair_failed', claimedName: 'Laptop X' }))).toBe(true);
    expect(
      isUnverifiedName(sampleRemoteEvent({ kind: 'pair_ok', claimedName: 'Computer A', rejected: false })),
    ).toBe(false);
    expect(isUnverifiedName(sampleRemoteEvent({ claimedName: null }))).toBe(false);
  });

  it('formats endpoints for IPv4, IPv6 and without port', () => {
    expect(formatEndpoint('192.0.2.10', 51234)).toBe('192.0.2.10:51234');
    expect(formatEndpoint('2001:db8::1', 51234)).toBe('[2001:db8::1]:51234');
    expect(formatEndpoint('192.0.2.10', null)).toBe('192.0.2.10');
  });

  it('orders checks like the contract; the firewall hint shows while no computer is coupled', () => {
    const checks = [sampleRemoteAccessCheck({ id: 'tls' }), sampleRemoteAccessCheck({ id: 'port' })];
    expect(orderedChecks(checks).map((check) => check.id)).toEqual(['port', 'tls']);
    expect(needsFirewallHint({ peer: null })).toBe(true);
    expect(needsFirewallHint({ peer: sampleRemotePeer() })).toBe(false);
  });

  it('offers all addresses, the detected IPv4 ones and a stored other one', () => {
    expect(bindAddressChoices(ALL_ADDRESSES, ['192.0.2.20', 'fe80::1', '192.0.2.20'])).toEqual([
      ALL_ADDRESSES,
      '192.0.2.20',
    ]);
    expect(bindAddressChoices('198.51.100.7', ['192.0.2.20'])).toEqual([
      ALL_ADDRESSES,
      '192.0.2.20',
      '198.51.100.7',
    ]);
  });

  it('reads the port range from the contract', () => {
    expect(REMOTE_PORT_RANGE).toEqual({ min: 1024, max: 65535 });
  });
});
