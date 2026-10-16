/**
 * Test harness (WP-12 tests; usable by WP-13 engine tests): replays fixture-format-v1 events
 * through the live normalizer the way the engine would (registerPrompt on `input`,
 * attachDecision on `canUseTool`/`decision`, startConversation after `conversation_reset`,
 * finalizeOpen on `exit`) and feeds the signals into the status machine. Deterministic: times
 * come from header.recordedAt + tMs, ids from @shared/samples, blobs are sha256 of their bytes.
 */
import { createHash } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  parsePermissionMode,
  RULE_DESTINATIONS,
  type ConversationId,
  type DecisionKind,
} from '@shared/common';
import type { BlobRef, DecisionOutcome, ToolDecisionRef, TranscriptItem } from '@shared/model';
import type { SessionOp } from '@shared/protocol';
import { SAMPLE_TIME, sampleId } from '@shared/samples';
import { deriveDisplayStatus, INITIAL_STATUS_FACTS, type StatusFacts } from '@shared/status';
import type { HistoryMessage } from '../../../backend/types';
import {
  fixtureCanUseToolPayloadSchema,
  fixtureDecisionPayloadSchema,
  fixtureInputPayloadSchema,
  fixturesDir,
  listFixtureScenarios,
  loadFixture,
  type FixtureEvent,
  type ParsedFixture,
} from '../../../backend/fixture';
import type { LiveNormalizer, NormalizerContext, StatusEvent, StatusSignal } from '../../ports';
import { reduceStatus } from '../../status/machine';
import { createLiveNormalizer } from '../index';
import { z } from 'zod';

export const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../../..');

/** All recorded fixtures (test/fixtures/sdk/*.jsonl), sorted by scenario. */
export async function loadAllFixtures(): Promise<Map<string, ParsedFixture>> {
  const dir = fixturesDir(REPO_ROOT);
  const fixtures = new Map<string, ParsedFixture>();
  for (const scenario of await listFixtureScenarios(dir)) {
    fixtures.set(scenario, await loadFixture(path.join(dir, `${scenario}.jsonl`)));
  }
  return fixtures;
}

export interface TestContext extends NormalizerContext {
  readonly blobs: Map<string, { bytes: number; mediaType: string }>;
}

/** Deterministic NormalizerContext: content-addressed blobs (sha256), fixed `now`. */
export function testContext(
  conversationId: ConversationId = sampleId('cv', 1),
  nextOrder = 1,
  now: Date = new Date(SAMPLE_TIME),
): TestContext {
  const blobs = new Map<string, { bytes: number; mediaType: string }>();
  return {
    entryId: sampleId('en', 1),
    conversationId,
    nextOrder,
    blobs,
    storeBlob(data, mediaType, name): BlobRef {
      const bytes = typeof data === 'string' ? Buffer.from(data, 'utf8') : data;
      const blobId = createHash('sha256').update(bytes).digest('hex');
      blobs.set(blobId, { bytes: bytes.byteLength, mediaType });
      return { blobId, mediaType, bytes: bytes.byteLength, width: null, height: null, name: name ?? null };
    },
    now: () => now,
  };
}

export interface ReplayStep {
  seq: number;
  /** `message` type/subtype or the event kind. */
  label: string;
  source: 'normalizer' | 'engine';
  ops: SessionOp[];
  signals: StatusSignal[];
}

export interface LiveReplay {
  steps: ReplayStep[];
  normalizer: LiveNormalizer;
  ctx: TestContext;
  /** Conversation ids in order (a new one after each conversation_reset). */
  conversations: ConversationId[];
}

const messageHeadSchema = z.looseObject({
  type: z.string(),
  subtype: z.string().optional().catch(undefined),
  event: z
    .looseObject({
      type: z.string(),
      delta: z.looseObject({ type: z.string() }).optional().catch(undefined),
      content_block: z.looseObject({ type: z.string() }).optional().catch(undefined),
    })
    .optional()
    .catch(undefined),
  state: z.string().optional().catch(undefined),
});

