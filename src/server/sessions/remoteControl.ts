/**
 * WP-64: Remote Control of an entry (docs/wp/WP-64.md §1.3). The wish `Entry.remoteControlWanted` is
 * persisted; the live state (`EntryState.remote`: off / connecting / connected / reconnecting /
 * failed) exists only while a process runs and follows the CLI's `bridge_state` signals. A running
 * process is switched at once, a dormant one at its next start (after readiness, with the
 * `reattachSessionId` of the current conversation, so the link in the Claude app stays the same).
 * New entries: `settings.remoteControl.newSessions` (`follow_claude` reads Claude's own
 * `remoteControlAtStartup` after the first readiness). Archive and remove switch the bridge off
 * before the process closes; a user close, the idle sleep is never (active bridges never sleep,
 * ADR-105 extended) and a server restart keep it (`keepSessionOnExit`).
 */
import { makeError, type ErrorPayload } from '@shared/errors';
import { isRemoteControlActive, type Conversation, type RemoteControlState } from '@shared/model';
import type { CommandResult } from '@shared/protocol';
import type { RemoteControlResult } from '../backend/types';
import type { EngineCore, EntryState } from './entryState';
import type { StatusSignal } from './ports';
import type { SessionRuntime } from './runtime';
import { withCurrentConversation } from './summary';

type BridgeSignal = Extract<StatusSignal, { type: 'bridge_state' }>;

/** The live Remote Control state of an entry (SessionSummary.remoteControl without `wanted`). */
export interface RemoteState {
  state: RemoteControlState;
  sessionUrl: string | null;
  error: ErrorPayload | null;
}

export const REMOTE_OFF: RemoteState = Object.freeze({ state: 'off', sessionUrl: null, error: null });

const DETAIL_CHARS = 200;

/**
 * bridge_state → next live state (pure). ready → connecting, connected → connected, failed with a
 * failure kind other than `terminal` → reconnecting (the CLI retries), terminal → failed
 * (REMOTE_CONTROL_FAILED), policy_disabled → failed (REMOTE_CONTROL_POLICY_DISABLED); unknown states
 * and a failure after Parallax switched the bridge off change nothing.
 */
export function nextRemoteState(prev: RemoteState, signal: BridgeSignal): RemoteState {
  switch (signal.state) {
    case 'ready':
      return { ...prev, state: 'connecting', error: null };
    case 'connected':
      return { ...prev, state: 'connected', error: null };
    case 'failed':
      if (prev.state === 'off') return prev;
      if (signal.failureKind !== 'terminal') return { ...prev, state: 'reconnecting', error: null };
      return {
        ...prev,
        state: 'failed',
        error: makeError('REMOTE_CONTROL_FAILED', {
          reason: 'terminal',
          detail: (signal.detail ?? '').slice(0, DETAIL_CHARS),
        }),
      };
    case 'policy_disabled':
      return { ...prev, state: 'failed', error: makeError('REMOTE_CONTROL_POLICY_DISABLED') };
    case 'unknown':
      return prev;
  }
}

/** Runtime: a bridge_state signal of this process. */
export function onBridgeState(s: EntryState, signal: BridgeSignal): void {
  s.setRemote(nextRemoteState(s.remote, signal));
}

/** A conversation that continues the entry's remote session (/clear, fresh context): same bridge. */
export function bridgeOf(c: Conversation): Pick<Conversation, 'bridgeSessionId' | 'sessionUrl'> {
  return { bridgeSessionId: c.bridgeSessionId, sessionUrl: c.sessionUrl };
}

function remoteName(s: EntryState): string | null {
  const title = s.entry.title.trim();
  return title === '' ? null : title;
}

function current(s: EntryState, rt: SessionRuntime, generation: number): boolean {
  return s.remoteGeneration === generation && s.runtime === rt && rt.alive && !rt.closing;
}

/**
 * Switches the bridge on for the running process: state `connecting`, then the answer stores the
 * bridge session and its link on the current conversation (the `bridge_state` signals set
 * connected). A failed reattach (REMOTE_CONTROL_FAILED) is tried once more without it. Returns the
 * error (state `failed`), null on success or when the request became outdated.
 */
