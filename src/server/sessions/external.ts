/**
 * External console (Phase 2, ADR-104; WP-30 §4.12, architecture §5.2): `session.openExternal`
 * closes the SDK query first (never two writers on one Claude session), opens a visible console
 * with `claude --resume <id>` (`ClaudeIntegration.consoleLaunchFor` → `ConsoleLauncher.open`) and
 * records the handoff (`Entry.external`, status `external`, px item `system/handoff`). Every
 * `externalPollMs` the engine asks `ConsoleLauncher.state()`: `ended` brings the session back on
 * its own – `session.reclaim` does the same at once (refused while the console runs or its state
 * is unknown). The return imports the turns made in the console from the CLI transcript
 * (`readHistory`, messages from `since − 5 s` on, `normalizeHistory` after `lastOrder`, ids already
 * in the log dropped), adds `system/handoff {returned, importedItems}` and ends in `sleeping`.
 * Server start: an open handoff is checked again (running/unknown → watched, ended → return);
 * the shutdown leaves the console alone. `session.consoleCommand` hands out the PowerShell line
 * of the same spec ("copy console command", changes nothing).
 *
 * Secrets: the console spec carries the profile env in plain text (`env`, `explicitEnv`, ADR-104).
 * It is never logged and never put into an op, an item or an error – a launcher failure reason is
 * scrubbed of every env value before it is logged or answered.
 */
import type { ClientId, PermissionMode } from '@shared/common';
import { currentSessionId, type ExternalHandoff } from '@shared/model';
import type { CommandResult, SessionOp } from '@shared/protocol';
import { consoleCommandText } from '../claude/consoleCommand';
import { isSecretEnvKey } from '../claude/profiles';
import type { ConsoleLaunchRequest, ConsoleLaunchSpec, LaunchSpec } from '../claude/ports';
import { redactText, REDACTED } from '../lib/logger';
import type { ConsoleOpenResult, ConsoleProcess } from '../system/ports';
import { cancelContinue } from './continuePlan';
import {
  assertEntryGate,
  assertWithoutWork,
  commandError,
  errorMessage,
  type EngineCore,
  type EntryState,
} from './entryState';
import { closeRuntime } from './runtime';

/** Messages of the CLI transcript from this long before the handoff on count as console turns. */
export const HANDOFF_IMPORT_SLACK_MS = 5_000;
/** Length of a launcher failure reason in EXTERNAL_CONSOLE_FAILED {reason} and the log. */
export const CONSOLE_REASON_CHARS = 200;
/** Env values shorter than this are not scrubbed from a failure reason (`1`, `true` …). */
const SCRUB_MIN_CHARS = 4;

export type ConsoleState = 'running' | 'ended' | 'unknown';

/** The recorded console process (an unparsable start time counts as unknown). */
export function consoleProcessOf(ext: ExternalHandoff): ConsoleProcess {
  const startedAt = ext.processStartedAt === null ? null : new Date(ext.processStartedAt);
  return {
    pid: ext.pid,
    startedAt: startedAt === null || Number.isNaN(startedAt.getTime()) ? null : startedAt,
  };
}

/**
 * A launcher failure reason without any value of the console env (profile secrets, ADR-104),
 * registered secrets and token patterns (`redactText`), capped.
 */
export function scrubConsoleReason(reason: string, spec: ConsoleLaunchSpec | null): string {
  let text = reason;
  if (spec !== null) {
    const values = new Set<string>(Object.values(spec.explicitEnv));
    for (const [name, value] of Object.entries(spec.env)) if (isSecretEnvKey(name)) values.add(value);
    // Longest first: a value that contains another one is replaced as a whole.
    for (const value of [...values].sort((a, b) => b.length - a.length)) {
      if (value.length >= SCRUB_MIN_CHARS) text = text.split(value).join(REDACTED);
    }
  }
  const scrubbed = redactText(text).trim();
  return (scrubbed === '' ? 'failed' : scrubbed).slice(0, CONSOLE_REASON_CHARS);
}

