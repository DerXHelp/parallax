import { describe, expect, it } from 'vitest';
import type { SessionSummary } from '@shared/model';
import { sampleId, sampleStatusFacts, sampleSummary, sampleWorktreeRef } from '@shared/samples';
import { deriveDisplayStatus } from '@shared/status';
import { pathTail } from './path-display';
import {
  groupSessions,
  matchesSidebarFilter,
  NO_SIDEBAR_FILTER,
  sessionProjectPath,
  sidebarFilterActive,
  sidebarFilterCounts,
  sidebarLayout,
} from './session-order';

/** WP-115: worktree sessions under their repository, the sidebar filter and its counters. */

const NOW = new Date('2026-10-15T12:00:00.000Z');
const minutesAgo = (minutes: number) => new Date(NOW.getTime() - minutes * 60_000).toISOString();

const REPO = 'D:\\work\\sample';
const OTHER = 'D:\\work\\other';
const WORKTREE = sampleWorktreeRef();

interface Entry {
  key: string;
  hostId: string;
  summary: SessionSummary;
}

type Kind = 'idle' | 'waiting' | 'working' | 'unread';

function entry(n: number, p: Partial<SessionSummary> = {}, kind: Kind = 'idle'): Entry {
  const status =
    kind === 'waiting'
      ? sampleStatusFacts({
          runState: 'working',
          decisions: {
            permission: 1,
            question: 0,
            plan: 0,
            elicitation: 0,
            oldestKind: 'permission',
            expired: 0,
          },
        })
      : kind === 'working'
        ? sampleStatusFacts({ runState: 'working' })
        : sampleStatusFacts({ runState: 'idle', unread: kind === 'unread' });
  return {
    key: `local:${String(n)}`,
    hostId: 'local',
    summary: sampleSummary({
      entryId: sampleId('en', n),
      title: `Session ${String(n)}`,
      cwd: REPO,
      gitBranch: null,
      lastActivityAt: minutesAgo(n),
      status,
      ...p,
    }),
  };
}

const keys = (list: readonly { entry: Entry }[]) => list.map((item) => item.entry.key);

describe('project of a session (worktrees under their repository)', () => {
  it('sessionProjectPath: the repository of a worktree session, else the folder', () => {
    expect(sessionProjectPath({ cwd: REPO, worktree: null })).toBe(REPO);
    expect(sessionProjectPath({ cwd: WORKTREE.path, worktree: WORKTREE })).toBe(REPO);
  });

  it('groups a worktree session with its repository; label and cwd name the repository', () => {
    const groups = groupSessions(
      [entry(1), entry(2, { cwd: WORKTREE.path, worktree: WORKTREE }), entry(3, { cwd: OTHER })],
      NOW,
    );
    expect(groups.map((group) => group.label)).toEqual([pathTail(REPO), pathTail(OTHER)]);
    const sample = groups[0];
    expect(sample?.cwd).toBe(REPO);
    expect(keys(sample?.sessions ?? [])).toEqual(['local:1', 'local:2']);
  });

  it('a worktree session that was active last keeps the repository as the group folder', () => {
    const groups = groupSessions([entry(5), entry(1, { cwd: WORKTREE.path, worktree: WORKTREE })], NOW);
    expect(groups).toHaveLength(1);
    expect(groups[0]?.cwd).toBe(REPO);
  });
});

describe('sidebar filter', () => {
  const status = (e: Entry) => deriveDisplayStatus(e.summary.status, NOW);

  it('is active with a status other than "all" or a text', () => {
    expect(sidebarFilterActive(NO_SIDEBAR_FILTER)).toBe(false);
    expect(sidebarFilterActive({ status: 'all', text: '  ' })).toBe(false);
    expect(sidebarFilterActive({ status: 'unread', text: '' })).toBe(true);
    expect(sidebarFilterActive({ status: 'all', text: 'api' })).toBe(true);
  });

  it('status: waiting (needs the user), working (not while it waits), unread', () => {
    const waiting = entry(1, {}, 'waiting');
    const working = entry(2, {}, 'working');
    const unread = entry(3, {}, 'unread');
    const idle = entry(4);
    const pass = (e: Entry, filter: 'waiting' | 'working' | 'unread') =>
      matchesSidebarFilter(e.summary, status(e), { status: filter, text: '' });
    expect([waiting, working, unread, idle].map((e) => pass(e, 'waiting'))).toEqual([
      true,
      false,
      false,
      false,
    ]);
    expect([waiting, working, unread, idle].map((e) => pass(e, 'working'))).toEqual([
      false,
      true,
      false,
      false,
    ]);
    expect([waiting, working, unread, idle].map((e) => pass(e, 'unread'))).toEqual([
      false,
      false,
      true,
      false,
    ]);
  });

  it('text: every word in title, folder, repository or branch, case-insensitive', () => {
    const worktree = entry(1, { title: 'Login form', cwd: WORKTREE.path, worktree: WORKTREE });
    const branch = entry(2, { title: 'Docs', gitBranch: 'fix/README' });
    const pass = (e: Entry, text: string) =>
      matchesSidebarFilter(e.summary, status(e), { status: 'all', text });
    expect(pass(worktree, 'login')).toBe(true);
    expect(pass(worktree, 'FEATURE/LOGIN')).toBe(true);
    expect(pass(worktree, 'sample login')).toBe(true);
    expect(pass(worktree, 'login docs')).toBe(false);
    expect(pass(branch, 'readme')).toBe(true);
    expect(pass(branch, 'other')).toBe(false);
  });

  it('counts per status over the non-archived entries', () => {
    const counts = sidebarFilterCounts(
      [
        entry(1, {}, 'waiting'),
        entry(2, {}, 'working'),
        entry(3, {}, 'unread'),
        entry(4),
        entry(5, { archived: true }, 'unread'),
      ],
      NOW,
    );
    expect(counts).toEqual({ all: 4, waiting: 1, working: 1, unread: 1 });
  });

  it('the layout keeps the matching entries and carries the unfiltered one', () => {
    const entries = [entry(1, {}, 'unread'), entry(2), entry(3, { cwd: OTHER }, 'unread')];
    const grouping = { byHost: false, byFolder: true };
    const plain = sidebarLayout(entries, NOW, grouping, ['local']);
    expect(plain.unfiltered).toBeUndefined();
    const filtered = sidebarLayout(entries, NOW, grouping, ['local'], undefined, {
      status: 'unread',
      text: '',
    });
    expect(keys(filtered.order)).toEqual(['local:1', 'local:3']);
    expect(filtered.folders?.map((group) => group.label)).toEqual([pathTail(REPO), pathTail(OTHER)]);
    expect(keys(filtered.unfiltered?.order ?? [])).toEqual(keys(plain.order));
    const none = sidebarLayout(entries, NOW, grouping, ['local'], undefined, {
      status: 'all',
      text: 'nothing',
    });
    expect(none.order).toEqual([]);
    expect(none.unfiltered?.order).toHaveLength(3);
  });
});
