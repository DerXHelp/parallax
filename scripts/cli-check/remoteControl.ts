/**
 * Step 2b of `pnpm cli-check` (WP-64 §1.5): Remote Control in the probe session – the internal SDK
 * method `enableRemoteControl(true, 'Parallax cli-check')`, its answer against the schema Parallax
 * relies on (`remoteControlAnswerSchema`, a claude.ai `session_url`), `system/bridge_state`
 * `connected` within 15 s, then `enableRemoteControl(false)` (always, also after a failure). The
 * result goes into the profile as `remoteControl: true/false` (observation.ts); a change against the
 * profile is a finding (compare.ts). A failure here never stops the check – it is the finding.
 *
 * No model turn (no cost). If switching off fails, a remote session "Parallax cli-check" may stay in
 * the Claude app; the report says so (`disabled: false`).
 */
import { z } from 'zod';
import { isClaudeSessionUrl } from '@shared/model';
import { remoteControlAnswerSchema, remoteControlErrorOf } from '../../src/server/backend/remoteControl';
import { withTimeout } from '../../src/server/backend/sdkBackend';
import { normalizeBridgeMessage } from '../../src/server/sessions/normalizer/bridge';

export const REMOTE_CONTROL_PROBE_NAME = 'Parallax cli-check';
/** `bridge_state connected` must arrive this soon after the enable request. */
export const REMOTE_CONTROL_CONNECT_MS = 15_000;

/**
 * The probe's Query: the public `close()` plus the internal method (not in the SDK typings, absent
 * in older SDKs – checked at runtime).
 */
export interface RemoteControlProbeHandle {
  close(): void;
  enableRemoteControl?(enabled: boolean, name?: string): Promise<unknown>;
}

export const remoteControlProbeResultSchema = z.object({
  /** The answer matched the schema and the bridge reported `connected` in time. */
  available: z.boolean(),
  /** Why not (English, for the report); null when available. */
  detail: z.string().nullable(),
  /** ms from the request to `bridge_state connected`; null when it never came. */
  connectedMs: z.number().nullable(),
  /** The bridge was switched off again (false: a remote session may be left in the Claude app). */
  disabled: z.boolean(),
});
export type RemoteControlProbeResult = z.infer<typeof remoteControlProbeResultSchema>;

interface BridgeView {
  state: string;
  detail: string | null;
  failureKind: string | null;
}

const systemHead = z.looseObject({ type: z.literal('system'), subtype: z.string() });

/** `system/bridge_state` of a raw SDK message (the normalizer's parser), else null. */
export function bridgeStateOf(message: unknown): BridgeView | null {
  const head = systemHead.safeParse(message);
  if (!head.success || head.data.subtype !== 'bridge_state') return null;
  const result = normalizeBridgeMessage('bridge_state', message);
  if (result?.outcome.kind !== 'signal' || result.outcome.signal.type !== 'bridge_state') return null;
  const { signal } = result.outcome;
  const raw = z.looseObject({ state: z.string() }).safeParse(message);
  return {
    state: raw.success ? raw.data.state : signal.state,
    detail: signal.detail,
    failureKind: signal.failureKind,
  };
}

/** The probe's message pump feeds every SDK message in; the probe waits for `connected`. */
export class BridgeWatch {
  readonly seen: BridgeView[] = [];
  private readonly listeners = new Set<(view: BridgeView) => void>();

  push(message: unknown): void {
    const view = bridgeStateOf(message);
    if (view === null) return;
    this.seen.push(view);
    for (const listener of [...this.listeners]) listener(view);
  }

