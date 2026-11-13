import { describe, expect, it } from 'vitest';
import { sampleSummary, SAMPLE_TIME } from '@shared/samples';
import { activityVerb, parseMcpName, sessionLine } from './activity';

describe('parseMcpName', () => {
  it.each<[string, { server: string; tool: string } | null]>([
    ['mcp__github__search_issues', { server: 'github', tool: 'search_issues' }],
    ['mcp__a__b__c', { server: 'a', tool: 'b__c' }],
    ['mcp____x', null],
    ['mcp__github__', null],
    ['Bash', null],
  ])('%s', (name, expected) => {
    expect(parseMcpName(name)).toEqual(expected);
  });
});

describe('activityVerb', () => {
  it.each([
    ['Bash', 'run'],
    ['PowerShell', 'run'],
    ['Write', 'write'],
    ['MultiEdit', 'edit'],
    ['NotebookEdit', 'edit'],
    ['Read', 'read'],
    ['Glob', 'search'],
    ['WebSearch', 'search'],
    ['WebFetch', 'fetch'],
    ['Agent', 'agent'],
    ['Task', 'agent'],
    ['TodoWrite', 'tool'],
    ['mcp__github__search', 'tool'],
  ])('%s → %s', (tool, verb) => {
    expect(activityVerb(tool)).toBe(verb);
  });
});

describe('sessionLine (WP-65 §1.1)', () => {
  const turnSummary = { source: 'claude' as const, text: 'Fixed the login.', category: 'completed', needsAction: false, at: SAMPLE_TIME };

  it('while working: the CLI sentence, else the running tool, else thinking', () => {
    expect(sessionLine(sampleSummary({ activity: { kind: 'claude', text: 'Writing tests' } }), 'working')).toEqual({
      kind: 'claude',
      text: 'Writing tests',
      attention: false,
    });
    expect(
      sessionLine(sampleSummary({ activity: { kind: 'tool', tool: 'Write', target: 'handy.txt' }, turnSummary }), 'working'),
    ).toEqual({ kind: 'tool', verb: 'write', tool: 'Write', target: 'handy.txt', attention: false });
    expect(sessionLine(sampleSummary({ activity: { kind: 'thinking' } }), 'working')).toEqual({
      kind: 'thinking',
      attention: false,
    });
  });

  it('afterwards the turn summary; "needs you" for open decisions, errors and needs_action', () => {
    expect(sessionLine(sampleSummary({ turnSummary }), 'done')).toEqual({
      kind: 'summary',
      text: 'Fixed the login.',
      attention: false,
    });
    expect(sessionLine(sampleSummary({ turnSummary: { ...turnSummary, needsAction: true } }), 'done')?.attention).toBe(true);
    expect(sessionLine(sampleSummary({ turnSummary }), 'error')?.attention).toBe(true);
    expect(
      sessionLine(sampleSummary({ activity: { kind: 'tool', tool: 'Bash', target: 'rm x' } }), 'needs-permission')?.attention,
    ).toBe(true);
  });

  it('nothing without activity and summary, for archived and external sessions', () => {
    expect(sessionLine(sampleSummary(), 'idle')).toBeNull();
    expect(sessionLine(sampleSummary({ turnSummary, archived: true }), 'done')).toBeNull();
    expect(sessionLine(sampleSummary({ turnSummary }), 'external')).toBeNull();
  });
});
