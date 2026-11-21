import type { EntryId } from '@shared/common';
import { makeError } from '@shared/errors';
import type { GitDiffFile, GitStatus, ReviewComment, SessionSummary, WorktreeRef } from '@shared/model';
import type { Command } from '@shared/protocol';
import { sampleId } from '@shared/samples';
import type { FakeAck, FakeHost } from '@web/state/fake-host';
import { SHOWCASE_FILTER_WORKTREE, SHOWCASE_ROOTS } from './files';

/**
 * The tab "Changes" of the README showcase (WP-118): the product-filter session works in a worktree
 * of its own; its session diff has three files, two review comments (one open, one already sent to
 * Claude) and two commits that are not pushed yet. A tiny git service and review store answer the
 * commands of the panel deterministically (`git.*`, `review.*`, like the server of WP-111 would).
 */

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;

function iso(ms: number): string {
  return new Date(ms).toISOString();
}

export const FILTER_BRANCH = 'multi-filter';
const FILTER_UPSTREAM = 'origin/multi-filter';
/** Merge base of the worktree with `main` (the session diff starts here, ADR-253). */
const BASE_SHA = '4e1f0c9a7b3d2e8f6a5c4b3a2918f7e6d5c4b3a2';
const HEAD_SHA = '9b2d7c4e1a0f3b6d8c5e2a7f4b1d9c6e3a0f7b4d';
/** Answer of `git.commit` (nobody commits in a screenshot, the playground may). */
const COMMIT_SHA = 'c7a41e9d03b5f8a2e6d1c4b7a9f0e3d2c5b8a1f4';
/** HEAD of every other showcase session (they have no changes to show). */
const OTHER_HEAD_SHA = '2d8e5b1f7c4a0e9d3b6f2a8c5e1d7b4a0f3c9e6b';

export function filterWorktree(now: number): WorktreeRef {
  return {
    repoRoot: SHOWCASE_ROOTS.shop,
    path: SHOWCASE_FILTER_WORKTREE,
    branch: FILTER_BRANCH,
    baseRef: 'main',
    baseSha: BASE_SHA,
    portBase: 41010,
    createdAt: iso(now - 3 * HOUR),
  };
}

const patch = (...rows: string[]): string => `${rows.join('\n')}\n`;

export const FILTER_FILES = {
  bar: 'src/app/produkte/FilterBar.tsx',
  test: 'src/lib/filters.test.ts',
  lib: 'src/lib/filters.ts',
} as const;

const FILTER_BAR_PATCH = patch(
  '@@ -11,8 +11,13 @@',
  '   const router = useRouter();',
  '   const filter = parseFilter(useSearchParams());',
  ' ',
  '-  function setColor(color: string) {',
  '-    router.replace(`?farbe=${color}`, { scroll: false });',
  '+  function toggle(key: Facet, value: string) {',
  '+    const list = filter[key];',
  '+    const next = list.includes(value)',
  '+      ? list.filter((entry) => entry !== value)',
  '+      : [...list, value];',
  '+    const query = toSearch({ ...filter, [key]: next });',
  '+    router.replace(`?${query}`, { scroll: false });',
  '   }',
  ' ',
  '   return (',
);

const FILTERS_TEST_PATCH = patch(
  "@@ -18,3 +18,17 @@ describe('parseFilter', () => {",
  "     expect(parseFilter(params).sort).toBe('preis');",
  '   });',
  '+',
  "+  it('liest mehrere Farben und Größen', () => {",
  "+    const params = new URLSearchParams('farbe=blau,grau&groesse=m');",
  "+    expect(parseFilter(params).colors).toEqual(['blau', 'grau']);",
  '+  });',
  '+',
  "+  it('liefert leere Listen ohne Parameter', () => {",
  '+    expect(parseFilter(new URLSearchParams()).colors).toEqual([]);',
  '+  });',
  '+',
  "+  it('ignoriert leere und doppelte Werte', () => {",
  "+    const params = new URLSearchParams('farbe=blau,,blau');",
  "+    expect(parseFilter(params).colors).toEqual(['blau']);",
  '+  });',
  ' });',
);