  /**
   * Resolves with `connected`, a final failure (`failed` with failure_kind terminal,
   * `policy_disabled`) or `timeout`. Only states seen from `from` on (index into `seen`) count.
   */
  waitConnected(from: number, ms: number): Promise<{ kind: 'connected' } | { kind: 'failed'; detail: string } | { kind: 'timeout' }> {
    return new Promise((resolve) => {
      const verdict = (view: BridgeView): { kind: 'connected' } | { kind: 'failed'; detail: string } | null => {
        if (view.state === 'connected') return { kind: 'connected' };
        if (view.state === 'policy_disabled') return { kind: 'failed', detail: 'bridge_state policy_disabled' };
        if (view.state === 'failed' && view.failureKind === 'terminal') {
          return { kind: 'failed', detail: `bridge_state failed (terminal)${view.detail === null ? '' : `: ${view.detail}`}` };
        }
        return null;
      };
      const finish = (result: { kind: 'connected' } | { kind: 'failed'; detail: string } | { kind: 'timeout' }): void => {
        clearTimeout(timer);
        this.listeners.delete(listener);
        resolve(result);
      };
      const listener = (view: BridgeView): void => {
        const result = verdict(view);
        if (result !== null) finish(result);
      };
      const timer = setTimeout(() => {
        finish({ kind: 'timeout' });
      }, ms);
      this.listeners.add(listener);
      for (const view of this.seen.slice(from)) {
        const result = verdict(view);
        if (result !== null) {
          finish(result);
          return;
        }
      }
    });
  }
}

export interface RemoteControlProbeOptions {
  controlMs: number;
  connectMs?: number;
  now?: () => number;
  log?: (line: string) => void;
}

function errorDetail(error: unknown): string {
  const payload = remoteControlErrorOf(error);
  const reason = typeof payload.params.reason === 'string' ? ` (${payload.params.reason})` : '';
  return `${payload.code}${reason}`;
}

/** Runs step 2b against the probe's Query (pure apart from the handle; tested with a fake handle). */
export async function probeRemoteControl(
  handle: RemoteControlProbeHandle,
  watch: BridgeWatch,
  o: RemoteControlProbeOptions,
): Promise<RemoteControlProbeResult> {
  const log = o.log ?? (() => undefined);
  const now = o.now ?? Date.now;
  const connectMs = o.connectMs ?? REMOTE_CONTROL_CONNECT_MS;
  if (typeof handle.enableRemoteControl !== 'function') {
    return { available: false, detail: 'Query.enableRemoteControl is missing (SDK)', connectedMs: null, disabled: true };
  }
  const method = handle.enableRemoteControl.bind(handle);
  const enable = (enabled: boolean, name?: string): Promise<unknown> =>
    withTimeout(
      name === undefined ? method(enabled) : method(enabled, name),
      o.controlMs,
      `enableRemoteControl(${String(enabled)})`,
    );
  const started = now();
  const from = watch.seen.length;
  let detail: string | null = null;
  let connectedMs: number | null = null;
  try {
    const answer = remoteControlAnswerSchema.safeParse(await enable(true, REMOTE_CONTROL_PROBE_NAME));
    if (!answer.success) {
      detail = 'the answer of enableRemoteControl does not match the expected schema (bridge_session_id …)';
    } else if (answer.data.session_url === undefined || !isClaudeSessionUrl(answer.data.session_url)) {
      detail = 'the answer has no https://claude.ai session_url';
    } else {
      const waited = await watch.waitConnected(from, connectMs);
      if (waited.kind === 'connected') connectedMs = now() - started;
      else if (waited.kind === 'failed') detail = waited.detail;
      else detail = `no bridge_state connected within ${String(connectMs / 1000)} s`;
    }
  } catch (error) {
    detail = `enableRemoteControl(true) failed: ${errorDetail(error)}`;
  }
  let disabled = true;
  try {
    await enable(false);
  } catch (error) {
    disabled = false;
    log(`cli-check: switching Remote Control off failed (${errorDetail(error)}) – check the Claude app for "${REMOTE_CONTROL_PROBE_NAME}"`);
  }
  log(
    detail === null
      ? `cli-check: Remote Control connected after ${String(connectedMs)} ms`
      : `cli-check: Remote Control NOT available – ${detail}`,
  );
  return { available: detail === null, detail, connectedMs, disabled };
}
