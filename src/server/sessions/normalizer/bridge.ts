/**
 * WP-64: system messages that come from the Remote Control bridge (untyped in SDK 0.3.322).
 * One table subtype → handler, so further bridge messages are one entry each: WP-65 replaces the
 * `task_summary` / `post_turn_summary` entries (live sentence and turn summary, only sent while a
 * bridge is connected) with real handlers. Until then they are counted as ignored – never an
 * `unknown` item in the transcript.
 */
import type { BridgeState, StatusSignal } from '../ports';
import { bridgeStateMessageSchema } from './sdk-schemas';

const DETAIL_CHARS = 500;

export type BridgeOutcome =
  | { kind: 'signal'; signal: StatusSignal }
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

function clip(text: string | null | undefined): string | null {
  if (text === null || text === undefined || text === '') return null;
  return text.length > DETAIL_CHARS ? `${text.slice(0, DETAIL_CHARS)}…` : text;
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

const ignored: BridgeHandler = () => ({ outcome: { kind: 'ignored' }, unknownKey: null });

const BRIDGE_HANDLERS: Readonly<Record<string, BridgeHandler>> = {
  bridge_state: bridgeState,
  // WP-65: live sentence / turn summary of the CLI (only with a connected bridge).
  task_summary: ignored,
  post_turn_summary: ignored,
};

/** null = not a bridge subtype (the caller goes on with its own table). */
export function normalizeBridgeMessage(subtype: string, raw: unknown): BridgeResult | null {
  const handler = Object.hasOwn(BRIDGE_HANDLERS, subtype) ? BRIDGE_HANDLERS[subtype] : undefined;
  return handler === undefined ? null : handler(raw);
}
