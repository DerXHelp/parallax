import { describe, expect, it } from 'vitest';
import { hostIdSchema } from '@shared/common';
import { HOST_COLORS, keyPurposeSchema, remoteHostIdSchema } from '@shared/model';
import { PinnedConnectionError } from '../secure/pinnedAgent';
import { connectionFailure } from './failures';
import { pickColor, slugify, uniqueHostId } from './naming';

describe('host ids', () => {
  it.each([
    ['PC B', 'pc-b'],
    ['Rechner Büro', 'rechner-buro'],
    ['Straße 7', 'strasse-7'],
    ['  --Laptop__2--  ', 'laptop-2'],
    ['Ærø', 'aero'],
    ['日本', ''],
  ])('slugify(%j) = %j', (name, slug) => {
    expect(slugify(name)).toBe(slug);
  });

  it('makes valid, unique ids that are never `local` and fit the key purpose', () => {
    const taken = new Set<string>();
    const names = ['PC B', 'PC B', 'pc-b', 'local', '日本', '日本', 'x'.repeat(80), 'x'.repeat(80)];
    for (const name of names) {
      const id = uniqueHostId(name, taken);
      expect(hostIdSchema.safeParse(id).success).toBe(true);
      expect(remoteHostIdSchema.safeParse(id).success).toBe(true);
      expect(keyPurposeSchema.safeParse(`coupling:${id}`).success).toBe(true);
      expect(taken.has(id)).toBe(false);
      taken.add(id);
    }
    expect([...taken]).toEqual([
      'pc-b',
      'pc-b-2',
      'pc-b-3',
      'local-2',
      'host',
      'host-2',
      'x'.repeat(32),
      `${'x'.repeat(30)}-2`,
    ]);
  });

  it('picks the first free color, then cycles', () => {
    expect(pickColor([])).toBe('blue');
    expect(pickColor(['blue', 'amber'])).toBe('green');
    expect(pickColor([...HOST_COLORS])).toBe(HOST_COLORS[0]);
    expect(pickColor([...HOST_COLORS, 'blue'])).toBe(HOST_COLORS[1]);
  });
});

describe('connection failures', () => {
  it.each([
    [new PinnedConnectionError('network', 'ECONNREFUSED'), 'unreachable', 'refused', false],
    [new PinnedConnectionError('network', 'ECONNRESET'), 'unreachable', 'network', false],
    [new PinnedConnectionError('timeout'), 'unreachable', 'timeout', false],
    [new PinnedConnectionError('proof_timeout'), 'unreachable', 'timeout', false],
    [new PinnedConnectionError('tls', 'ERR_SSL_X'), 'unreachable', 'tls', false],
    [new PinnedConnectionError('destroyed'), 'unreachable', 'closed', false],
    [new PinnedConnectionError('pin'), 'unreachable', 'tls', true],
    [new PinnedConnectionError('unauthorized'), 'unreachable', 'tls', true],
    [new PinnedConnectionError('proof_mismatch'), 'unreachable', 'tls', true],
    [new PinnedConnectionError('reused'), 'unreachable', 'tls', true],
    [Object.assign(new Error('x'), { code: 'ETIMEDOUT' }), 'unreachable', 'timeout', false],
    [new Error('Opening handshake has timed out'), 'unreachable', 'timeout', false],
    [new Error('Unexpected server response: 500'), 'unreachable', 'closed', false],
    ['strange', 'unreachable', 'network', false],
  ] as const)('%s → %s %s', (error, kind, reason, suspect) => {
    const failure = connectionFailure(error);
    expect(failure.kind).toBe(kind);
    expect(failure.error).toEqual({ code: 'HOST_UNREACHABLE', params: { reason } });
    expect(failure.suspect).toBe(suspect);
  });

  it('a close after the handshake is a refusal (unknown or revoked key)', () => {
    expect(connectionFailure(new PinnedConnectionError('proof_closed', 'ECONNRESET'))).toEqual({
      kind: 'refused',
      error: { code: 'HOST_REVOKED', params: {} },
      suspect: false,
    });
  });
});