/** `type/subtype` label of a raw message (stream events with their event/delta type). */
export function messageLabel(payload: unknown): string {
  const head = messageHeadSchema.safeParse(payload);
  if (!head.success) return 'invalid';
  const m = head.data;
  if (m.type === 'stream_event' && m.event !== undefined) {
    const sub = m.event.delta?.type ?? m.event.content_block?.type;
    return `stream_event/${m.event.type}${sub === undefined ? '' : `/${sub}`}`;
  }
  if (m.type === 'command_lifecycle') return `command_lifecycle/${m.state ?? '?'}`;
  return m.subtype === undefined ? m.type : `${m.type}/${m.subtype}`;
}

export function decisionKindFor(toolName: string): DecisionKind {
  if (toolName === 'AskUserQuestion') return 'question';
  if (toolName === 'ExitPlanMode') return 'plan';
  return 'permission';
}

const permissionUpdateSchema = z.looseObject({
  type: z.string(),
  mode: z.string().optional().catch(undefined),
  destination: z.string().optional().catch(undefined),
});

/** The broker's outcome for a recorded PermissionResult (what WP-13 would report). */
export function outcomeFor(kind: DecisionKind, decision: unknown, input: unknown): DecisionOutcome {
  const parsed = fixtureDecisionPayloadSchema.parse(decision).result;
  const updates = (parsed.updatedPermissions ?? []).flatMap((u) => {
    const p = permissionUpdateSchema.safeParse(u);
    return p.success ? [p.data] : [];
  });
  if (kind === 'question') return parsed.behavior === 'allow' ? { type: 'answered' } : { type: 'declined' };
  if (kind === 'plan') {
    if (parsed.behavior === 'deny') return { type: 'plan_revised' };
    const mode = parsePermissionMode(updates.find((u) => u.type === 'setMode')?.mode) ?? 'default';
    const inputPlan = z.looseObject({ plan: z.string().optional() }).safeParse(input);
    const updatedPlan = z.looseObject({ plan: z.string().optional() }).safeParse(parsed.updatedInput ?? {});
    const edited =
      inputPlan.success && updatedPlan.success && updatedPlan.data.plan !== undefined
        ? updatedPlan.data.plan !== inputPlan.data.plan
        : false;
    return { type: 'plan_approved', mode, edited };
  }
  if (parsed.behavior === 'deny') {
    return {
      type: 'denied',
      withMessage: (parsed.message ?? '') !== '',
      interrupt: parsed.interrupt === true,
    };
  }
  const rule = updates.find((u) => u.type === 'addRules');
  const remember = RULE_DESTINATIONS.find((d) => d === rule?.destination) ?? null;
  return {
    type: 'allowed',
    remember,
    acceptEdits: updates.some((u) => u.type === 'setMode' && u.mode === 'acceptEdits'),
  };
}

function promptText(content: string | unknown[]): string {
  if (typeof content === 'string') return content;
  return content
    .map((block) => {
      const text = z.looseObject({ type: z.literal('text'), text: z.string() }).safeParse(block);
      return text.success ? text.data.text : '';
    })
    .join('\n');
}

export interface ReplayOptions {
  /** Called after each step (status replay hooks in here). */
  onStep?: (step: ReplayStep, event: FixtureEvent, at: Date) => void;
}

const timestampSchema = z.looseObject({ timestamp: z.string() });

/**
 * Wall-clock start of a recording: the first SDK `timestamp` minus its tMs (the header's
 * recordedAt is the END of the run), so receive times stay plausible next to SDK timestamps.
 */
export function startTime(
  fixture: Pick<ParsedFixture, 'events'> & { header?: { recordedAt: string } },
): number {
  for (const event of fixture.events) {
    if (event.kind !== 'message') continue;
    const ts = timestampSchema.safeParse(event.payload);
    const ms = ts.success ? Date.parse(ts.data.timestamp) : Number.NaN;
    if (!Number.isNaN(ms)) return ms - event.tMs;
  }
  return Date.parse(fixture.header?.recordedAt ?? SAMPLE_TIME);
}

