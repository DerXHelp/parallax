/**
 * Contracts v5 (WP-110, "Ausbau 1"): git refs, worktrees, review comments and their ops, elicitation,
 * project settings, search and the status of an open elicitation.
 */
import { describe, expect, it } from 'vitest';
import { LIMITS } from './common';
import {
  decisionOutcomeSchema,
  entrySchema,
  hostStateSchema,
  isValidGitRefName,
  notificationSettingsSchema,
  projectSettingsSchema,
  reviewCommentSchema,
  sessionDetailSchema,
  sessionSummarySchema,
  settingsPatchSchema,
  settingsSchema,
} from './model';
import { commandSchema, isRemoteAllowedCommand, sessionOpSchema } from './protocol';
import {
  SAMPLE_IDS,
  sampleDecisions,
  sampleDetail,
  sampleEntry,
  sampleHostState,
  sampleId,
  sampleReviewComment,
  sampleSessionSnapshot,
  sampleStatusFacts,
  sampleSummary,
} from './samples';
import { deriveDisplayStatus, statusFactsSchema } from './status';
import { applySessionOp, viewStateFromSnapshot } from './sync';

const entryId = SAMPLE_IDS.entry;
const now = new Date('2026-10-15T09:00:00.000Z');

describe('git ref names (ADR-252)', () => {
  it.each(['main', 'feature/login', 'origin/main', 'v1.2.3', 'parallax/abc123', 'a'.repeat(40)])(
    'accepts %s',
    (name) => {
      expect(isValidGitRefName(name)).toBe(true);
    },
  );

  it.each([
    '',
    '-f',
    '--force',
    '/main',
    'main/',
    'a..b',
    'a b',
    'a\tb',
    'x@{1}',
    '@',
    'a//b',
    '.hidden',
    'feature/.x',
    'name.lock',
    'name.',
    'a~1',
    'a^',
    'a:b',
    'a?',
    'a*',
    'a[b',
    'a\\b',
    'a\u0007b',
    'x'.repeat(LIMITS.gitRefChars + 1),
  ])('rejects %j', (name) => {
    expect(isValidGitRefName(name)).toBe(false);
  });

  it('session.create.worktree and git.branchCreate check the branch name', () => {
    const create = (branch: string) =>
      commandSchema.safeParse({
        name: 'session.create',
        cwd: 'D:\\work\\sample',
        worktree: { mode: 'new', branch },
      }).success;
    expect(create('feature/login')).toBe(true);
    expect(create('--upload-pack=x')).toBe(false);
    expect(
      commandSchema.safeParse({ name: 'git.branchCreate', entryId, branch: '-b', switch: false }).success,
    ).toBe(false);
  });
});

describe('older files and hosts load with defaults', () => {
  it('an entry without worktree and baseSha', () => {
    const { worktree: _w, baseSha: _b, ...old } = sampleEntry();
    expect(entrySchema.parse(old)).toEqual(sampleEntry());
  });

  it('a summary and a detail of an older host', () => {
    const { worktree: _w, baseSha: _b, worktreeSetup: _s, ...summary } = sampleSummary();
    expect(sessionSummarySchema.parse(summary)).toEqual(sampleSummary());
    const { review: _r, ...detail } = sampleDetail();
    expect(sessionDetailSchema.parse(detail)).toEqual(sampleDetail());
  });

  it('settings without projects and muted projects; a host without features has none', () => {
    const settings = settingsSchema.parse({});
    expect(settings.projects).toEqual({});
    expect(settings.notifications.mutedProjects).toEqual([]);
    const { features: _f, ...host } = sampleHostState();
    expect(hostStateSchema.parse(host).features).toEqual({ git: false, search: false, overview: false });
  });

  it('decision counts without elicitation count 0', () => {
    const { elicitation: _e, ...decisions } = sampleStatusFacts().decisions;
    expect(statusFactsSchema.parse({ ...sampleStatusFacts(), decisions }).decisions.elicitation).toBe(0);
  });
});

describe('project settings (ADR-251)', () => {
  it('fills defaults per project and caps the commands', () => {
    expect(projectSettingsSchema.parse({})).toEqual({
      setup: '',
      teardown: '',
      shell: null,
      ports: false,
      worktreeDefault: false,
    });
    expect(
      projectSettingsSchema.safeParse({ setup: 'x'.repeat(LIMITS.projectCommandChars + 1) }).success,
    ).toBe(false);
  });

  it('a patch replaces the whole map; at most LIMITS.projectsMax projects', () => {
    expect(settingsPatchSchema.parse({ projects: {} })).toEqual({ projects: {} });
    const many = Object.fromEntries(
      Array.from({ length: LIMITS.projectsMax + 1 }, (_, i) => [`D:\\work\\p${String(i)}`, {}]),
    );
    expect(settingsPatchSchema.safeParse({ projects: many }).success).toBe(false);
  });

  it('muted projects are exact strings in the notifications', () => {
    const parsed = notificationSettingsSchema.parse({ mutedProjects: ['D:\\work\\sample'] });
    expect(parsed.mutedProjects).toEqual(['D:\\work\\sample']);
  });
});

