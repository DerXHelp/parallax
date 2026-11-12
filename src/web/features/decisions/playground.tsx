import { useRef, type RefObject } from 'react';
import { LOCAL_HOST_ID, makeSessionKey } from '@shared/common';
import { makeError } from '@shared/errors';
import type { SessionOp } from '@shared/protocol';
import { sampleId } from '@shared/samples';
import type { PlaygroundDemo } from '@web/playground/types';
import { requestShell } from '@web/shell/requests';
import type { FeatureSlots } from '@web/shell/slots';
import { DecisionBar } from './DecisionBar';
import { DecisionCard } from './DecisionCard';
import { DEMO_ENTRIES, DEMO_PLAN, DEMO_PLAN_V1, DEMO_PLANNING_PATH, type DemoEntry } from './lib/demo-data';
import type { DemoHost } from './lib/demo-host';
import { askPlanApproval, streamPlanWrite } from './lib/demo-plan';
import { DemoButton, DemoSession } from './lib/demo-session';
import { PlanSidePanel } from './PlanSidePanel';

/**
 * Playground demos of the decision bar and cards (WP-16; `#playground=decisions/<id>`). Every demo
 * runs the real SessionPane over a FakeHost: answers go through `decision.respond` and land in
 * the transcript's tool call (architecture §2.3e). Titles are developer text. WP-56 adds the plan
 * comfort demos (`plan-*`): live plan file, versions with diff, approved (fresh), 75 % context and
 * the errors of a fresh start.
 */

/** Opens the plan tab of a demo session like the header's "Plan" button (WP-58). */
function OpenPlanTab({ entry }: { entry: DemoEntry }) {
  return (
    <DemoButton
      label="Open the plan tab"
      onClick={() => {
        requestShell({
          kind: 'sidePanel',
          sessionKey: makeSessionKey(LOCAL_HOST_ID, DEMO_ENTRIES[entry]),
          tab: 'plan',
        });
      }}
    />
  );
}

/** The `planning` session: Claude writes the plan file (streamed), then asks for approval. */
function PlanLiveDemo() {
  const version = useRef(0);
  const write = (host: RefObject<DemoHost | null>) => {
    const running = host.current;
    if (running === null) return;
    const text = version.current === 0 ? DEMO_PLAN_V1 : DEMO_PLAN;
    streamPlanWrite(running, DEMO_ENTRIES.planning, { path: DEMO_PLANNING_PATH, text, steps: 40 });
  };
  const ask = (host: RefObject<DemoHost | null>) => {
    const running = host.current;
    if (running === null) return;
    version.current += 1;
    const next = version.current;
    askPlanApproval(running, DEMO_ENTRIES.planning, {
      version: next,
      text: next === 1 ? DEMO_PLAN_V1 : DEMO_PLAN,
      path: DEMO_PLANNING_PATH,
      decision: 0xab0 + next,
      previousVersionPlan: next === 1 ? null : DEMO_PLAN_V1,
    });
  };
  return (
    <DemoSession
      entries={['planning']}
      show="planning"
      controls={(host) => (
        <>
          <OpenPlanTab entry="planning" />
          <DemoButton
            label="Claude writes the plan file"
            onClick={() => {
              write(host);
            }}
          />
          <DemoButton
            label="Claude asks for approval (next version)"
            onClick={() => {
              ask(host);
            }}
          />
        </>
      )}
    />
  );
}

type FreshFailure = 'none' | 'startup';

/**
 * The `fresh` session (75 % context) with failing fresh starts: SESSION_BUSY / MODE_NOT_ALLOWED
 * are checked before the decision closes (error in the card), a start failure comes after it
 * closed (notice).
 */