const FILTERS_PATCH = patch(
  '@@ -1,13 +1,27 @@',
  "+export type Facet = 'colors' | 'sizes';",
  '+',
  ' export type Filter = {',
  '-  color?: string;',
  '-  size?: string;',
  '+  colors: string[];',
  '+  sizes: string[];',
  '   sort: SortKey;',
  ' };',
  ' ',
  ' export function parseFilter(params: URLSearchParams): Filter {',
  '   return {',
  "-    color: params.get('farbe') ?? undefined,",
  "-    size: params.get('groesse') ?? undefined,",
  "+    colors: readList(params, 'farbe'),",
  "+    sizes: readList(params, 'groesse'),",
  "     sort: parseSort(params.get('sortierung')),",
  '   };',
  ' }',
  '+',
  '+export function toSearch(filter: Filter): string {',
  '+  const params = new URLSearchParams({ sortierung: filter.sort });',
  "+  if (filter.colors.length > 0) params.set('farbe', filter.colors.join(','));",
  "+  if (filter.sizes.length > 0) params.set('groesse', filter.sizes.join(','));",
  '+  return params.toString();',
  '+}',
  '+',
  '+function readList(params: URLSearchParams, key: string): string[] {',
  "+  const items = (params.get(key) ?? '').split(',').filter((item) => item !== '');",
  '+  return [...new Set(items)];',
  '+}',
);

function diffFile(path: string, additions: number, deletions: number, text: string): GitDiffFile {
  return {
    path,
    origPath: null,
    kind: 'modified',
    binary: false,
    additions,
    deletions,
    patch: text,
    truncated: false,
  };
}

/** The session diff (merge base with `main` → working tree), in git's path order. */
export const FILTER_DIFF: readonly GitDiffFile[] = [
  diffFile(FILTER_FILES.bar, 7, 2, FILTER_BAR_PATCH),
  diffFile(FILTER_FILES.test, 14, 0, FILTERS_TEST_PATCH),
  diffFile(FILTER_FILES.lib, 18, 4, FILTERS_PATCH),
];

/** Two commits are not pushed yet; the tests Claude added after the review are not committed. */
export const FILTER_STATUS: GitStatus = {
  isRepo: true,
  root: SHOWCASE_FILTER_WORKTREE,
  branch: FILTER_BRANCH,
  detached: false,
  head: HEAD_SHA,
  upstream: FILTER_UPSTREAM,
  ahead: 2,
  behind: 0,
  files: [{ path: FILTER_FILES.test, origPath: null, kind: 'modified', staged: false, unstaged: true }],
  truncated: false,
};

/** The comment sent with the last prompt (transcripts.ts builds that prompt from it). */
export const FILTER_SENT_QUOTE = '  const filter = parseFilter(useSearchParams());';
export const FILTER_SENT_TEXT =
  'Leere oder kaputte Parameter dürfen hier nicht werfen – bitte mit Tests absichern, auch `?farbe=` ohne Wert.';

/**
 * The review comments: one sent with the last prompt (the transcript shows the message, Claude added
 * the tests), one open – written after the turn ended. Lines and quotes match the patches above, so
 * the panel keeps them in place.
 */
export function filterReview(now: number): ReviewComment[] {
  return [
    {
      id: sampleId('rc', 0x1181),
      path: FILTER_FILES.bar,
      side: 'new',
      line: 12,
      endLine: 12,
      quote: FILTER_SENT_QUOTE,
      text: FILTER_SENT_TEXT,
      state: 'sent',
      createdAt: iso(now - 26 * MINUTE),
      sentAt: iso(now - 24 * MINUTE),
    },
    {
      id: sampleId('rc', 0x1182),
      path: FILTER_FILES.bar,
      side: 'new',
      line: 16,
      endLine: 18,
      quote: [
        '    const next = list.includes(value)',
        '      ? list.filter((entry) => entry !== value)',
        '      : [...list, value];',
      ].join('\n'),
      text: 'Neue Werte bitte in der Reihenfolge der Facetten einsortieren – sonst hängt die URL davon ab, in welcher Reihenfolge man klickt, und der Seiten-Cache trifft seltener.',
      state: 'open',
      createdAt: iso(now - 3 * MINUTE),
      sentAt: null,
    },
  ];
}

function otherStatus(summary: SessionSummary): GitStatus {
  return {
    isRepo: true,
    root: summary.cwd,
    branch: summary.gitBranch,
    detached: false,
    head: OTHER_HEAD_SHA,
    upstream: null,
    ahead: 0,
    behind: 0,
    files: [],
    truncated: false,
  };
}

