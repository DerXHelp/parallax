import { describe, expect, it } from 'vitest';
import { clientIdSchema, cmdIdSchema } from '@shared/common';
import { sampleStatusFacts, sampleSummary, sampleTime } from '@shared/samples';
import { DEFAULT_BACKOFF, backoffDelay } from './backoff';
import { formatHash, getHashParam, parseHash, setHashParam } from './hash';
import { newClientId, newCmdId } from './ids';
import { pathTail, shortPath } from './path-display';
import { orderSessions } from './session-order';
import { sessionTitle } from './session-title';
import { storageAvailable, storageKey } from './storage';
import { cliVersionStatus, compareVersions, knownVersion } from './version';

describe('ids', () => {
  it('match the contract schemas', () => {
    expect(clientIdSchema.safeParse(newClientId()).success).toBe(true);
    expect(cmdIdSchema.safeParse(newCmdId()).success).toBe(true);
    expect(newClientId()).not.toBe(newClientId());
  });
});

describe('backoff', () => {
  it('grows exponentially, caps and spreads by the jitter', () => {
    const mid = () => 0.5;
    expect([0, 1, 2, 3, 4, 5, 6].map((attempt) => backoffDelay(attempt, DEFAULT_BACKOFF, mid))).toEqual([
      500, 1000, 2000, 4000, 8000, 15_000, 15_000,
    ]);
    expect(backoffDelay(0, DEFAULT_BACKOFF, () => 0)).toBe(400);
    expect(backoffDelay(0, DEFAULT_BACKOFF, () => 0.999_999)).toBe(600);
  });
});

describe('hash', () => {
  it('parses and formats parameters, flags and encoded values', () => {
    expect(parseHash('#session=local:en_1&playground&x=a%20b')).toEqual([
      ['session', 'local:en_1'],
      ['playground', null],
      ['x', 'a b'],
    ]);
    expect(
      formatHash([
        ['session', 'local:en_1'],
        ['playground', null],
      ]),
    ).toBe('#session=local:en_1&playground');
    expect(formatHash([])).toBe('');
    expect(getHashParam('#a=1&b', 'b')).toBeNull();
    expect(getHashParam('#a=1', 'c')).toBeUndefined();
  });

  it('sets, replaces and removes one parameter and keeps the others', () => {
    expect(setHashParam('#playground=x', 'session', 'local:en_1')).toBe('#playground=x&session=local:en_1');
    expect(setHashParam('#session=a&p&session=b', 'session', 'c')).toBe('#session=c&p');
    expect(setHashParam('#session=a&p', 'session', undefined)).toBe('#p');
    expect(setHashParam('', 'playground', null)).toBe('#playground');
  });
});

describe('pathTail', () => {
  it('keeps the last segments with the original separator', () => {
    expect(pathTail('D:\\1\\2\\3\\4')).toBe('3\\4');
    expect(pathTail('/home/user/project/src', 2)).toBe('project/src');
    expect(pathTail('D:\\work', 2)).toBe('D:\\work');
    expect(pathTail('D:\\work\\demo', 1)).toBe('demo');
  });

  it('shortPath marks shortened paths (V1-13)', () => {
    expect(shortPath('D:\\1\\2\\3\\4', 3)).toBe('…\\2\\3\\4');
    expect(shortPath('/a/b/c', 2)).toBe('…/b/c');
    expect(shortPath('D:\\work\\demo', 3)).toBe('D:\\work\\demo');
  });
});

describe('storage', () => {
  it('builds feature keys and probes availability (R1W-21, R1W-12)', () => {
    expect(storageKey('composer', 'draft', 'local:en_1')).toBe('parallax.composer.draft.local:en_1');
    expect(() => storageKey('composer', '')).toThrow();
    expect(storageAvailable('local')).toBe(true);
    expect(storageAvailable('session')).toBe(true);
    expect(window.localStorage.getItem('parallax.probe')).toBeNull();
  });
});

describe('orderSessions', () => {
  it('sorts by sort bucket, then newest activity, and hides archived entries', () => {
    const entry = (title: string, seconds: number, status = sampleStatusFacts(), archived = false) => ({
      summary: sampleSummary({ title, lastActivityAt: sampleTime(seconds), status, archived }),
    });
    const waiting = sampleStatusFacts({
      runState: 'working',
      decisions: { permission: 1, question: 0, plan: 0, oldestKind: 'permission', expired: 0 },
    });
    const ordered = orderSessions(
      [
        entry('idle old', 10),
        entry('idle new', 50),
        entry('waiting', 0, waiting),
        entry('working', 5, sampleStatusFacts({ runState: 'working' })),
        entry('archived', 100, sampleStatusFacts(), true),
      ],
      new Date(sampleTime(60)),
    );
    expect(ordered.map((item) => item.entry.summary.title)).toEqual([
      'waiting',
      'working',
      'idle new',
      'idle old',
    ]);
    expect(ordered[0]?.status.kind).toBe('needs-permission');
  });
});

describe('sessionTitle (V2-05)', () => {
  it('falls back to the folder name while the title is empty', () => {
    expect(sessionTitle({ title: 'Fix the build', cwd: 'D:\\work\\demo' })).toBe('Fix the build');
    expect(sessionTitle({ title: '', cwd: 'D:\\work\\demo' })).toBe('demo');
    expect(sessionTitle({ title: '  ', cwd: 'D:\\work\\demo\\' })).toBe('demo');
    expect(sessionTitle({ title: '', cwd: 'D:\\' })).toBe('D:\\');
  });
});

describe('version rule C.7 (R3-01)', () => {
  it('compares like semver and ignores build metadata', () => {
    expect(compareVersions('2.1.300', '2.1.296')).toBe(1);
    expect(compareVersions('2.1.296', '2.1.296')).toBe(0);
    expect(compareVersions('2.1.99', '2.1.296')).toBe(-1);
    expect(compareVersions('v2.2.0', '2.1.999')).toBe(1);
    expect(compareVersions('2.1.296-beta.1', '2.1.296')).toBe(-1);
    expect(compareVersions('2.1.296+abc', '2.1.296')).toBe(0);
    expect(compareVersions('2.1', '2.1.296')).toBeNull();
  });

  it('is too_old only when the CLI is older than the version the SDK expects', () => {
    expect(cliVersionStatus('2.1.300', '2.1.296')).toBe('ok');
    expect(cliVersionStatus('2.1.296', '2.1.296')).toBe('ok');
    expect(cliVersionStatus('2.1.200', '2.1.296')).toBe('too_old');
    expect(cliVersionStatus(null, '2.1.296')).toBe('unknown');
    expect(cliVersionStatus('2.1.300', 'unknown')).toBe('unknown');
    expect(cliVersionStatus('', '2.1.296')).toBe('unknown');
    expect([knownVersion(null), knownVersion(''), knownVersion(' 2.1.300 ')]).toEqual([
      null,
      null,
      '2.1.300',
    ]);
  });
});
