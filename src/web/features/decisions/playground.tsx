import type { RefObject } from 'react';
import type { SessionOp } from '@shared/protocol';
import { sampleId } from '@shared/samples';
import type { PlaygroundDemo } from '@web/playground/types';
import type { FeatureSlots } from '@web/shell/slots';
import { DecisionBar } from './DecisionBar';
import { DecisionCard } from './DecisionCard';
import { DEMO_ENTRIES } from './lib/demo-data';
import type { DemoHost } from './lib/demo-host';
import { DemoButton, DemoSession } from './lib/demo-session';
import { PlanSidePanel } from './PlanSidePanel';

/**
 * Playground demos of the decision bar and cards (WP-16; `#playground=decisions/<id>`). Every demo
 * runs the real SessionPane over a FakeHost: answers go through `decision.respond` and land in
 * the transcript's tool call (architecture §2.3e). Titles are developer text.
 */

/** Simulates another window answering the oldest open decision (`decision.resolved`, A.2). */
function resolveElsewhere(host: RefObject<DemoHost | null>, entry: keyof typeof DEMO_ENTRIES): void {
  const running = host.current;
  if (running === null) return;
  const entryId = DEMO_ENTRIES[entry];
  const view = running.host.view(entryId);
  const decision = view?.decisions.find((candidate) => candidate.state === 'open');
  if (view === null || decision === undefined) return;
  const outcome =
    decision.kind === 'plan'
      ? ({ type: 'plan_approved', mode: 'acceptEdits', edited: false } as const)
      : decision.kind === 'question'
        ? ({ type: 'answered' } as const)
        : ({ type: 'allowed', remember: null, acceptEdits: false } as const);
  const toolCall = view.items.find(
    (item) => item.kind === 'tool_call' && item.toolUseId === decision.toolUseId,
  );
  const ops: SessionOp[] = [
    {
      op: 'decision.resolved',
      decisionId: decision.id,
      outcome,
      byClientId: sampleId('cl', 0xbeef),
      at: new Date().toISOString(),
    },
  ];
  if (toolCall?.kind === 'tool_call') {
    ops.push({
      op: 'item.upsert',
      item: {
        ...toolCall,
        status: 'running',
        decision: {
          decisionId: decision.id,
          kind: decision.kind,
          planVersion: decision.kind === 'plan' ? decision.version : null,
          outcome,
        },
      },
    });
  }
  running.host.pushOps(entryId, ops);
  running.host.syncDecisionCounts(entryId);
}

/** Simulates Claude withdrawing the request (`cancelled`, signal aborted). */
function withdraw(host: RefObject<DemoHost | null>, entry: keyof typeof DEMO_ENTRIES): void {
  const running = host.current;
  if (running === null) return;
  const entryId = DEMO_ENTRIES[entry];
  const decision = running.host.view(entryId)?.decisions.find((candidate) => candidate.state === 'open');
  if (decision === undefined) return;
  running.host.pushOps(entryId, [
    {
      op: 'decision.resolved',
      decisionId: decision.id,
      outcome: { type: 'cancelled', reason: 'signal_aborted' },
      byClientId: null,
      at: new Date().toISOString(),
    },
  ]);
  running.host.syncDecisionCounts(entryId);
}

export const demos: PlaygroundDemo[] = [
  {
    id: 'permission',
    title: 'Decisions – permission (Bash, remember destinations)',
    description: 'Allow once / always (session, local, project = repo, user = global) / accept edits / deny.',
    render: () => <DemoSession entries={['permission']} show="permission" />,
  },
  {
    id: 'permission-edit',
    title: 'Decisions – permission (Edit with diff preview)',
    description: 'Edit/Write: the change preview comes from the ToolInputPreview slot (WP-15).',
    render: () => <DemoSession entries={['edit']} show="edit" />,
  },
  {
    id: 'permission-cautious',
    title: 'Decisions – permission (defaultToNo, no "always")',
    description: 'suppressAlwaysAllowRule hides "always allow"; defaultToNo makes "deny" the main action.',
    render: () => <DemoSession entries={['cautious']} show="cautious" />,
  },
  {
    id: 'question',
    title: 'Decisions – question (previews, other, notes, multi-select)',
    render: () => <DemoSession entries={['question']} show="question" />,
  },
  {
    id: 'plan',
    title: 'Decisions – plan v2 (implement ▾, keep planning, side panel)',
    description: 'Type feedback in the composer: "Keep planning with feedback". Context 78 %.',
    render: () => <DemoSession entries={['plan']} show="plan" />,
  },
  {
    id: 'queue',
    title: 'Decisions – three at once (+2 more, subagent asks)',
    render: () => <DemoSession entries={['queue']} show="queue" />,
  },
  {
    id: 'expired',
    title: 'Decisions – expired after restart (continue & implement)',
    render: () => <DemoSession entries={['expired']} show="expired" />,
  },
  {
    id: 'resolved-elsewhere',
    title: 'Decisions – answered in another window / withdrawn',
    description: 'The card disappears with a short notice (bottom right).',
    render: () => (
      <DemoSession
        entries={['queue']}
        show="queue"
        controls={(host) => (
          <>
            <DemoButton
              label="Answer the oldest in another window"
              onClick={() => {
                resolveElsewhere(host, 'queue');
              }}
            />
            <DemoButton
              label="Claude withdraws the oldest"
              onClick={() => {
                withdraw(host, 'queue');
              }}
            />
          </>
        )}
      />
    ),
  },
  {
    id: 'transcript-card',
    title: 'Decisions – plan card in the transcript (read-only, "Go to decision")',
    render: () => (
      <DemoSession
        entries={['plan']}
        show="plan"
        above={(sessionKey) => (
          <DecisionCard sessionKey={sessionKey} decisionId={sampleId('dc', 0xa41)} placement="transcript" />
        )}
      />
    ),
  },
];

/** Real components for the playground's shell demos (module constant, R1-web hints). */
export const slots: Partial<FeatureSlots> = {
  DecisionBar,
  DecisionCard,
  SidePanel: PlanSidePanel,
};