/** Replays a fixture through a fresh live normalizer like the engine (WP-13) would. */
export function replayLive(
  fixture: Pick<ParsedFixture, 'events'> & { header?: { recordedAt: string } },
  options: ReplayOptions = {},
): LiveReplay {
  const t0 = startTime(fixture);
  let current: ConversationId = sampleId('cv', 1);
  const conversations: ConversationId[] = [current];
  const ctx = testContext(current);
  const normalizer = createLiveNormalizer(ctx);
  const steps: ReplayStep[] = [];
  const decisions = new Map<string, ToolDecisionRef & { input: unknown }>();
  let planVersion = 0;

  const record = (step: ReplayStep, event: FixtureEvent, at: Date): void => {
    steps.push(step);
    options.onStep?.(step, event, at);
  };

  for (const event of fixture.events) {
    const at = new Date(t0 + event.tMs);
    switch (event.kind) {
      case 'input': {
        const input = fixtureInputPayloadSchema.parse(event.payload);
        normalizer.registerPrompt({
          messageUuid: input.uuid,
          text: promptText(input.message.content),
          attachments: [],
          priority: input.priority === 'now' ? 'now' : 'next',
          at,
        });
        record({ seq: event.seq, label: 'input', source: 'engine', ops: [], signals: [] }, event, at);
        break;
      }
      case 'message': {
        const out = normalizer.push(event.payload, at);
        record(
          { seq: event.seq, label: messageLabel(event.payload), source: 'normalizer', ...out },
          event,
          at,
        );
        for (const signal of out.signals) {
          if (signal.type !== 'conversation_reset') continue;
          const previous = current;
          const next = sampleId('cv', conversations.length + 1);
          conversations.push(next);
          current = next;
          normalizer.startConversation(next, 1);
          record(
            {
              seq: event.seq,
              label: 'engine/conversation.reset',
              source: 'engine',
              ops: [
                {
                  op: 'conversation.reset',
                  conversationId: next,
                  previousConversationId: previous,
                  trigger: signal.trigger,
                  hasEarlier: false,
                },
              ],
              signals: [],
            },
            event,
            at,
          );
        }
        break;
      }
      case 'canUseTool': {
        const request = fixtureCanUseToolPayloadSchema.parse(event.payload);
        const kind = decisionKindFor(request.toolName);
        const ref: ToolDecisionRef = {
          decisionId: sampleId('dc', decisions.size + 1),
          kind,
          planVersion: kind === 'plan' ? ++planVersion : null,
          outcome: null,
        };
        decisions.set(request.options.toolUseID, { ...ref, input: request.input });
        const out = normalizer.attachDecision(request.options.toolUseID, ref);
        record({ seq: event.seq, label: 'canUseTool', source: 'engine', ...out }, event, at);
        break;
      }
      case 'decision': {
        const decision = fixtureDecisionPayloadSchema.parse(event.payload);
        const open = decisions.get(decision.toolUseID);
        if (open === undefined) break;
        const { input, ...ref } = open;
        const out = normalizer.attachDecision(decision.toolUseID, {
          ...ref,
          outcome: outcomeFor(ref.kind, event.payload, input),
        });
        record({ seq: event.seq, label: 'decision', source: 'engine', ...out }, event, at);
        break;
      }
      case 'exit': {
        const out = normalizer.finalizeOpen('process_exit');
        record({ seq: event.seq, label: 'exit', source: 'engine', ...out }, event, at);
        break;
      }
      case 'spawn':
        record({ seq: event.seq, label: 'spawn', source: 'engine', ops: [], signals: [] }, event, at);
        break;
      default:
        break;
    }
  }
  return { steps, normalizer, ctx, conversations };
}