/** `ConsoleLauncher.state()` that never throws; no launcher → 'unknown' (never "ended", ADR-051). */
export async function consoleState(core: EngineCore, ext: ExternalHandoff): Promise<ConsoleState> {
  const launcher = core.consoleLauncher;
  if (launcher === null) return 'unknown';
  try {
    return await launcher.state(consoleProcessOf(ext));
  } catch (error) {
    core.log.warn({ err: error, pid: ext.pid }, 'console state check failed');
    return 'unknown';
  }
}

/** The stored mode if the profile still allows it (§5.2, C.3), else null (omitted). */
function consolePermissionMode(core: EngineCore, s: EntryState): PermissionMode | null {
  const mode = s.entry.permissionMode;
  return mode === 'bypassPermissions' && !core.allowsBypass(s.entry.profileId) ? null : mode;
}

function consoleRequest(core: EngineCore, s: EntryState, resumeSessionId: string): ConsoleLaunchRequest {
  return {
    profileId: s.entry.profileId,
    entryId: s.id,
    cwd: s.entry.cwd,
    resumeSessionId,
    model: s.entry.modelSetting,
    permissionMode: consolePermissionMode(core, s),
  };
}

function positivePid(pid: number | null): number | null {
  return pid !== null && Number.isSafeInteger(pid) && pid > 0 ? pid : null;
}

function isoOrNull(date: Date | null): string | null {
  return date === null || Number.isNaN(date.getTime()) ? null : date.toISOString();
}

// ---- session.openExternal ----

/** WP-30 §4.12 `session.openExternal` (see the file comment). */
export async function openExternal(
  core: EngineCore,
  s: EntryState,
  clientId: ClientId,
): Promise<CommandResult<'session.openExternal'>> {
  s.cancelRetry();
  return s.lifecycle.run(async () => {
    core.assertRunning();
    // R4-01: a second click (or a second window) that waited for this lock while the first
    // handoff opened its console – never two consoles; archived meanwhile likewise.
    assertEntryGate(s, 'session.openExternal');
    const sessionId = currentSessionId(s.entry);
    if (sessionId === null) throw commandError('SESSION_NOT_STARTED', { entryId: s.id });
    assertWithoutWork(s);
    const launcher = core.consoleLauncher;
    if (launcher === null) throw commandError('EXTERNAL_CONSOLE_FAILED', { reason: 'unavailable' });
    // R4-09: a deleted folder or one replaced by a link (R1-17) fails like a start (CWD_*), before
    // the query is closed.
    await core.checkCwd(s.entry.cwd);
    // The console takes over: no scheduled "continue" and no auto-retry of this server.
    cancelContinue(s);
    s.cancelRetry();
    await closeRuntime(s, core, 'handoff');
    // R2-02/R2-08: an orphaned claude.exe of an earlier run may still write the Claude JSONL.
    await s.orphanCleanup;
    core.assertRunning();
    // Expired cards (A.10) are settled like by a resume – the console resumes the conversation.
    s.broker.closeExpired(clientId);
    const conversation = s.conversation();
    // Profile errors (PROFILE_INVALID, CLAUDE_NOT_FOUND …) pass through; the entry stays dormant.
    const spec = await core.claude.consoleLaunchFor(consoleRequest(core, s, sessionId));
    // R4-03: nothing is opened once the shutdown began (it waits for this lock, bounded).
    core.assertRunning();
    let result: ConsoleOpenResult;
    try {
      result = await launcher.open(spec);
    } catch (error) {
      result = { kind: 'failed', reason: errorMessage(error) };
    }
    if (result.kind === 'failed') {
      const reason = scrubConsoleReason(result.reason, spec);
      core.log.warn({ entryId: s.id, reason }, 'external console could not be opened');
      throw commandError('EXTERNAL_CONSOLE_FAILED', { reason });
    }
    // The console runs now: record it even if a shutdown began meanwhile – the shutdown waits for
    // this lock (bounded, R4-03) before it flushes the stores; the next start checks the console.
    const pid = positivePid(result.process.pid);
    const since = core.now().toISOString();
    s.patch((e) => ({
      ...e,
      external: {
        pid,
        processStartedAt: isoOrNull(result.process.startedAt),
        since,
        conversationId: conversation.id,
      },
    }));
    s.externalRunning = true;
    s.reduce({ type: 'external', active: true });
    s.addHandoffItem('external', 0);
    core.log.info({ entryId: s.id, pid }, 'session handed off to an external console');
    watchExternal(core, s);
    return { pid };
  });
}

