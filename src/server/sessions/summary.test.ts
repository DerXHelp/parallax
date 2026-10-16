import { describe, expect, it } from 'vitest';
import { LIMITS } from '@shared/common';
import { sessionSummarySchema, type TitleSource } from '@shared/model';
import { SAMPLE_TIME, sampleEntry, sampleId, sampleStatusFacts } from '@shared/samples';
import type { BackendSessionInfo } from '../backend/types';
import {
  aiTitleFrom,
  cwdLabel,
  endReasonFor,
  implementPlanPrompt,
  isPromptFallback,
  newConversation,
  parseRenameCommand,
  summaryOf,
  titleChangeDecision,
  titleFromPrompt,
  withCurrentConversation,
} from './summary';

describe('summaryOf', () => {
  it('is schema-true (every field explicit, survives parse unchanged)', () => {
    const summary = summaryOf(sampleEntry(), sampleStatusFacts(), { gitBranch: 'main' });
    expect(sessionSummarySchema.parse(summary)).toEqual(summary);
    expect(summary).toMatchObject({ gitBranch: 'main', sessionId: '9b779de6-0000-4000-8000-000000000001' });
    const plain = summaryOf(sampleEntry({ context: null, lastModel: null }), sampleStatusFacts(), {
      gitBranch: null,
    });
    expect(sessionSummarySchema.parse(plain)).toEqual(plain);
  });
});

describe('titleFromPrompt (§3.5.8)', () => {
  it.each<[string, string | null]>([
    ['Fix the bug', 'Fix the bug'],
    ['  \n\n  first   line \n second', 'first line'],
    ['/rename X', null],
    ['   /compact', null],
    ['   ', null],
    [
      'This is a rather long prompt that keeps going and going well beyond the eighty character limit of titles',
      'This is a rather long prompt that keeps going and going well beyond the eighty…',
    ],
    ['x'.repeat(100), `${'x'.repeat(80)}…`],
  ])('%j → %j', (text, title) => {
    expect(titleFromPrompt(text)).toBe(title);
  });
});

describe('parseRenameCommand', () => {
  it.each<[string, string | null]>([
    ['/rename Parallax Spike Title', 'Parallax Spike Title'],
    ['  /rename   spaced   out  ', 'spaced out'],
    ['/rename', null],
    ['/renamex foo', null],
    ['rename foo', null],
    [`/rename ${'y'.repeat(300)}`, 'y'.repeat(LIMITS.titleChars)],
  ])('%j → %j', (text, title) => {
    expect(parseRenameCommand(text)).toBe(title);
  });
});

describe('titleChangeDecision (R0-05e, architecture §5.2)', () => {
  const ctx = (titleSource: TitleSource, pendingRename: string | null = null, resetInTurn = false) => ({
    titleSource,
    pendingRename,
    resetInTurn,
  });
  it.each<[string, ReturnType<typeof ctx>, string, ReturnType<typeof titleChangeDecision>]>([
    [
      'echo of the own /rename',
      ctx('custom', 'Mine'),
      'Mine',
      { kind: 'set', title: 'Mine', titleSource: 'custom', echo: true },
    ],
    [
      'echo also in the reset turn',
      ctx('none', 'Mine', true),
      'Mine',
      { kind: 'set', title: 'Mine', titleSource: 'custom', echo: true },
    ],
    ['custom is never overwritten', ctx('custom'), 'Other', { kind: 'ignore', reason: 'custom' }],
    ['custom + other pending', ctx('custom', 'Mine'), 'Other', { kind: 'ignore', reason: 'custom' }],
    ['reset turn ignores the old title', ctx('none', null, true), 'Old', { kind: 'ignore', reason: 'reset' }],
    [
      'otherwise → ai',
      ctx('prompt'),
      'AI title',
      { kind: 'set', title: 'AI title', titleSource: 'ai', echo: false },
    ],
    ['ai → ai', ctx('ai'), 'Newer', { kind: 'set', title: 'Newer', titleSource: 'ai', echo: false }],
    ['empty title', ctx('none'), '   ', { kind: 'ignore', reason: 'empty' }],
  ])('%s', (_name, c, title, expected) => {
    expect(titleChangeDecision(c, title)).toEqual(expected);
  });
});

