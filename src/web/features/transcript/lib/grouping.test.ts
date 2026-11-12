import { describe, expect, it } from 'vitest';
import type { TranscriptItem } from '@shared/model';
import {
  sampleBlobRef,
  sampleId,
  sampleItems,
  sampleRateLimitInfo,
  sampleSystemItems,
  sampleTime,
} from '@shared/samples';
import {
  MIN_GROUP_SIZE,
  buildRows,
  classifyItem,
  groupKey,
  summarizeGroup,
  type ItemCode,
  type TranscriptRowModel,
} from './grouping';

const user = (id: string) => sampleItems.userMessage({ id });
const text = (id: string) => sampleItems.assistantText({ id });
const thinking = (id: string, streaming = false) => sampleItems.thinking({ id, streaming });
const bash = (id: string, p: Partial<Extract<TranscriptItem, { kind: 'tool_call' }>> = {}) =>
  sampleItems.toolCall({ id, toolUseId: `tu-${id}`, ...p });
const shot = (id: string) =>
  sampleItems.toolCall({
    id,
    toolUseId: `tu-${id}`,
    toolName: 'Read',
    input: { file_path: `C:\\shots\\${id}.png` },
    result: {
      isError: false,
      content: [{ type: 'image', image: sampleBlobRef({ blobId: `b${id}` }) }],
      structured: null,
      structuredTruncated: null,
      at: sampleTime(10),
    },
  });

function rowsOf(items: readonly TranscriptItem[], mode: 'compact' | 'all', open: readonly string[] = []) {
  const ids = items.map((item) => item.id);
  const codes = items.map(classifyItem);
  return buildRows(ids, codes, mode, (key) => open.includes(key));
}

/** Short form of the rows: `item:x`, `>item:x` (nested), `item:x-` (pictures hidden), `group:a,b[+img]`. */
function shape(rows: readonly TranscriptRowModel[]): string[] {
  return rows.map((row) => {
    switch (row.kind) {
      case 'item':
        return `${row.nested ? '>' : ''}item:${row.id}${row.hideImages ? '-' : ''}`;
      case 'group':
        return `group:${row.ids.join(',')}${row.imageIds.length > 0 ? `[${row.imageIds.join(',')}]` : ''}${row.open ? ' open' : ''}`;
      case 'gallery':
        return `gallery:${row.ids.join(',')}`;
    }
  });
}

describe('classifyItem (WP-63 §1.5 roles)', () => {
  it('messages, texts, footer, decisions, cards, errors and boundaries are visible', () => {
    const visible: TranscriptItem[] = [
      user('u'),
      text('t'),
      sampleItems.turnResult(),
      bash('d', {
        decision: { decisionId: sampleId('dc', 1), kind: 'permission', planVersion: null, outcome: null },
      }),
      bash('q', { toolName: 'AskUserQuestion' }),
      bash('p', { toolName: 'ExitPlanMode' }),
      bash('a', { toolName: 'Agent' }),
      sampleSystemItems.error(),
      sampleSystemItems.compact_boundary(),
      sampleSystemItems.api_retry(),
      sampleSystemItems.model_fallback(),
      sampleSystemItems.permission_denied(),
      sampleSystemItems.interrupted(),
      sampleSystemItems.conversation_reset(),
      sampleSystemItems.informational({ level: 'warning' }),
      sampleSystemItems.rate_limit({ info: sampleRateLimitInfo({ status: 'rejected' }) }),
    ];
    expect(visible.map(classifyItem)).toEqual(visible.map(() => 'v'));
  });

  it('thinking, plain tool calls and quiet system items are steps; pictures are marked', () => {
    const steps: TranscriptItem[] = [
      thinking('k'),
      bash('b'),
      sampleSystemItems.hook(),
      sampleSystemItems.memory_recall(),
      sampleSystemItems.informational({ level: 'info' }),
    ];
    expect(steps.map(classifyItem)).toEqual(steps.map(() => 's'));
    expect(classifyItem(shot('s'))).toBe('i');
  });

  it('§1.2: rate_limit allowed / allowed_warning is hidden (older logs)', () => {
    for (const status of ['allowed', 'allowed_warning'] as const) {
      expect(classifyItem(sampleSystemItems.rate_limit({ info: sampleRateLimitInfo({ status }) }))).toBe('h');
    }
  });
});