/** Final items per conversation (last upsert wins, removals applied), sorted by order. */
export function finalItems(replay: LiveReplay): Record<string, TranscriptItem[]> {
  const byConversation = new Map<string, Map<string, TranscriptItem>>();
  let current: string = replay.conversations[0] ?? sampleId('cv', 1);
  byConversation.set(current, new Map());
  for (const step of replay.steps) {
    for (const op of step.ops) {
      const items = byConversation.get(current) ?? new Map<string, TranscriptItem>();
      byConversation.set(current, items);
      if (op.op === 'conversation.reset') {
        current = op.conversationId;
        byConversation.set(current, new Map());
      } else if (op.op === 'item.upsert') items.set(op.item.id, op.item);
      else if (op.op === 'item.remove') items.delete(op.itemId);
    }
  }
  const out: Record<string, TranscriptItem[]> = {};
  for (const [conversationId, items] of byConversation) {
    out[conversationId] = [...items.values()].sort((a, b) => a.order - b.order);
  }
  return out;
}

// ---- Compact, reviewable op timeline for snapshots ----

function itemSummary(item: TranscriptItem): string {
  const head = `${item.id} ${item.kind}${item.kind === 'system' ? `/${item.event}` : ''} o${String(item.order)}`;
  switch (item.kind) {
    case 'assistant_text':
      return `${head} ${item.streaming ? 'streaming' : item.aborted ? 'aborted' : 'final'} ${String(item.text.length)}ch`;
    case 'thinking':
      return `${head} ${item.streaming ? 'streaming' : 'final'} ${String(item.text.text.length)}ch`;
    case 'tool_call':
      return `${head} ${item.toolName} ${item.status}${item.decision === null ? '' : ` decision=${item.decision.outcome?.type ?? 'open'}`}${item.result === null ? '' : ` result${item.result.isError ? '(error)' : ''}`}${item.task === null ? '' : ` task=${item.task.status}`}`;
    case 'turn_result':
      return `${head} ${item.outcome}${item.synthetic ? ' synthetic' : ''}`;
    case 'user_message':
      return `${head}${item.slashCommand === null ? '' : ` ${item.slashCommand}`}`;
    default:
      return head;
  }
}

function opSummary(op: SessionOp): string {
  switch (op.op) {
    case 'item.upsert':
      return `upsert ${itemSummary(op.item)}`;
    case 'item.delta':
      return `delta ${op.itemId} ${op.field}`;
    case 'item.remove':
      return `remove ${op.itemId}`;
    case 'conversation.reset':
      return `conversation.reset → ${op.conversationId}`;
    case 'decision.upsert':
      return `decision.upsert ${op.decision.id}`;
    case 'decision.resolved':
      return `decision.resolved ${op.decisionId}`;
    case 'detail.patch':
      return `detail.patch {${Object.keys(op.patch).sort().join(',')}}`;
  }
}

function signalSummary(signal: StatusSignal): string {
  switch (signal.type) {
    case 'session_state':
      return `session_state:${signal.state}`;
    case 'prompt_lifecycle':
      return `prompt_lifecycle:${signal.state}`;
    case 'turn_result':
      return `turn_result:${signal.outcome}${signal.synthetic ? ':synthetic' : ''}`;
    case 'compacting':
    case 'retry':
      return `${signal.type}:${String(signal.active)}`;
    case 'permission_mode':
      return `permission_mode:${signal.mode ?? 'null'}`;
    case 'rate_limit':
      return `rate_limit:${signal.info.status}`;
    case 'assistant_error':
      return `assistant_error:${signal.error.code}`;
    case 'background_tasks':
      return `background_tasks:${String(signal.count)}`;
    default:
      return signal.type;
  }
}

/**
 * One line per step with output; consecutive delta-only steps of the same item/field collapse
 * into one line with the count and the appended length.
 */
interface DeltaRun {
  first: number;
  last: number;
  key: string;
  n: number;
  chars: number;
}

function runLine(run: DeltaRun): string {
  const range =
    run.first === run.last ? `#${String(run.first)}` : `#${String(run.first)}-${String(run.last)}`;
  return `${range} ${run.key} ×${String(run.n)} (+${String(run.chars)}ch)`;
}