// ---- watching ----

/** Arms the next `state()` check (every `externalPollMs`) of an entry that is open in a console. */
export function watchExternal(core: EngineCore, s: EntryState): void {
  s.externalTimer?.cancel();
  s.externalTimer = null;
  if (core.shuttingDown() || s.entry.external === null || core.consoleLauncher === null) return;
  s.externalTimer = core.timers.setTimeout(() => {
    s.externalTimer = null;
    pollExternal(core, s).catch((error: unknown) => {
      core.reportError(error, 'external console check');
    });
  }, core.options.externalPollMs);
}

async function pollExternal(core: EngineCore, s: EntryState): Promise<void> {
  const ext = s.entry.external;
  if (ext === null || core.shuttingDown()) return;
  const state = await consoleState(core, ext);
  // Reclaimed meanwhile, or the server is stopping (it leaves the console alone).
  if (core.shuttingDown() || s.entry.external !== ext) return;
  if (state === 'ended') {
    await returnFromExternal(core, s, 'auto');
    return;
  }
  watchExternal(core, s);
}

/**
 * Server start (ADR-104): an open handoff is checked again – running/unknown → stays `external`
 * and is watched, ended → the return runs. Never rejects.
 */
export async function restoreExternal(core: EngineCore, s: EntryState): Promise<void> {
  const ext = s.entry.external;
  if (ext === null) {
    // `external` without a handoff record (hand-edited registry): nothing could ever return it.
    if (s.facts.runState === 'external') {
      core.log.warn({ entryId: s.id }, 'runState external without a handoff record – set to sleeping');
      s.reduce({ type: 'external', active: false });
    }
    return;
  }
  if (s.facts.runState !== 'external') s.reduce({ type: 'external', active: true });
  try {
    const state = await consoleState(core, ext);
    if (core.shuttingDown() || s.entry.external !== ext) return;
    if (state === 'ended') {
      await returnFromExternal(core, s, 'auto');
      return;
    }
    watchExternal(core, s);
  } catch (error) {
    core.reportError(error, 'external console check at the start');
  }
}

// ---- return (reclaim / automatic) ----

/**
 * The return from the console (ADR-104). `command` (`session.reclaim`): refused with
 * EXTERNAL_STILL_RUNNING {pid} while the console runs or its state is unknown; `auto`: the caller
 * saw `ended`. Not handed off (any more) → `{importedItems: 0}` (the automatic return won the race).
 */