describe('buildRows – compact', () => {
  it('a run of steps between two visible entries becomes one group row (collapsed)', () => {
    const rows = rowsOf(
      [
        user('u'),
        thinking('k1'),
        bash('b1'),
        thinking('k2'),
        bash('b2'),
        text('t'),
        sampleItems.turnResult({ id: 'r' }),
      ],
      'compact',
    );
    expect(shape(rows)).toEqual(['item:u', 'group:k1,b1,k2,b2', 'item:t', 'item:r']);
    expect(rows[1]).toMatchObject({ key: groupKey('k1') });
  });

  it('an open group is followed by its steps as nested rows', () => {
    const rows = rowsOf([user('u'), thinking('k1'), bash('b1'), text('t')], 'compact', [groupKey('k1')]);
    expect(shape(rows)).toEqual(['item:u', 'group:k1,b1 open', '>item:k1', '>item:b1', 'item:t']);
  });

  it(`a single step stays a plain row (groups from ${String(MIN_GROUP_SIZE)} steps)`, () => {
    expect(shape(rowsOf([user('u'), bash('b1'), text('t'), shot('s1'), text('t2')], 'compact'))).toEqual([
      'item:u',
      'item:b1',
      'item:t',
      'item:s1',
      'item:t2',
    ]);
  });

  it('pictures of a group: listed for its gallery, hidden in the nested rows', () => {
    const items = [user('u'), shot('s1'), thinking('k'), shot('s2'), bash('b')];
    expect(shape(rowsOf(items, 'compact'))).toEqual(['item:u', 'group:s1,k,s2,b[s1,s2]']);
    expect(shape(rowsOf(items, 'compact', [groupKey('s1')]))).toEqual([
      'item:u',
      'group:s1,k,s2,b[s1,s2] open',
      '>item:s1-',
      '>item:k-',
      '>item:s2-',
      '>item:b-',
    ]);
  });

  it('hidden rate-limit warnings neither show nor split a group', () => {
    const warning = sampleSystemItems.rate_limit({
      id: 'w',
      info: sampleRateLimitInfo({ status: 'allowed_warning' }),
    });
    expect(shape(rowsOf([bash('b1'), warning, bash('b2')], 'compact'))).toEqual(['group:b1,b2']);
  });

  it('the group key stays while the group grows; a visible entry starts a new group', () => {
    const grow = (items: TranscriptItem[]) => rowsOf(items, 'compact').filter((row) => row.kind === 'group');
    expect(grow([bash('b1'), bash('b2')])[0]?.key).toBe(groupKey('b1'));
    expect(grow([bash('b1'), bash('b2'), bash('b3')])[0]?.key).toBe(groupKey('b1'));
    expect(grow([bash('b1'), bash('b2'), text('t'), bash('b3'), bash('b4')]).map((row) => row.key)).toEqual([
      groupKey('b1'),
      groupKey('b3'),
    ]);
  });

  it('missing codes count as visible (never drops an item)', () => {
    expect(shape(buildRows(['a', 'b'], ['s'] satisfies ItemCode[], 'compact', () => false))).toEqual([
      'item:a',
      'item:b',
    ]);
  });

  it('is linear: 20 000 items in one pass', () => {
    const items: TranscriptItem[] = [];
    for (let i = 0; i < 10_000; i++) items.push(thinking(`k${String(i)}`), bash(`b${String(i)}`));
    const started = performance.now();
    const rows = rowsOf(items, 'compact');
    expect(rows).toHaveLength(1);
    expect(performance.now() - started).toBeLessThan(500);
  });
});

describe('buildRows – all steps', () => {
  it('every item is a row; adjacent picture results share one gallery row after them', () => {
    const items = [user('u'), shot('s1'), shot('s2'), shot('s3'), thinking('k'), shot('s4'), text('t')];
    expect(shape(rowsOf(items, 'all'))).toEqual([
      'item:u',
      'item:s1-',
      'item:s2-',
      'item:s3-',
      'gallery:s1,s2,s3',
      'item:k',
      'item:s4',
      'item:t',
    ]);
  });

  it('hidden rate-limit warnings are left out here too', () => {
    const warning = sampleSystemItems.rate_limit({
      id: 'w',
      info: sampleRateLimitInfo({ status: 'allowed' }),
    });
    expect(shape(rowsOf([user('u'), warning, text('t')], 'all'))).toEqual(['item:u', 'item:t']);
  });
});

describe('summarizeGroup', () => {
  it('counts tools (most frequent first), thoughts, notices and errors; times from first to last result', () => {
    const summary = summarizeGroup([
      thinking('k1'),
      bash('b1'),
      bash('b2', { status: 'error' }),
      sampleItems.toolCall({ id: 'r1', toolName: 'Read' }),
      bash('b3', {
        result: {
          isError: true,
          content: [],
          structured: null,
          structuredTruncated: null,
          at: sampleTime(100),
        },
      }),
      sampleSystemItems.hook(),
      null,
    ]);
    expect(summary).toMatchObject({
      tools: 4,
      thoughts: 1,
      notices: 1,
      errors: 2,
      running: null,
      toolCounts: [
        { name: 'Bash', count: 3 },
        { name: 'Read', count: 1 },
      ],
    });
    expect(summary.startAt).toBe(Date.parse(sampleTime(2)));
    expect(summary.endAt).toBe(Date.parse(sampleTime(100)));
  });

  it('the last active member is the running step', () => {
    const running = bash('b2', { status: 'running', result: null });
    expect(summarizeGroup([bash('b1'), running]).running).toBe(running);
    const streaming = thinking('k', true);
    expect(summarizeGroup([bash('b1'), streaming]).running).toBe(streaming);
    expect(summarizeGroup([bash('b1', { status: 'background' })]).running).toBeNull();
  });
});