export function timeline(replay: LiveReplay): string[] {
  const lines: string[] = [];
  const state: { run: DeltaRun | null } = { run: null };
  for (const step of replay.steps) {
    const only = step.ops.length === 1 && step.signals.length === 0 ? step.ops[0] : undefined;
    if (only?.op === 'item.delta') {
      const key = `delta ${only.itemId} ${only.field}`;
      const run = state.run;
      if (run?.key === key) {
        run.last = step.seq;
        run.n += 1;
        run.chars += only.append.length;
      } else {
        if (run !== null) lines.push(runLine(run));
        state.run = { first: step.seq, last: step.seq, key, n: 1, chars: only.append.length };
      }
      continue;
    }
    if (step.ops.length === 0 && step.signals.length === 0) continue;
    if (state.run !== null) lines.push(runLine(state.run));
    state.run = null;
    const parts = [...step.ops.map(opSummary), ...step.signals.map((s) => `!${signalSummary(s)}`)];
    lines.push(`#${String(step.seq)} ${step.label}: ${parts.join(' | ')}`);
  }
  if (state.run !== null) lines.push(runLine(state.run));
  return lines;
}

/**
 * Pretty JSON for file snapshots; strings over 4000 chars become `«N chars, sha256 …»` so capped
 * 48 Ki texts keep the snapshot reviewable while any change still shows up (hash).
 */
export function snapshotJson(value: unknown): string {
  const json = JSON.stringify(
    value,
    (_key, v: unknown) =>
      typeof v === 'string' && v.length > 4000
        ? `«${String(v.length)} chars, sha256 ${createHash('sha256').update(v).digest('hex').slice(0, 16)}»`
        : v,
    2,
  );
  return `${json}\n`;
}

/** Every signal with its step. */
export function signalList(replay: LiveReplay): ({ seq: number } & StatusSignal)[] {
  return replay.steps.flatMap((step) => step.signals.map((s) => ({ seq: step.seq, ...s })));
}

/** The merged detail patches (last value per field wins). */
export function mergedDetail(replay: LiveReplay): Record<string, unknown> {
  const detail: Record<string, unknown> = {};
  for (const step of replay.steps) {
    for (const op of step.ops) if (op.op === 'detail.patch') Object.assign(detail, op.patch);
  }
  return detail;
}

// ---- History messages (SessionMessage as recorded → port HistoryMessage, the WP-13 mapping) ----

const sessionMessageSchema = z.looseObject({
  type: z.enum(['user', 'assistant', 'system']),
  uuid: z.string(),
  session_id: z.string(),
  message: z.unknown(),
  parent_tool_use_id: z.string().nullable().optional(),
  timestamp: z.string().nullable().optional(),
});

/** Recorded `getSessionMessages` result → HistoryMessage[] (null if the call only has a summary). */
export function toHistoryMessages(result: unknown): HistoryMessage[] | null {
  const parsed = z.array(sessionMessageSchema).safeParse(result);
  if (!parsed.success) return null;
  return parsed.data.map((m) => ({
    type: m.type,
    uuid: m.uuid,
    sessionId: m.session_id,
    message: m.message,
    parentToolUseId: m.parent_tool_use_id ?? null,
    timestamp: m.timestamp ?? null,
  }));
}

/** Main + subagent messages merged by time (stable), as `readHistory` delivers them (R0-18). */
export function mergeByTime(main: HistoryMessage[], ...subagents: HistoryMessage[][]): HistoryMessage[] {
  const all = [main, ...subagents].flatMap((list, source) => list.map((m, index) => ({ m, source, index })));
  return all
    .sort((a, b) => {
      const ta = Date.parse(a.m.timestamp ?? '') || 0;
      const tb = Date.parse(b.m.timestamp ?? '') || 0;
      return ta - tb || a.source - b.source || a.index - b.index;
    })
    .map((x) => x.m);
}

// ---- Status replay ----

export interface StatusTransition {
  seq: number;
  event: string;
  display: string;
}

/** Display string of the facts: `deriveDisplayStatus().kind` (+unread). */
export function displayOf(facts: StatusFacts, now: Date): string {
  const display = deriveDisplayStatus(facts, now);
  return display.unread ? `${display.kind}+unread` : display.kind;
}

