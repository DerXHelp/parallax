import { describe, expect, it } from 'vitest';
import type { SessionSummary } from '@shared/model';
import { windowsPathKey } from '@shared/paths';
import { sampleId, sampleStatusFacts, sampleSummary } from '@shared/samples';
import {
  folderGroupKey,
  groupKeysOfEntry,
  hostGroupKey,
  layoutGroupKeys,
  sidebarLayout,
  visibleSidebarOrder,
  type OrderedSession,
} from './session-order';

/** WP-80: "Group by" computer and/or folder, collapsed groups (WP-75 §4.4, ADR-226). */

const NOW = new Date('2026-10-15T12:00:00.000Z');
const minutesAgo = (minutes: number) => new Date(NOW.getTime() - minutes * 60_000).toISOString();

const API = 'C:\\repo\\api';
const WEB = 'C:\\repo\\web';
/** Group key of a folder on a computer (as `groupSessions` builds it). */
const group = (hostId: string, cwd: string) => `${hostId}|${windowsPathKey(cwd)}`;

interface Entry {
  key: string;
  hostId: string;
  summary: SessionSummary;
}

function entry(
  n: number,
  hostId: string,
  cwd: string,
  p: { waiting?: boolean; pinned?: boolean } = {},
): Entry {
  return {
    key: `${hostId}:${String(n)}`,
    hostId,
    summary: sampleSummary({
      entryId: sampleId('en', n),
      title: `Session ${String(n)}`,
      cwd,
      pinned: p.pinned ?? false,
      lastActivityAt: minutesAgo(n),
      status: sampleStatusFacts(
        p.waiting === true
          ? {
              runState: 'working',
              decisions: {
                permission: 1,
                question: 0,
                plan: 0,
                elicitation: 0,
                oldestKind: 'permission',
                expired: 0,
              },
            }
          : { runState: 'idle' },
      ),
    }),
  };
}

const keys = (list: readonly OrderedSession<Entry>[]) => list.map((item) => item.entry.key);

const ENTRIES = [
  entry(1, 'computer-b', API),
  entry(2, 'local', API),
  entry(3, 'local', WEB, { waiting: true }),
  entry(4, 'computer-b', WEB, { pinned: true }),
  entry(5, 'local', API),
];
const ORDER = ['local', 'computer-b', 'computer-c'];

describe('sidebarLayout', () => {
  it('neither: flat, pinned first, then status and activity', () => {
    const layout = sidebarLayout(ENTRIES, NOW, { byHost: false, byFolder: false }, ORDER);
    expect(layout.hosts).toBeNull();
    expect(layout.folders).toBeNull();
    expect(keys(layout.order)).toEqual(['computer-b:4', 'local:3', 'computer-b:1', 'local:2', 'local:5']);
  });

  it('folder: the same path on two computers is two groups', () => {
    const layout = sidebarLayout(ENTRIES, NOW, { byHost: false, byFolder: true }, ORDER);
    expect(layout.folders?.map((folder) => folder.key)).toEqual([
      group('computer-b', WEB),
      group('local', WEB),
      group('computer-b', API),
      group('local', API),
    ]);
  });

  it('computer: fixed order (this computer first, then the list), empty computers keep their block', () => {
    const layout = sidebarLayout(ENTRIES, NOW, { byHost: true, byFolder: false }, ORDER);
    expect(layout.hosts?.map((host) => [host.hostId, keys(host.sessions), host.waiting])).toEqual([
      ['local', ['local:3', 'local:2', 'local:5'], 1],
      ['computer-b', ['computer-b:4', 'computer-b:1'], 0],
      ['computer-c', [], 0],
    ]);
    expect(keys(layout.order)).toEqual(['local:3', 'local:2', 'local:5', 'computer-b:4', 'computer-b:1']);
  });

  it('both: folders inside the computer', () => {
    const layout = sidebarLayout(ENTRIES, NOW, { byHost: true, byFolder: true }, ORDER);
    const local = layout.hosts?.[0];
    expect(local?.folders?.map((folder) => [folder.cwd, keys(folder.sessions)])).toEqual([
      [WEB, ['local:3']],
      [API, ['local:2', 'local:5']],
    ]);
    expect(layoutGroupKeys(layout)).toEqual([
      hostGroupKey('local'),
      `folder:${group('local', WEB)}`,
      `folder:${group('local', API)}`,
      hostGroupKey('computer-b'),
      `folder:${group('computer-b', WEB)}`,
      `folder:${group('computer-b', API)}`,
      hostGroupKey('computer-c'),
    ]);
  });

  it('an unknown computer comes after the listed ones', () => {
    const layout = sidebarLayout(
      [entry(9, 'computer-z', API), ...ENTRIES],
      NOW,
      { byHost: true, byFolder: false },
      ['local'],
    );
    expect(layout.hosts?.map((host) => host.hostId)).toEqual(['local', 'computer-z', 'computer-b']);
  });
});

describe('visibleSidebarOrder and groupKeysOfEntry', () => {
  it('leaves the entries of collapsed groups out (both levels); the full order keeps them', () => {
    const layout = sidebarLayout(ENTRIES, NOW, { byHost: true, byFolder: true }, ORDER);
    const collapsed = new Set([hostGroupKey('computer-b'), `folder:${group('local', API)}`]);
    expect(keys(visibleSidebarOrder(layout, collapsed))).toEqual(['local:3']);
    expect(layout.order).toHaveLength(5);
  });

  it('collapsed folder groups without computers', () => {
    const layout = sidebarLayout(ENTRIES, NOW, { byHost: false, byFolder: true }, ORDER);
    const first = layout.folders?.[0];
    if (first === undefined) throw new Error('no group');
    expect(keys(visibleSidebarOrder(layout, new Set([folderGroupKey(first)])))).not.toContain('computer-b:4');
  });

  it('names the groups that hold an entry (to expand them)', () => {
    const layout = sidebarLayout(ENTRIES, NOW, { byHost: true, byFolder: true }, ORDER);
    const target = ENTRIES[4];
    if (target === undefined) throw new Error('no entry');
    expect(groupKeysOfEntry(layout, target)).toEqual([
      hostGroupKey('local'),
      `folder:${group('local', API)}`,
    ]);
  });
});
