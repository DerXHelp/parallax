import type { QueuedPrompt } from '@shared/model';
import type { Command } from '@shared/protocol';
import { sampleDecisions, sampleId } from '@shared/samples';
import type { PlaygroundDemo } from '@web/playground/types';
import type { FakeAck, FakeHost } from '@web/state/fake-host';
import type { FeatureSlots } from '@web/shell/slots';
import { DEMO_ENTRIES } from '../decisions/lib/demo-data';
import type { DemoHost } from '../decisions/lib/demo-host';
import { DemoButton, DemoSession } from '../decisions/lib/demo-session';
import { Composer } from './Composer';

/**
 * Playground demos of the composer (WP-16; `#playground=composer/<id>`) in the real SessionPane.
 * The FakeHost has no prompt queue (R1W-22): `simulateQueue` adds one – while the session works a
 * `next` prompt waits in `detail.queue` ("sending" → "queued") and is taken over after a while;
 * Stop ends the turn and takes the queue over. The queue shows in the header badge and – with
 * the transcript slot – grey at the end of the transcript, not in the composer (R2W-04).
 */

const TAKE_OVER_MS = 4000;

function setQueue(host: FakeHost, entryId: string, queue: QueuedPrompt[]): void {
  host.pushOps(entryId, [{ op: 'detail.patch', patch: { queue } }]);
  host.patchSummary(entryId, {}, { queuedPrompts: queue.length });
}

function takeOver(host: FakeHost, entryId: string): void {
  const view = host.view(entryId);
  if (view === null) return;
  let order = view.items.at(-1)?.order ?? 0;
  const ops = view.detail.queue.map((prompt) => ({
    op: 'item.upsert' as const,
    item: {
      kind: 'user_message' as const,
      id: prompt.messageUuid,
      order: ++order,
      at: new Date().toISOString(),
      parentToolUseId: null,
      text: prompt.text,
      attachments: [],
      origin: 'human' as const,
      slashCommand: null,
      priority: prompt.priority,
    },
  }));
  if (ops.length > 0) host.pushOps(entryId, ops);
  setQueue(host, entryId, []);
}

function simulateQueue(cmd: Command, host: FakeHost): FakeAck | undefined {
  if (cmd.name === 'session.sendPrompt' && cmd.priority === 'next') {
    const summary = host.summaries.get(cmd.entryId);
    if (summary?.status.runState !== 'working') return undefined;
    const messageUuid = crypto.randomUUID();
    const queued: QueuedPrompt = {
      messageUuid,
      text: { text: cmd.prompt.text, truncated: null },
      attachments: [],
      priority: 'next',
      state: 'sending',
      queuedAt: new Date().toISOString(),
    };
    setQueue(host, cmd.entryId, [...(host.view(cmd.entryId)?.detail.queue ?? []), queued]);
    host.later(() => {
      const queue = host.view(cmd.entryId)?.detail.queue ?? [];
      setQueue(
        host,
        cmd.entryId,
        queue.map((prompt) => (prompt.messageUuid === messageUuid ? { ...prompt, state: 'queued' } : prompt)),
      );
    }, 700);
    host.later(() => {
      takeOver(host, cmd.entryId);
    }, TAKE_OVER_MS);
    return { ok: true, result: { messageUuid } };
  }
  if (cmd.name === 'session.interrupt') {
    host.interruptStreams(cmd.entryId);
    takeOver(host, cmd.entryId);
    host.patchSummary(cmd.entryId, { lastActivityAt: new Date().toISOString() }, { runState: 'idle' });
    return { ok: true, result: { stillQueued: [] } };
  }
  return undefined;
}

let lateCounter = 0;

/** Opens a permission of the main agent or a subagent in the `working` demo session. */
function openLateDecision(running: DemoHost | null, requester: 'main' | 'subagent'): void {
  if (running === null) return;
  const entryId = DEMO_ENTRIES.working;
  lateCounter += 1;
  const decision = sampleDecisions.permission({
    entryId,
    id: sampleId('dc', 0xd00 + lateCounter),
    toolUseId: `toolu_demo_late_${String(lateCounter)}`,
    createdAt: new Date().toISOString(),
    input: { command: 'pnpm install', description: 'Install dependencies' },
    description: 'Install dependencies',
    requester:
      requester === 'main'
        ? { kind: 'main' }
        : {
            kind: 'subagent',
            agentId: 'agent_explore_1',
            description: 'Explore the store code',
            parentToolUseId: 'toolu_demo_agent',
          },
  });
  running.host.pushOps(entryId, [{ op: 'decision.upsert', decision }]);
  running.host.syncDecisionCounts(entryId);
}

export const demos: PlaygroundDemo[] = [
  {
    id: 'idle',
    title: 'Composer – idle (mode, model + effort, context 71 %)',
    description: 'Enter sends, Shift+Enter breaks the line; the draft survives a reload.',
    render: () => <DemoSession entries={['idle']} show="idle" />,
  },
  {
    id: 'working',
    title: 'Composer – working (queue, send now, stop, Esc)',
    description: 'Enter queues (priority next), "Send now" interrupts; Esc in the empty field stops.',
    render: () => <DemoSession entries={['working']} show="working" onCommand={simulateQueue} />,
  },
  {
    id: 'with-permission',
    title: 'Composer – open permission ("send as answer" = deny + message)',
    render: () => <DemoSession entries={['permission']} show="permission" />,
  },
  {
    id: 'late-decision',
    title: 'Composer – a decision appears while typing (target lock, R2W-01)',
    description:
      'Type first, then open a permission: Enter still queues the text; "Send as answer" answers explicitly.',
    render: () => (
      <DemoSession
        entries={['working']}
        show="working"
        onCommand={simulateQueue}
        controls={(host) => (
          <>
            <DemoButton
              label="Open a permission now"
              onClick={() => {
                openLateDecision(host.current, 'main');
              }}
            />
            <DemoButton
              label="Open a subagent permission"
              onClick={() => {
                openLateDecision(host.current, 'subagent');
              }}
            />
          </>
        )}
      />
    ),
  },
  {
    id: 'with-plan',
    title: 'Composer – open plan ("keep planning with feedback")',
    render: () => <DemoSession entries={['plan']} show="plan" />,
  },
  {
    id: 'bypass',
    title: 'Composer – profile allows bypass (red mode)',
    render: () => <DemoSession entries={['bypass']} show="bypass" />,
  },
];

export const slots: Partial<FeatureSlots> = { Composer };