function FreshErrorsDemo() {
  const failure = useRef<FreshFailure>('none');
  const failNext = (host: RefObject<DemoHost | null>, code: 'SESSION_BUSY' | 'MODE_NOT_ALLOWED') => {
    host.current?.host.failNext('decision.respond', makeError(code));
  };
  return (
    <DemoSession
      entries={['fresh']}
      show="fresh"
      onCommand={(cmd, fake) => {
        if (cmd.name !== 'decision.respond' || failure.current !== 'startup') return undefined;
        failure.current = 'none';
        const response = cmd.response.kind === 'plan' ? cmd.response.response : null;
        const mode = response?.behavior === 'approve_fresh_context' ? response.mode : 'acceptEdits';
        const outcome = { type: 'plan_approved', mode, edited: false, freshContext: true } as const;
        // Like the engine: the old request is denied and closed, then the new conversation fails.
        const view = fake.view(cmd.entryId);
        const decision = view?.decisions.find((candidate) => candidate.id === cmd.decisionId);
        const toolCall = view?.items.find(
          (item) => item.kind === 'tool_call' && item.toolUseId === decision?.toolUseId,
        );
        const ops: SessionOp[] = [
          { op: 'decision.resolved', decisionId: cmd.decisionId, outcome, byClientId: null, at: fake.now() },
        ];
        if (toolCall?.kind === 'tool_call' && toolCall.decision !== null) {
          ops.push({
            op: 'item.upsert',
            item: { ...toolCall, status: 'denied', decision: { ...toolCall.decision, outcome } },
          });
        }
        fake.pushOps(cmd.entryId, ops);
        fake.syncDecisionCounts(cmd.entryId);
        return { ok: false, error: makeError('CLAUDE_STARTUP_FAILED') };
      }}
      controls={(host) => (
        <>
          <OpenPlanTab entry="fresh" />
          <DemoButton
            label="Next answer: SESSION_BUSY"
            onClick={() => {
              failNext(host, 'SESSION_BUSY');
            }}
          />
          <DemoButton
            label="Next answer: MODE_NOT_ALLOWED"
            onClick={() => {
              failNext(host, 'MODE_NOT_ALLOWED');
            }}
          />
          <DemoButton
            label="Next answer: the new conversation fails to start"
            onClick={() => {
              failure.current = 'startup';
            }}
          />
        </>
      )}
    />
  );
}

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
      ? ({ type: 'plan_approved', mode: 'acceptEdits', edited: false, freshContext: false } as const)
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
  {
    id: 'plan-live',
    title: 'Plan tab – the plan file live while Claude writes it',
    description:
      'Open the plan tab, then "Claude writes the plan file": the Write input streams in steps (inputPartial). Afterwards the file is read; "asks for approval" stores the next version.',
    render: () => <PlanLiveDemo />,
  },
  {
    id: 'plan-versions',
    title: 'Plan tab – two versions with diff',
    description:
      'v2 is open, v1 was sent back with feedback: version picker, "Changes to v1", plan file link.',
    render: () => (
      <DemoSession entries={['plan']} show="plan" controls={() => <OpenPlanTab entry="plan" />} />
    ),
  },
  {
    id: 'plan-approved',
    title: 'Plan tab – approved (accept edits)',
    description: 'The plan tab stays usable after the approval (header "Plan" button, WP-58).',
    render: () => (
      <DemoSession entries={['approved']} show="approved" controls={() => <OpenPlanTab entry="approved" />} />
    ),
  },
  {
    id: 'plan-approved-fresh',
    title: 'Plan tab – implemented in a new conversation',
    render: () => (
      <DemoSession
        entries={['approvedFresh']}
        show="approvedFresh"
        controls={() => <OpenPlanTab entry="approvedFresh" />}
      />
    ),
  },
  {
    id: 'plan-fresh',
    title: 'Plan v3 at 75 % context – "fresh context" recommended',
    description:
      'The ▾ menu marks "With fresh context" as recommended (never preselected); the choice is remembered.',
    render: () => (
      <DemoSession entries={['fresh']} show="fresh" controls={() => <OpenPlanTab entry="fresh" />} />
    ),
  },
  {
    id: 'plan-fresh-errors',
    title: 'Plan – errors of a fresh start',
    description:
      'Pick "With fresh context" in the ▾ menu, choose the next failure, then implement: busy / mode errors show in the card, a start failure as a notice.',
    render: () => <FreshErrorsDemo />,
  },
];

/** Real components for the playground's shell demos (module constant, R1-web hints). */
export const slots: Partial<FeatureSlots> = {
  DecisionBar,
  DecisionCard,
  PlanPanel: PlanSidePanel,
};