export async function enableRemote(
  core: EngineCore,
  s: EntryState,
  rt: SessionRuntime,
): Promise<ErrorPayload | null> {
  const generation = s.nextRemoteGeneration();
  s.setRemote({ ...s.remote, state: isRemoteControlActive(s.remote.state) ? s.remote.state : 'connecting', error: null });
  const name = remoteName(s);
  const reattach = s.conversation().bridgeSessionId;
  let result: RemoteControlResult = await rt.agent.setRemoteControl(true, { name, reattachSessionId: reattach });
  if (!result.ok && reattach !== null && result.error.code === 'REMOTE_CONTROL_FAILED' && current(s, rt, generation)) {
    core.log.info({ entryId: s.id, params: result.error.params }, 'remote control reattach failed – new bridge');
    result = await rt.agent.setRemoteControl(true, { name, reattachSessionId: null });
  }
  if (!current(s, rt, generation)) return null;
  if (!result.ok) {
    core.log.warn({ entryId: s.id, code: result.error.code, params: result.error.params }, 'remote control failed');
    s.setRemote({ state: 'failed', sessionUrl: null, error: result.error });
    return result.error;
  }
  const info = result.info;
  if (info !== null) {
    s.patch((e) =>
      withCurrentConversation(e, (c) =>
        c.bridgeSessionId === info.bridgeSessionId && c.sessionUrl === info.sessionUrl
          ? c
          : { ...c, bridgeSessionId: info.bridgeSessionId, sessionUrl: info.sessionUrl },
      ),
    );
  }
  core.log.info({ entryId: s.id, reattached: reattach !== null && reattach === info?.bridgeSessionId }, 'remote control on');
  s.setRemote({
    state: isRemoteControlActive(s.remote.state) ? s.remote.state : 'connecting',
    sessionUrl: info?.sessionUrl ?? null,
    error: null,
  });
  return null;
}

/** The stored bridge of the current conversation is dropped (next enable → a new remote session). */
function forgetBridge(s: EntryState): void {
  s.patch((e) =>
    withCurrentConversation(e, (c) =>
      c.bridgeSessionId === null && c.sessionUrl === null ? c : { ...c, bridgeSessionId: null, sessionUrl: null },
    ),
  );
}

/** Switches the bridge of the running process off (errors are logged); the live state is off. */
async function disableRemote(core: EngineCore, s: EntryState): Promise<void> {
  s.nextRemoteGeneration();
  const rt = s.runtime;
  if (rt?.alive === true && !rt.closing && s.remote.state !== 'off') {
    const result = await rt.agent.setRemoteControl(false, { name: null, reattachSessionId: null });
    if (!result.ok) {
      core.log.warn({ entryId: s.id, code: result.error.code }, 'switching remote control off failed');
    }
  }
  forgetBridge(s);
  s.setRemote(REMOTE_OFF);
}

/**
 * After readiness (every start): Claude's own default for the host state and the `follow_claude`
 * setting of a new entry, then the bridge when the entry wants it.
 */
export async function remoteControlAfterReady(core: EngineCore, s: EntryState, rt: SessionRuntime): Promise<void> {
  const value = await rt.agent.readRemoteControlDefault();
  if (s.runtime !== rt || !rt.alive) return;
  if (value !== null) core.setRemoteControlDefault(s.entry.profileId, value);
  if (s.followClaudeDefault) {
    s.followClaudeDefault = false;
    if (value !== null && value !== s.entry.remoteControlWanted) {
      s.patch((e) => ({ ...e, remoteControlWanted: value }));
    }
  }
  if (s.entry.remoteControlWanted && !s.entry.archived) await enableRemote(core, s, rt);
}

/**
 * `session.setRemoteControl` (gates: not archived, not external). Saves the wish; a running, ready
 * process is switched at once – a failure shows as state `failed` with its error (the command itself
 * succeeds), a dormant entry connects at its next start. Off forgets the stored bridge.
 */
export async function setRemoteControl(
  core: EngineCore,
  s: EntryState,
  enabled: boolean,
): Promise<CommandResult<'session.setRemoteControl'>> {
  // An explicit choice wins over the `follow_claude` default of a new entry.
  s.followClaudeDefault = false;
  s.patch((e) => (e.remoteControlWanted === enabled ? e : { ...e, remoteControlWanted: enabled }));
  if (!enabled) {
    await disableRemote(core, s);
    return {};
  }
  const rt = s.runtime;
  // Not ready yet: remoteControlAfterReady connects (the wish is saved).
  if (rt === null || !rt.alive || rt.closing || !rt.remoteReady) return {};
  await enableRemote(core, s, rt);
  return {};
}

/** Archive / remove: the remote session ends with Parallax's entry (before the process closes). */
export async function endRemoteBeforeClose(core: EngineCore, s: EntryState): Promise<void> {
  if (s.remote.state === 'off' && s.conversation().bridgeSessionId === null) return;
  await disableRemote(core, s);
}

/** The process ended: no live bridge any more (the wish stays). */
export function remoteProcessEnded(s: EntryState): void {
  s.nextRemoteGeneration();
  s.setRemote(REMOTE_OFF);
}
