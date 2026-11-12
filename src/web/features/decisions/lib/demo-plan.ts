import type { EntryId } from '@shared/common';
import type { PlanDecision, ToolCallItem } from '@shared/model';
import { sampleDecisions, sampleId, sampleItems, samplePlanVersionInfo } from '@shared/samples';
import type { DemoHost } from './demo-host';

/**
 * Plan steps of the WP-56 playground demos and tests (dev/test only): Claude writes the plan file
 * (a `Write` whose input streams in chunks – `item.delta` on `inputPartial` like the real
 * normalizer), then asks for approval (ExitPlanMode → plan decision + stored version).
 */

function nextOrder(running: DemoHost, entryId: EntryId): number {
  return (running.host.view(entryId)?.items.at(-1)?.order ?? 0) + 1;
}

export interface PlanWriteOptions {
  path: string;
  text: string;
  /** Number of input chunks (default 24). */
  steps?: number;
  /** Pause between two chunks (default 120 ms). */
  intervalMs?: number;
  onDone?: () => void;
}

/**
 * Streams a `Write` of `text` to `path`: input chunks (`streaming_input`), `running`, then `done` –
 * the file lands in the FakeHost's table and the detail reports it as the plan file. Returns a
 * cancel function.
 */
export function streamPlanWrite(running: DemoHost, entryId: EntryId, options: PlanWriteOptions): () => void {
  const { host } = running;
  const order = nextOrder(running, entryId);
  const messageId = `msg_demo_planwrite_${String(order)}`;
  const toolUseId = `toolu_demo_planwrite_${String(order)}`;
  const input = { file_path: options.path, content: options.text };
  const raw = JSON.stringify(input);
  const steps = Math.max(1, options.steps ?? 24);
  const size = Math.ceil(raw.length / steps);
  const intervalMs = options.intervalMs ?? 120;
  const base: ToolCallItem = sampleItems.toolCall({
    id: `${messageId}:0`,
    messageId,
    blockIndex: 0,
    order,
    at: host.now(),
    toolUseId,
    toolName: 'Write',
    input: {},
    inputPartial: '',
    status: 'streaming_input',
    result: null,
    parentToolUseId: null,
  });
  let cancelled = false;
  host.pushOps(entryId, [{ op: 'item.upsert', item: base }]);
  let offset = 0;
  const finish = () => {
    if (cancelled) return;
    const at = host.now();
    running.setPlanFile(options.path, options.text);
    host.pushOps(entryId, [
      {
        op: 'item.upsert',
        item: {
          ...base,
          input,
          inputPartial: null,
          status: 'done',
          result: {
            isError: false,
            content: [{ type: 'text', text: { text: 'File created successfully', truncated: null } }],
            structured: null,
            structuredTruncated: null,
            at,
          },
        },
      },
      { op: 'detail.patch', patch: { planFile: { path: options.path, updatedAt: at, toolUseId } } },
    ]);
    options.onDone?.();
  };
  const step = () => {
    if (cancelled) return;
    if (offset >= raw.length) {
      host.pushOps(entryId, [
        { op: 'item.upsert', item: { ...base, input, inputPartial: null, status: 'running' } },
      ]);
      host.later(finish, intervalMs * 4);
      return;
    }
    const chunk = raw.slice(offset, offset + size);
    offset += size;
    host.pushOps(entryId, [{ op: 'item.delta', itemId: base.id, field: 'inputPartial', append: chunk }]);
    host.later(step, intervalMs);
  };
  host.later(step, intervalMs);
  return () => {
    cancelled = true;
  };
}

export interface PlanApprovalOptions {
  version: number;
  text: string;
  path: string;
  /** Low part of the decision id (`dc_…<n>`). */
  decision: number;
  previousVersionPlan?: string | null;
}

/** Claude calls ExitPlanMode: the version is stored (`plan.list`) and its decision opens. */
export function askPlanApproval(
  running: DemoHost,
  entryId: EntryId,
  options: PlanApprovalOptions,
): PlanDecision {
  const { host } = running;
  const view = host.view(entryId);
  const conversationId = view?.detail.conversationId ?? sampleId('cv', 1);
  const at = host.now();
  const order = nextOrder(running, entryId);
  const decision = sampleDecisions.plan({
    entryId,
    conversationId,
    id: sampleId('dc', options.decision),
    toolUseId: `toolu_demo_exitplan_${String(order)}`,
    createdAt: at,
    plan: options.text,
    planFilePath: options.path,
    version: options.version,
    previousVersionPlan: options.previousVersionPlan ?? null,
    approveModes: ['acceptEdits', 'auto', 'default'],
  });
  const stored = running.planVersions.get(entryId) ?? [];
  running.planVersions.set(entryId, [
    ...stored.filter((entry) => entry.info.version !== options.version),
    {
      info: samplePlanVersionInfo({
        version: options.version,
        decisionId: decision.id,
        conversationId,
        createdAt: at,
        planFilePath: options.path,
      }),
      text: options.text,
    },
  ]);
  const messageId = `msg_demo_exitplan_${String(order)}`;
  host.pushOps(entryId, [
    {
      op: 'item.upsert',
      item: sampleItems.toolCall({
        id: `${messageId}:0`,
        messageId,
        blockIndex: 0,
        order,
        at,
        toolUseId: decision.toolUseId,
        toolName: 'ExitPlanMode',
        input: { plan: options.text, planFilePath: options.path },
        status: 'awaiting_decision',
        result: null,
        parentToolUseId: null,
        decision: { decisionId: decision.id, kind: 'plan', planVersion: options.version, outcome: null },
      }),
    },
    { op: 'decision.upsert', decision },
    { op: 'detail.patch', patch: { latestPlanVersion: options.version } },
  ]);
  host.syncDecisionCounts(entryId);
  return decision;
}