export async function returnFromExternal(
  core: EngineCore,
  s: EntryState,
  mode: 'command' | 'auto',
): Promise<CommandResult<'session.reclaim'>> {
  return s.lifecycle.run(async () => {
    const ext = s.entry.external;
    if (ext === null) {
      if (s.facts.runState === 'external') s.reduce({ type: 'external', active: false });
      return { importedItems: 0 };
    }
    if (mode === 'command') {
      const state = await consoleState(core, ext);
      if (state !== 'ended') throw commandError('EXTERNAL_STILL_RUNNING', { pid: ext.pid });
    }
    if (core.shuttingDown()) return { importedItems: 0 };
    s.externalTimer?.cancel();
    s.externalTimer = null;
    // Summary `external.running: false` while the console transcript is read.
    s.externalRunning = false;
    s.touch(true);
    const imported = await importConsoleTurns(core, s, ext);
    // Stopping meanwhile: the next start sees `ended` again and imports again (ids filter duplicates).
    if (core.shuttingDown()) return { importedItems: imported.items };
    s.addHandoffItem('returned', imported.items);
    const at = core.now().toISOString();
    s.patch((e) => ({ ...e, external: null, ...(imported.items > 0 ? { lastActivityAt: at } : {}) }));
    s.externalRunning = true;
    s.reduce({ type: 'external', active: false });
    core.log.info(
      { entryId: s.id, importedItems: imported.items },
      'session returned from the external console',
    );
    // Like after a turn: the CLI may have written an AI title in the console; the branch may differ.
    if (imported.launch !== null) void s.queryAiTitle(imported.launch);
    void s.refreshGitBranch();
    return { importedItems: imported.items };
  });
}

/**
 * The turns made in the console: CLI transcript messages with a timestamp ≥ since − 5 s (without
 * one: dropped), normalized after the conversation's `lastOrder`, items whose id is already in the
 * log dropped, the rest published and logged. A read failure imports nothing (logged).
 */
async function importConsoleTurns(
  core: EngineCore,
  s: EntryState,
  ext: ExternalHandoff,
): Promise<{ items: number; launch: LaunchSpec | null }> {
  const handedOff = s.entry.conversations.find((c) => c.id === ext.conversationId) ?? s.conversation();
  const sessionId = handedOff.sessionId;
  if (sessionId === null) return { items: 0, launch: null };
  let launch: LaunchSpec;
  try {
    launch = await core.claude.launchSpecFor(s.entry.profileId, s.id);
  } catch (error) {
    core.log.warn(
      { err: error, entryId: s.id },
      'console transcript not read (no launch spec) – nothing imported',
    );
    return { items: 0, launch: null };
  }
  try {
    const messages = await core.backend.readHistory({ sessionId, cwd: s.entry.cwd, launch });
    const from = Date.parse(ext.since) - HANDOFF_IMPORT_SLACK_MS;
    const fresh = messages.filter((m) => m.timestamp !== null && Date.parse(m.timestamp) >= from);
    if (fresh.length === 0) return { items: 0, launch };
    const current = s.conversation();
    const logged = await core.stores.transcripts.readTail(s.id, current.id, Number.MAX_SAFE_INTEGER);
    const known = new Set(logged.items.map((item) => item.id));
    const { items } = core.normalizer.normalizeHistory(fresh, {
      entryId: s.id,
      conversationId: current.id,
      nextOrder: current.lastOrder + 1,
      storeBlob: (data, mediaType, name) => core.stores.blobs.put(data, mediaType, name),
      now: core.now,
    });
    const added = items.filter((item) => !known.has(item.id));
    s.emit(added.map((item): SessionOp => ({ op: 'item.upsert', item })));
    return { items: added.length, launch };
  } catch (error) {
    core.log.warn({ err: error, entryId: s.id }, 'console transcript could not be read – nothing imported');
    return { items: 0, launch };
  }
}

// ---- session.consoleCommand ----

/** "Copy console command" (ADR-104): the PowerShell line of the console spec; changes nothing. */
export async function consoleCommand(
  core: EngineCore,
  s: EntryState,
): Promise<CommandResult<'session.consoleCommand'>> {
  const ext = s.entry.external;
  const handedOff = ext === null ? undefined : s.entry.conversations.find((c) => c.id === ext.conversationId);
  const sessionId = handedOff?.sessionId ?? currentSessionId(s.entry);
  if (sessionId === null) throw commandError('SESSION_NOT_STARTED', { entryId: s.id });
  const spec = await core.claude.consoleLaunchFor(consoleRequest(core, s, sessionId));
  return { command: consoleCommandText(spec), sessionId };
}