/** `git.*` of the showcase: the filter session has the diff above, every other one a clean tree. */
export function showcaseGitCommand(
  cmd: Command,
  summaries: readonly SessionSummary[],
  filterEntry: EntryId,
): FakeAck | undefined {
  if (!cmd.name.startsWith('git.') || !('entryId' in cmd)) return undefined;
  const summary = summaries.find((candidate) => candidate.entryId === cmd.entryId);
  if (summary === undefined) return { ok: false, error: makeError('ENTRY_NOT_FOUND') };
  const isFilter = cmd.entryId === filterEntry;
  switch (cmd.name) {
    case 'git.status':
      return { ok: true, result: { status: isFilter ? FILTER_STATUS : otherStatus(summary) } };
    case 'git.diff': {
      const uncommitted = new Set(FILTER_STATUS.files.map((file) => file.path));
      const files = !isFilter
        ? []
        : cmd.scope === 'session'
          ? FILTER_DIFF
          : cmd.scope === 'uncommitted'
            ? FILTER_DIFF.filter((file) => uncommitted.has(file.path))
            : [];
      return {
        ok: true,
        result: {
          root: isFilter ? SHOWCASE_FILTER_WORKTREE : summary.cwd,
          base: cmd.scope === 'session' ? BASE_SHA : null,
          files: files.map((file) => ({ ...file, patch: null })),
          truncated: false,
        },
      };
    }
    case 'git.fileDiff': {
      const file = isFilter ? FILTER_DIFF.find((candidate) => candidate.path === cmd.path) : undefined;
      return file === undefined
        ? { ok: false, error: makeError('GIT_FAILED', { op: 'diff' }) }
        : { ok: true, result: { file } };
    }
    case 'git.commit':
      return { ok: true, result: { sha: COMMIT_SHA } };
    case 'git.branchCreate':
    case 'git.branchSwitch':
    case 'git.push':
      return { ok: true, result: {} };
    default:
      return undefined;
  }
}

/** `review.*` of the showcase: kept in the server view and sent back as ops (like WP-111). */
export function showcaseReviewCommand(cmd: Command, host: FakeHost): FakeAck | undefined {
  if (
    cmd.name !== 'review.add' &&
    cmd.name !== 'review.update' &&
    cmd.name !== 'review.remove' &&
    cmd.name !== 'review.markSent'
  ) {
    return undefined;
  }
  const view = host.view(cmd.entryId);
  if (view === null) return { ok: false, error: makeError('ENTRY_NOT_FOUND') };
  const current = view.detail.review;
  switch (cmd.name) {
    case 'review.add': {
      const comment: ReviewComment = {
        id: sampleId('rc', 0x1190 + current.length),
        path: cmd.path,
        side: cmd.side,
        line: cmd.line,
        endLine: cmd.endLine,
        quote: cmd.quote,
        text: cmd.text,
        state: 'open',
        createdAt: host.now(),
        sentAt: null,
      };
      host.pushOps(cmd.entryId, [{ op: 'review.upsert', comments: [comment] }]);
      return { ok: true, result: { comment } };
    }
    case 'review.update': {
      const found = current.find((comment) => comment.id === cmd.commentId);
      if (found === undefined) {
        return { ok: false, error: makeError('VALIDATION_FAILED', { field: 'commentId' }) };
      }
      const comment: ReviewComment = {
        ...found,
        ...(cmd.text === undefined ? {} : { text: cmd.text }),
        ...(cmd.line === undefined ? {} : { line: cmd.line }),
        ...(cmd.endLine === undefined ? {} : { endLine: cmd.endLine }),
        ...(cmd.quote === undefined ? {} : { quote: cmd.quote }),
        ...(cmd.state === undefined ? {} : { state: cmd.state }),
      };
      host.pushOps(cmd.entryId, [{ op: 'review.upsert', comments: [comment] }]);
      return { ok: true, result: { comment } };
    }
    case 'review.remove':
      host.pushOps(cmd.entryId, [{ op: 'review.remove', commentIds: cmd.commentIds }]);
      return { ok: true, result: {} };
    case 'review.markSent': {
      const ids = new Set(cmd.commentIds);
      const sent = current
        .filter((comment) => ids.has(comment.id))
        .map((comment): ReviewComment => ({ ...comment, state: 'sent', sentAt: host.now() }));
      if (sent.length > 0) host.pushOps(cmd.entryId, [{ op: 'review.upsert', comments: sent }]);
      return { ok: true, result: {} };
    }
  }
}
