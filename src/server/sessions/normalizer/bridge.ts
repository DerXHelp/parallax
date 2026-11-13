/**
 * WP-64: system messages that come from the Remote Control bridge (untyped in SDK 0.3.322).
 * One table subtype → handler, so further bridge messages are one entry each. WP-65: the live
 * sentence (`task_summary`) and the turn summary (`post_turn_summary`) – the CLI sends both only
 * while a bridge is connected. The turn summary carries `summarizes_uuid`; the live normalizer
 * checks it against the latest turn (`turnSummary` outcome) before the signal leaves.
 */
import type { BridgeState, StatusSignal } from '../ports';
import { bridgeStateMessageSchema, postTurnSummaryMessageSchema, taskSummaryMessageSchema } from './sdk-schemas';

const DETAIL_CHARS = 500;
/** SessionActivity `claude.text` max 300 (model.ts) – clip adds the "…". */
const SENTENCE_CHARS = 299;
/** TurnSummary `text` / `category` max 500 / 100 (model.ts) – clip adds the "…". */
const SUMMARY_CHARS = 499;
const CATEGORY_CHARS = 99;

type TurnSummarySignal = Extract<StatusSignal, { type: 'turn_summary' }>;

export type BridgeOutcome =
  | { kind: 'signal'; signal: StatusSignal }
  /** WP-65: emitted only when `summarizesUuid` belongs to the latest turn (live.ts). */
  | { kind: 'turnSummary'; summarizesUuid: string | null; signal: TurnSummarySignal }
  /** Known bridge message without an effect (yet); counted as `system/<subtype>`. */
  | { kind: 'ignored' }
  /** Schema mismatch; counted as `invalid:system/<subtype>`. */
  | { kind: 'invalid' };

export interface BridgeResult {
  outcome: BridgeOutcome;
  /** Key for `unknownCounts` (e.g. an unknown bridge state of a newer CLI), else null. */
  unknownKey: string | null;
}

type BridgeHandler = (raw: unknown) => BridgeResult;

const KNOWN_STATES: ReadonlySet<string> = new Set<BridgeState>(['ready', 'connected', 'failed', 'policy_disabled']);

function isKnownState(value: string): value is BridgeState {
  return KNOWN_STATES.has(value);
}

/** Whitespace collapsed; longer than `max` → the first `max` chars + "…"; empty → null. */
function clip(text: string | null | undefined, max = DETAIL_CHARS): string | null {
  if (text === null || text === undefined) return null;
  const trimmed = text.replace(/\s+/g, ' ').trim();
  if (trimmed === '') return null;
  return trimmed.length > max ? `${trimmed.slice(0, max)}…` : trimmed;
}

const bridgeState: BridgeHandler = (raw) => {
  const parsed = bridgeStateMessageSchema.safeParse(raw);
  if (!parsed.success) return { outcome: { kind: 'invalid' }, unknownKey: null };
  const d = parsed.data;
  const state: BridgeState = isKnownState(d.state) ? d.state : 'unknown';
  return {
    outcome: {
      kind: 'signal',
      signal: {
        type: 'bridge_state',
        state,
        detail: clip(d.detail),
        failureKind: d.state === 'failed' ? (clip(d.failure_kind) ?? 'terminal') : null,
        recovered: d.recovered === true,
      },
    },
    unknownKey: state === 'unknown' ? `bridge_state:${d.state.slice(0, 100)}` : null,
  };
};

/** WP-65: the live sentence; null/empty = the turn ended. */
const taskSummary: BridgeHandler = (raw) => {
  const parsed = taskSummaryMessageSchema.safeParse(raw);
  if (!parsed.success) return { outcome: { kind: 'invalid' }, unknownKey: null };
  return {
    outcome: { kind: 'signal', signal: { type: 'task_summary', detail: clip(parsed.data.detail, SENTENCE_CHARS) } },
    unknownKey: null,
  };
};

/** WP-65: the turn summary – without a detail text there is nothing to show (ignored). */
const postTurnSummary: BridgeHandler = (raw) => {
  const parsed = postTurnSummaryMessageSchema.safeParse(raw);
  if (!parsed.success) return { outcome: { kind: 'invalid' }, unknownKey: null };
  const d = parsed.data;
  const needs = d.needs_action;
  const needsAction = typeof needs === 'string' ? clip(needs, SUMMARY_CHARS) : needs === true ? '' : null;
  const detail = clip(d.status_detail, SUMMARY_CHARS) ?? (needsAction === '' ? null : needsAction);
  if (detail === null) return { outcome: { kind: 'ignored' }, unknownKey: null };
  return {
    outcome: {
      kind: 'turnSummary',
      summarizesUuid: clip(d.summarizes_uuid, 200),
      signal: {
        type: 'turn_summary',
        category: clip(d.status_category, CATEGORY_CHARS),
        detail,
        needsAction,
      },
    },
    unknownKey: null,
  };
};

const BRIDGE_HANDLERS: Readonly<Record<string, BridgeHandler>> = {
  bridge_state: bridgeState,
  task_summary: taskSummary,
  post_turn_summary: postTurnSummary,
};

/** null = not a bridge subtype (the caller goes on with its own table). */
export function normalizeBridgeMessage(subtype: string, raw: unknown): BridgeResult | null {
  const handler = Object.hasOwn(BRIDGE_HANDLERS, subtype) ? BRIDGE_HANDLERS[subtype] : undefined;
  return handler === undefined ? null : handler(raw);
}
