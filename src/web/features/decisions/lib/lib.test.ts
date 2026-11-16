import { afterEach, describe, expect, it, vi } from 'vitest';
import { sampleDecisions, sampleItems, sampleOutcomes, sampleSessionSnapshot } from '@shared/samples';
import { viewStateFromSnapshot } from '@shared/sync';
import { defaultDestination } from '../components/PermissionCard';
import {
  pickDisplayedDecision,
  readApproveFresh,
  resetDecisionBarState,
  writeApproveFresh,
} from '../state/bar-store';
import { NO_OUTCOMES, resolvedElsewhereNotice, selectDecisionOutcomes } from './outcomes';
import { DEMO_PLAN } from './demo-data';
import {
  defaultApproveMode,
  FRESH_CONTEXT_RECOMMENDED_PERCENT,
  isFreshContextRecommended,
  orderedApproveModes,
  planSummary,
  planTitle,
} from './plan';
import { isFileChangeTool, ruleLabel, summarizeToolInput } from './tool-input';

describe('plan helpers', () => {
  it('takes the first heading as title and the first paragraph as summary', () => {
    expect(planTitle(DEMO_PLAN)).toBe('Move the session registry to JSON files');
    expect(planSummary(DEMO_PLAN)).toBe(
      'Replace the SQLite registry with atomic JSON files and schema versions, so a crash never leaves a half-written file.',
    );
  });

  it('falls back to the first line and joins list items; ignores code fences', () => {
    const plan = '1. **Create** `hello.txt`\n2. Commit it\n\n```\ncode\n```';
    expect(planTitle(plan)).toBe('Create hello.txt');
    expect(planSummary('# Plan\n\n1. Create hello.txt\n2. Commit it')).toBe('Create hello.txt · Commit it');
    expect(planTitle('```\nonly code\n```')).toBeNull();
    expect(planTitle('')).toBeNull();
    expect(planSummary('# Only a title')).toBeNull();
  });

  it('orders the offered modes and picks the main button mode (never bypass by default)', () => {
    expect(orderedApproveModes(['default', 'bypassPermissions', 'acceptEdits', 'auto'])).toEqual([
      'auto',
      'acceptEdits',
      'default',
      'bypassPermissions',
    ]);
    // WP-74 (ADR-204): auto mode first, else accept edits, else the first offered (never bypass).
    expect(defaultApproveMode(['default', 'acceptEdits', 'auto'])).toBe('auto');
    expect(defaultApproveMode(['default', 'acceptEdits'])).toBe('acceptEdits');
    expect(defaultApproveMode(['bypassPermissions', 'default'])).toBe('default');
    expect(defaultApproveMode(['bypassPermissions'])).toBe('bypassPermissions');
    expect(defaultApproveMode([])).toBeNull();
  });

  it('recommends a fresh context from 60 % (ADR-147)', () => {
    expect(FRESH_CONTEXT_RECOMMENDED_PERCENT).toBe(60);
    expect(isFreshContextRecommended(59)).toBe(false);
    expect(isFreshContextRecommended(59.9)).toBe(false);
    expect(isFreshContextRecommended(60)).toBe(true);
    expect(isFreshContextRecommended(97)).toBe(true);
    expect(isFreshContextRecommended(null)).toBe(false);
  });
});

describe('remembered approve choice', () => {
  afterEach(() => {
    localStorage.clear();
  });

  it('stores the fresh flag; tolerates broken values; drops the mode of older versions (ADR-204)', () => {
    resetDecisionBarState();
    localStorage.setItem('parallax.decisions.approveMode', 'acceptEdits');
    writeApproveFresh(true);
    expect(localStorage.getItem('parallax.decisions.approveFresh')).toBe('true');
    expect(readApproveFresh()).toBe(true);
    expect(localStorage.getItem('parallax.decisions.approveMode')).toBeNull();
    writeApproveFresh(false);
    expect(readApproveFresh()).toBe(false);
    localStorage.setItem('parallax.decisions.approveFresh', 'yes');
    expect(readApproveFresh()).toBe(false);
  });

  it('a throwing storage (privacy settings, quota): defaults, writes never throw (R5W-11)', () => {
    writeApproveFresh(true);
    // On the instance: happy-dom binds Storage methods to it on first use (a prototype spy is bypassed).
    const getItem = vi.spyOn(localStorage, 'getItem').mockImplementation(() => {
      throw new Error('SecurityError');
    });
    const setItem = vi.spyOn(localStorage, 'setItem').mockImplementation(() => {
      throw new Error('QuotaExceededError');
    });
    try {
      expect(readApproveFresh()).toBe(false);
      expect(() => {
        writeApproveFresh(false);
      }).not.toThrow();
      expect(setItem).toHaveBeenCalledTimes(1);
    } finally {
      getItem.mockRestore();
      setItem.mockRestore();
    }
    // The earlier value is untouched.
    expect(readApproveFresh()).toBe(true);
  });
});