describe('AI title (C.6, F.8)', () => {
  const info = (p: Partial<BackendSessionInfo>): BackendSessionInfo => ({
    sessionId: 's',
    summary: 'Button color question',
    customTitle: null,
    firstPrompt: 'Use the AskUserQuestion tool exactly once',
    lastModified: 0,
    ...p,
  });
  const current = (
    titleSource: TitleSource,
    title = 'Use the AskUserQuestion tool exactly once',
    promptTitle: string | null = title,
  ) => ({
    title,
    titleSource,
    promptTitle,
  });

  it.each<[string, BackendSessionInfo | null, ReturnType<typeof current>, string | null]>([
    ['AI title taken over', info({}), current('prompt'), 'Button color question'],
    ['no info', null, current('prompt'), null],
    // WP22-02: the SDK reports the AI title as customTitle too – only titleSource 'custom' protects.
    [
      'customTitle of the SDK (custom ‖ sidecar ‖ aiTitle)',
      info({ customTitle: 'X' }),
      current('prompt'),
      'X',
    ],
    ['own custom title', info({}), current('custom'), null],
    [
      'own custom title, also when the SDK reports one',
      info({ customTitle: 'Y' }),
      current('custom', 'Z'),
      null,
    ],
    [
      'summary = first prompt (fallback)',
      info({ summary: 'Use the AskUserQuestion tool exactly once' }),
      current('none', ''),
      null,
    ],
    ['summary = cut first prompt', info({ summary: 'Use the AskUserQuestion…' }), current('none', ''), null],
    ['same as the current title', info({ summary: 'Same' }), current('ai', 'Same'), null],
    ['empty summary', info({ summary: '  ' }), current('prompt'), null],
    [
      'heuristic without firstPrompt',
      info({ firstPrompt: null, summary: 'Fix the parser bug please' }),
      current('prompt', 'Fix the parser…'),
      null,
    ],
    [
      'heuristic: a real AI title',
      info({ firstPrompt: null, summary: 'Parser fix' }),
      current('prompt', 'Fix the parser…'),
      'Parser fix',
    ],
  ])('%s', (_name, i, c, expected) => {
    expect(aiTitleFrom(i, c)).toBe(expected);
  });

  // WP22-02: getSessionInfo() answers of the live acceptance (SDK 0.3.296, CLI 2.1.300) – sessions
  // never renamed, the transcript holds only `ai-title` entries.
  it.each<[string, BackendSessionInfo, string]>([
    [
      'second session of the main run',
      {
        sessionId: '415e6ece-41d4-4a99-b48e-e27176001340',
        summary: 'PowerShell Set-Content b.txt',
        customTitle: 'PowerShell Set-Content b.txt',
        firstPrompt:
          'Fuehre mit dem PowerShell-Tool genau diesen Befehl aus: Set-Content -Path b.txt -Value b',
        lastModified: 1792098863134,
      },
      'PowerShell Set-Content b.txt',
    ],
    [
      'live smoke run 3',
      {
        sessionId: 'ffc6667b-77e7-4eb0-ac5d-613b0295649b',
        summary: 'Datei test.txt mit Inhalt hallo',
        customTitle: 'Datei test.txt mit Inhalt hallo',
        firstPrompt: 'lege test.txt mit dem Inhalt hallo an',
        lastModified: 1792100750988,
      },
      'Datei test.txt mit Inhalt hallo',
    ],
  ])('real answer (%s): the AI title replaces the prompt title', (_name, i, expected) => {
    const promptTitle = i.firstPrompt ?? '';
    expect(aiTitleFrom(i, { title: promptTitle, titleSource: 'prompt', promptTitle })).toBe(expected);
    // … but never a title the user gave (/rename, session.rename).
    expect(aiTitleFrom(i, { title: 'WP22 Live-Abnahme', titleSource: 'custom', promptTitle })).toBeNull();
  });

  it('isPromptFallback without anything to compare is false', () => {
    expect(isPromptFallback('Anything', null, null)).toBe(false);
  });
});

describe('conversations', () => {
  it('endReasonFor maps clear / plan_mode_exit, everything else → unknown', () => {
    expect(endReasonFor('clear')).toBe('clear');
    expect(endReasonFor('plan_mode_exit')).toBe('plan_mode_exit');
    expect(endReasonFor('compact')).toBe('unknown');
    expect(endReasonFor(null)).toBe('unknown');
  });

  it('newConversation has every default explicit; withCurrentConversation replaces only the last', () => {
    const conv = newConversation(sampleId('cv', 2), SAMPLE_TIME, 'corr');
    expect(conv).toEqual({
      id: sampleId('cv', 2),
      sessionId: null,
      startedAt: SAMPLE_TIME,
      endedAt: null,
      endReason: null,
      title: null,
      resetCorrelationId: 'corr',
      costUsd: null,
      lastOrder: 0,
    });
    const entry = sampleEntry();
    const next = withCurrentConversation(
      { ...entry, conversations: [...entry.conversations, conv] },
      (c) => ({
        ...c,
        lastOrder: 9,
      }),
    );
    expect(next.conversations.map((c) => c.lastOrder)).toEqual([5, 9]);
  });

  it('cwdLabel and the plan prompt', () => {
    expect(cwdLabel('D:\\work\\repo\\')).toBe('repo');
    expect(cwdLabel('D:\\')).toBe('D:\\');
    expect(implementPlanPrompt('C:\\plans\\a.md', '# Plan')).toBe('Implement the plan in C:\\plans\\a.md');
    expect(implementPlanPrompt(null, '# Plan')).toBe('Implement this plan:\n\n# Plan');
  });
});
