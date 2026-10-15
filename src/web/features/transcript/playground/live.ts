import type { SessionOp } from '@shared/protocol';
import { sampleItems, sampleUuid } from '@shared/samples';
import type { FakeHost } from '@web/state/fake-host';
import { DEMO_ENTRIES } from './data';

/**
 * Live script of the streaming demo (dev only): per round a prompt, streamed thinking (`item.delta`
 * thinking), a tool call whose input streams (`inputPartial`) and then runs, a streamed Markdown
 * answer with a code fence (highlighted only once the fence is closed) and a turn footer.
 */

const ANSWER = [
  'Here is the **gap check** – streamed block by block:',
  '',
  '1. Earlier blocks are memoized.',
  '2. Only the last block is parsed again.',
  '',
  '```ts',
  'export function hasGap(seqs: readonly number[], from: number): boolean {',
  '  return seqs.some((seq, i) => seq !== from + 1 + i);',
  '}',
  '```',
  '',
  'The code block above is highlighted once its fence is closed. See https://example.com for more.',
].join('\n');

const THINKING = 'The user wants a gap check. Read sync.ts first, then answer with a short code sample.';
const TOOL_INPUT =
  '{"file_path":"D:\\\\work\\\\parallax\\\\src\\\\shared\\\\sync.ts","offset":170,"limit":3}';

function chunks(text: string, size: number): string[] {
  const result: string[] = [];
  for (let i = 0; i < text.length; i += size) result.push(text.slice(i, i + size));
  return result;
}

export function startStreamingDemo(host: FakeHost, now: () => number): () => void {
  const entryId = DEMO_ENTRIES.streaming;
  let stopped = false;
  let round = 0;
  let cancelStream: (() => void) | null = null;
  const iso = () => new Date(now()).toISOString();
  const push = (ops: SessionOp[]) => {
    if (!stopped) host.pushOps(entryId, ops);
  };
  /** Runs the steps one after another, `interval` ms apart. */
  const sequence = (steps: (() => void)[], interval: number, done: () => void) => {
    let index = 0;
    const next = () => {
      if (stopped) return;
      const step = steps[index++];
      if (step === undefined) {
        done();
        return;
      }
      step();
      host.later(next, interval);
    };
    next();
  };

  const runRound = () => {
    if (stopped || round >= 10) return;
    round++;
    const base = (host.view(entryId)?.items.at(-1)?.order ?? 0) + 1;
    const messageId = `msg_live${String(round)}`;
    const thinking = sampleItems.thinking({
      id: `${messageId}:0`,
      messageId,
      blockIndex: 0,
      order: base + 1,
      at: iso(),
      text: { text: '', truncated: null },
      streaming: true,
    });
    const tool = sampleItems.toolCall({
      id: `${messageId}:1`,
      messageId,
      blockIndex: 1,
      order: base + 2,
      at: iso(),
      toolUseId: `toolu_live_${String(round)}`,
      toolName: 'Read',
      input: {},
      inputPartial: '',
      status: 'streaming_input',
      result: null,
    });
    const finalInput = { file_path: 'D:\\work\\parallax\\src\\shared\\sync.ts', offset: 170, limit: 3 };
    host.patchSummary(entryId, { lastActivityAt: iso() }, { runState: 'working' });
    push([
      {
        op: 'item.upsert',
        item: sampleItems.userMessage({
          id: `px:live:${String(round)}`,
          order: base,
          at: iso(),
          text: {
            text: round === 1 ? 'How do I detect a gap in seq ops?' : 'Once more, please.',
            truncated: null,
          },
        }),
      },
      { op: 'item.upsert', item: thinking },
    ]);
    const steps: (() => void)[] = [
      ...chunks(THINKING, 6).map((part) => () => {
        push([{ op: 'item.delta', itemId: thinking.id, field: 'thinking', append: part }]);
      }),
      () => {
        push([
          {
            op: 'item.upsert',
            item: { ...thinking, text: { text: THINKING, truncated: null }, streaming: false },
          },
          { op: 'item.upsert', item: tool },
        ]);
      },
      ...chunks(TOOL_INPUT, 8).map((part) => () => {
        push([{ op: 'item.delta', itemId: tool.id, field: 'inputPartial', append: part }]);
      }),
      () => {
        push([
          { op: 'item.upsert', item: { ...tool, input: finalInput, inputPartial: null, status: 'running' } },
        ]);
      },
      () => {
        push([
          {
            op: 'item.upsert',
            item: {
              ...tool,
              input: finalInput,
              inputPartial: null,
              status: 'done',
              result: {
                isError: false,
                content: [
                  {
                    type: 'text',
                    text: {
                      text: '170\texport function applySeqOps(\n171\t  state: SessionViewState,\n172\t  ops: readonly SeqOp[],',
                      truncated: null,
                    },
                  },
                ],
                structured: null,
                structuredTruncated: null,
                at: iso(),
              },
            },
          },
        ]);
      },
    ];
    sequence(steps, 45, () => {
      if (stopped) return;
      cancelStream = host.streamAssistantText(entryId, {
        item: sampleItems.assistantText({
          id: `${messageId}:2`,
          messageId,
          blockIndex: 2,
          order: base + 3,
          at: iso(),
          text: '',
          streaming: true,
        }),
        text: ANSWER,
        chunkSize: 5,
        intervalMs: 30,
        onDone: () => {
          push([
            {
              op: 'item.upsert',
              item: sampleItems.turnResult({
                id: sampleUuid(3000 + round),
                order: base + 4,
                at: iso(),
                durationMs: 6400,
                userMessageUuids: [`px:live:${String(round)}`],
              }),
            },
          ]);
          host.patchSummary(entryId, { lastActivityAt: iso() }, { runState: 'idle' });
          host.later(runRound, 5000);
        },
      });
    });
  };

  host.later(runRound, 500);
  return () => {
    stopped = true;
    cancelStream?.();
  };
}