export interface StatusReplayOptions {
  /** A visible client looks at the session after every idle (presence → `viewed`). */
  viewedAfterIdle?: boolean;
}

/**
 * Replays a fixture through normalizer AND status machine the way the engine would:
 * spawn → process_starting, signals → reduceStatus, canUseTool/decision → decisions_changed,
 * input → queue_changed (+1), prompt taken over (user_message item or prompt_lifecycle
 * started/cancelled/completed) → queue_changed (−1), exit → process_exit (expected).
 * Records every change of the display string.
 */
export function replayStatus(
  fixture: Pick<ParsedFixture, 'events'> & { header?: { recordedAt: string } },
  options: StatusReplayOptions = {},
): {
  transitions: StatusTransition[];
  facts: StatusFacts;
} {
  let facts: StatusFacts = INITIAL_STATUS_FACTS;
  let sessionStateSeen = false;
  const open = new Map<string, DecisionKind>();
  const queued = new Set<string>();
  const transitions: StatusTransition[] = [];
  let last = displayOf(facts, new Date(SAMPLE_TIME));
  transitions.push({ seq: 0, event: 'initial', display: last });

  const applyEvent = (event: StatusEvent, seq: number, at: Date): void => {
    if (event.type === 'session_state') sessionStateSeen = true;
    facts = reduceStatus(facts, event, at, { viewedByVisibleClient: false, sessionStateSeen });
    const display = displayOf(facts, at);
    if (display !== last) {
      last = display;
      transitions.push({
        seq,
        event: event.type === 'session_state' ? `session_state:${event.state}` : event.type,
        display,
      });
    }
  };
  const decisionsChanged = (seq: number, at: Date): void => {
    const kinds = [...open.values()];
    applyEvent(
      {
        type: 'decisions_changed',
        decisions: {
          permission: kinds.filter((k) => k === 'permission').length,
          question: kinds.filter((k) => k === 'question').length,
          plan: kinds.filter((k) => k === 'plan').length,
          oldestKind: kinds[0] ?? null,
          expired: 0,
        },
      },
      seq,
      at,
    );
  };

  replayLive(fixture, {
    onStep: (step, event, at) => {
      switch (step.label) {
        case 'spawn':
          applyEvent({ type: 'process_starting' }, step.seq, at);
          return;
        case 'exit':
          applyEvent({ type: 'process_exit', expected: true, error: null }, step.seq, at);
          return;
        case 'input': {
          const input = fixtureInputPayloadSchema.parse(event.payload);
          queued.add(input.uuid);
          applyEvent({ type: 'queue_changed', count: queued.size }, step.seq, at);
          return;
        }
        case 'canUseTool': {
          const request = fixtureCanUseToolPayloadSchema.parse(event.payload);
          open.set(request.options.toolUseID, decisionKindFor(request.toolName));
          decisionsChanged(step.seq, at);
          return;
        }
        case 'decision': {
          const decision = fixtureDecisionPayloadSchema.parse(event.payload);
          open.delete(decision.toolUseID);
          decisionsChanged(step.seq, at);
          return;
        }
        default:
          for (const op of step.ops) {
            if (op.op === 'item.upsert' && op.item.kind === 'user_message' && queued.delete(op.item.id)) {
              applyEvent({ type: 'queue_changed', count: queued.size }, step.seq, at);
            }
          }
          for (const signal of step.signals) {
            applyEvent(signal, step.seq, at);
            if (
              signal.type === 'prompt_lifecycle' &&
              signal.state !== 'queued' &&
              queued.delete(signal.messageUuid)
            ) {
              applyEvent({ type: 'queue_changed', count: queued.size }, step.seq, at);
            }
            if (
              options.viewedAfterIdle === true &&
              signal.type === 'session_state' &&
              signal.state === 'idle'
            ) {
              applyEvent({ type: 'viewed' }, step.seq, at);
            }
          }
      }
    },
  });
  return { transitions, facts };
}