describe('tool input summary', () => {
  it('summarizes commands, paths, patterns and unknown tools', () => {
    expect(summarizeToolInput('Bash', { command: 'dir' })).toEqual({ kind: 'command', text: 'dir' });
    expect(summarizeToolInput('Edit', { file_path: 'D:\\a.ts', old_string: 'a', new_string: 'b' })).toEqual({
      kind: 'path',
      text: 'D:\\a.ts',
    });
    expect(summarizeToolInput('Grep', { pattern: 'TODO', path: 'src' })).toEqual({
      kind: 'query',
      text: 'TODO · src',
    });
    expect(summarizeToolInput('WebFetch', { url: 'https://example.com' }).kind).toBe('url');
    expect(summarizeToolInput('mcp__x__y', { a: 1 })).toEqual({ kind: 'json', text: '{"a":1}' });
    expect(summarizeToolInput('Bash', { command: 'x'.repeat(1000) }).text).toHaveLength(400);
  });

  it('knows the file change tools and writes rules in CLI notation', () => {
    expect(isFileChangeTool('Write')).toBe(true);
    expect(isFileChangeTool('Bash')).toBe(false);
    expect(ruleLabel({ toolName: 'Bash', ruleContent: 'mkdir build' })).toBe('Bash(mkdir build)');
    expect(ruleLabel({ toolName: 'Read', ruleContent: null })).toBe('Read');
  });

  it('defaults the remember destination to the session (ADR-012)', () => {
    expect(defaultDestination(['localSettings', 'session'])).toBe('session');
    expect(defaultDestination(['projectSettings'])).toBe('projectSettings');
    expect(defaultDestination([])).toBeNull();
  });
});

describe('outcomes and display', () => {
  it('reads outcomes from the tool calls (cached per items array)', () => {
    const decision = sampleDecisions.permission();
    const view = viewStateFromSnapshot(
      sampleSessionSnapshot({
        items: [
          sampleItems.toolCall({
            decision: {
              decisionId: decision.id,
              kind: 'permission',
              planVersion: null,
              outcome: sampleOutcomes.denied,
            },
          }),
        ],
      }),
    );
    const outcomes = selectDecisionOutcomes(view);
    expect(outcomes.get(decision.id)).toEqual(sampleOutcomes.denied);
    expect(selectDecisionOutcomes(view)).toBe(outcomes);
    expect(selectDecisionOutcomes(viewStateFromSnapshot(sampleSessionSnapshot({ items: [] })))).toBe(
      NO_OUTCOMES,
    );
  });

  it('maps outcomes to notice texts', () => {
    expect(resolvedElsewhereNotice(sampleOutcomes.plan_approved)).toBe(
      'decisions.notices.elsewhere.plan_approved',
    );
    expect(resolvedElsewhereNotice(sampleOutcomes.cancelled)).toBe(
      'decisions.notices.withdrawn.signal_aborted',
    );
    expect(resolvedElsewhereNotice(null)).toBe('decisions.notices.gone');
    // WP-64: answered in the Claude app (Remote Control).
    expect(resolvedElsewhereNotice(sampleOutcomes.answered_elsewhere)).toBe(
      'decisions.notices.elsewhere.answered_elsewhere',
    );
    expect(
      resolvedElsewhereNotice({ type: 'plan_approved', mode: 'auto', edited: false, freshContext: true }),
    ).toBe('decisions.notices.elsewhereFresh');
  });

  it('shows the picked decision, else the oldest open one, else an expired one', () => {
    const permission = sampleDecisions.permission();
    const question = sampleDecisions.question();
    const expired = sampleDecisions.plan({ state: 'expired' });
    expect(pickDisplayedDecision([expired, permission, question], null)).toBe(permission);
    expect(pickDisplayedDecision([permission, question], question.id)).toBe(question);
    expect(pickDisplayedDecision([permission], question.id)).toBe(permission);
    expect(pickDisplayedDecision([expired], null)).toBe(expired);
    expect(pickDisplayedDecision([], null)).toBeNull();
  });
});