describe('review comments (ADR-254)', () => {
  it('rejects a range that ends before it starts and a text over the limit', () => {
    expect(reviewCommentSchema.safeParse(sampleReviewComment({ line: 5, endLine: 4 })).success).toBe(false);
    expect(
      reviewCommentSchema.safeParse(sampleReviewComment({ text: 'x'.repeat(LIMITS.reviewCommentChars + 1) }))
        .success,
    ).toBe(false);
    const add = {
      name: 'review.add',
      entryId,
      path: 'src/a.ts',
      side: 'old',
      line: 3,
      endLine: 2,
      quote: '',
      text: 'x',
    };
    expect(commandSchema.safeParse(add).success).toBe(false);
    expect(commandSchema.safeParse({ ...add, endLine: 3 }).success).toBe(true);
  });

  it('review.upsert replaces by id and appends; review.remove deletes; conversation.reset keeps them', () => {
    const first = sampleReviewComment();
    const second = sampleReviewComment({ id: sampleId('rc', 2), line: 20, endLine: 20 });
    let state = viewStateFromSnapshot(sampleSessionSnapshot());
    state = applySessionOp(state, sessionOpSchema.parse({ op: 'review.upsert', comments: [first, second] }));
    expect(state.detail.review.map((c) => c.id)).toEqual([first.id, second.id]);
    const sent = { ...first, state: 'sent' as const, sentAt: '2026-10-15T08:05:00.000Z' };
    state = applySessionOp(state, { op: 'review.upsert', comments: [sent] });
    expect(state.detail.review).toEqual([sent, second]);
    state = applySessionOp(state, {
      op: 'conversation.reset',
      conversationId: sampleId('cv', 2),
      previousConversationId: SAMPLE_IDS.conversation,
      trigger: 'clear',
      hasEarlier: false,
    });
    expect(state.detail.review).toHaveLength(2);
    const unchanged = applySessionOp(state, { op: 'review.remove', commentIds: [sampleId('rc', 9)] });
    expect(unchanged).toBe(state);
    state = applySessionOp(state, { op: 'review.remove', commentIds: [first.id] });
    expect(state.detail.review).toEqual([second]);
  });
});

describe('elicitation (ADR-256)', () => {
  it('counts as waiting for the user like a permission', () => {
    const facts = sampleStatusFacts({
      runState: 'working',
      decisions: { ...sampleStatusFacts().decisions, elicitation: 1, oldestKind: 'elicitation' },
    });
    expect(deriveDisplayStatus(facts, now).kind).toBe('needs-answer');
  });

  it('url mode accepts only http(s) links', () => {
    const url = sampleDecisions.elicitationUrl();
    expect(url.mode).toBe('url');
    expect(
      commandSchema.safeParse({
        name: 'decision.respond',
        entryId,
        decisionId: url.id,
        response: { kind: 'elicitation', response: { action: 'accept' } },
      }).success,
    ).toBe(true);
    expect(
      sessionOpSchema.safeParse({ op: 'decision.upsert', decision: { ...url, url: 'file:///C:/x' } }).success,
    ).toBe(false);
  });

  it('a cancelled elicitation has the reason user', () => {
    expect(decisionOutcomeSchema.parse({ type: 'cancelled', reason: 'user' })).toEqual({
      type: 'cancelled',
      reason: 'user',
    });
  });
});

describe('remote access of the new commands (fail-closed)', () => {
  it('reading and changing need control', () => {
    for (const name of ['git.status', 'git.push', 'worktree.remove', 'review.add', 'search.query'] as const) {
      expect(isRemoteAllowedCommand(name, 'control')).toBe(true);
    }
  });

  it('search.query trims and needs 2 to 200 characters', () => {
    const query = (text: string) => commandSchema.safeParse({ name: 'search.query', text }).success;
    expect(query(' a ')).toBe(false);
    expect(query('ab')).toBe(true);
    expect(query('x'.repeat(LIMITS.searchTextMax + 1))).toBe(false);
  });
});
