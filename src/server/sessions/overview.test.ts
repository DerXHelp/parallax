import { describe, expect, it } from 'vitest';
import type { TranscriptItem } from '@shared/model';
import { sampleItems, sampleRateLimitInfo, SAMPLE_TIME } from '@shared/samples';
import {
  ActivityTracker,
  activityTarget,
  autoTitleDescription,
  fallbackSummary,
  mergeUsage,
  regenerateTitleDescription,
  TITLE_DESCRIPTION_CHARS,
} from './overview';

type ToolCall = Extract<TranscriptItem, { kind: 'tool_call' }>;
type UserMessage = Extract<TranscriptItem, { kind: 'user_message' }>;
type AssistantText = Extract<TranscriptItem, { kind: 'assistant_text' }>;

const tool = (p: Partial<ToolCall>): ToolCall => sampleItems.toolCall(p);
const user = (order: number, text: string, p: Partial<UserMessage> = {}): UserMessage => ({
  ...sampleItems.userMessage(),
  id: `u${String(order)}`,
  order,
  text: { text, truncated: null },
  ...p,
});
const answer = (order: number, text: string, p: Partial<AssistantText> = {}): AssistantText => ({
  ...sampleItems.assistantText(),
  id: `a${String(order)}`,
  order,
  text,
  ...p,
});

describe('activityTarget (the transcript line wording)', () => {
  it.each<[string, unknown, string | null]>([
    ['Bash', { command: 'pnpm test', description: 'Run the tests' }, 'Run the tests'],
    ['Bash', { command: 'pnpm test\n--watch' }, 'pnpm test'],
    ['Write', { file_path: 'D:\\work\\app\\src\\lib\\handy.txt' }, '…/src/lib/handy.txt'],
    ['Read', { file_path: 'notes.md' }, 'notes.md'],
    ['Grep', { pattern: 'TODO', path: 'src' }, 'TODO'],
    ['WebFetch', { url: 'https://example.com/a' }, 'https://example.com/a'],
    ['Agent', { description: 'Research', prompt: 'long' }, 'Research'],
    ['TodoWrite', { todos: [] }, null],
    ['mcp__github__search', { query: 'issue', page: 2 }, 'issue'],
    ['Bash', 'not an object', null],
  ])('%s %j → %s', (name, input, expected) => {
    expect(activityTarget(name, input)).toBe(expected);
  });
});

describe('ActivityTracker', () => {
  it('thinking → newest running main-thread tool → the CLI sentence wins; ended tools drop out', () => {
    const t = new ActivityTracker();
    expect(t.current()).toEqual({ kind: 'thinking' });
    expect(t.apply(tool({ toolUseId: 'a', order: 1, toolName: 'Read', input: { file_path: 'a.md' }, status: 'running' }))).toBe(true);
    expect(t.apply(tool({ toolUseId: 'b', order: 2, toolName: 'Bash', input: { command: 'ls' }, status: 'pending' }))).toBe(true);
    expect(t.current()).toEqual({ kind: 'tool', tool: 'Bash', target: 'ls' });
    // Same call again (status pending → running): no change.
    expect(t.apply(tool({ toolUseId: 'b', order: 2, toolName: 'Bash', input: { command: 'ls' }, status: 'running' }))).toBe(false);
    // Subagent calls never count.
    expect(t.apply(tool({ toolUseId: 'c', order: 3, toolName: 'Grep', parentToolUseId: 'b', status: 'running' }))).toBe(false);
    expect(t.apply(tool({ toolUseId: 'b', order: 2, toolName: 'Bash', input: { command: 'ls' }, status: 'background' }))).toBe(true);
    expect(t.current()).toEqual({ kind: 'tool', tool: 'Read', target: 'a.md' });
    expect(t.setSentence('Reading the notes')).toBe(true);
    expect(t.current()).toEqual({ kind: 'claude', text: 'Reading the notes' });
    t.reset();
    expect(t.current()).toEqual({ kind: 'thinking' });
  });
});

describe('fallbackSummary', () => {
  it.each<[string | null, string | null]>([
    ['**Summary:** all tests pass.\n\nDetails…', 'Summary: all tests pass.'],
    ['# Result\nok', 'Result'],
    ['```ts\nconst a = 1;\n```\nThe constant is set.', 'The constant is set.'],
    ['---\n\n- [x] Done: see `src/a.ts` and [docs](https://x.y)', '[x] Done: see src/a.ts and docs'],
    ['| a | b |\n|---|---|', 'a | b'],
    ['   \n  ', null],
    [null, null],
  ])('%j → %j', (text, expected) => {
    expect(fallbackSummary(text)).toBe(expected);
  });

  it('long lines are cut to 200 chars', () => {
    expect(fallbackSummary('word '.repeat(100))?.length).toBe(200);
  });
});

describe('title descriptions', () => {
  const items = [
    user(1, 'Fix the login bug'),
    answer(2, 'The token expired too early.'),
    user(3, '/compact', { slashCommand: '/compact' }),
    user(4, 'Now add a test'),
    answer(5, 'Added a regression test.'),
    answer(6, 'Rename echo', { localCommand: { command: 'rename', args: 'x' } }),
  ];

  it('auto: first prompt + start of the first answer', () => {
    expect(autoTitleDescription(items)).toBe('Fix the login bug\n\nThe token expired too early.');
    expect(autoTitleDescription([answer(1, 'only an answer')])).toBeNull();
    expect(autoTitleDescription([user(1, 'x'.repeat(5000))])?.length).toBeLessThanOrEqual(TITLE_DESCRIPTION_CHARS);
  });

  it('again: first prompt, last prompt, start of the last answer; the title without prompts', () => {
    expect(regenerateTitleDescription(items, 'Old')).toBe(
      'Fix the login bug\n\nNow add a test\n\nAdded a regression test.',
    );
    expect(regenerateTitleDescription([], 'Old title')).toBe('Old title');
    expect(regenerateTitleDescription([], '')).toBeNull();
  });
});

describe('mergeUsage', () => {
  it('windows replace the stored ones, cleared ones drop, the event fields stay', () => {
    const prev = sampleRateLimitInfo({
      status: 'allowed_warning',
      rateLimitType: 'seven_day',
      utilization: 0.81,
      windows: {
        five_hour: { utilization: 0.1, resetsAt: null },
        seven_day_opus: { utilization: 0.5, resetsAt: null },
      },
    });
    const merged = mergeUsage(
      prev,
      {
        windows: { seven_day: { utilization: 0.83, resetsAt: SAMPLE_TIME }, five_hour: { utilization: 0.2, resetsAt: null } },
        cleared: ['seven_day_opus'],
      },
      SAMPLE_TIME,
    );
    expect(merged).toMatchObject({
      status: 'allowed_warning',
      rateLimitType: 'seven_day',
      utilization: 0.83,
      resetsAt: SAMPLE_TIME,
      at: SAMPLE_TIME,
      windows: {
        five_hour: { utilization: 0.2, resetsAt: null },
        seven_day: { utilization: 0.83, resetsAt: SAMPLE_TIME },
      },
    });
    expect(merged.windows.seven_day_opus).toBeUndefined();
  });

  it('without an earlier event: status allowed, no type', () => {
    expect(mergeUsage(undefined, { windows: {}, cleared: [] }, SAMPLE_TIME)).toEqual({
      status: 'allowed',
      rateLimitType: null,
      resetsAt: null,
      utilization: null,
      windows: {},
      at: SAMPLE_TIME,
    });
  });
});
