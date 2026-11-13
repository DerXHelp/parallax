/**
 * Commands of the engine (WP-13 §3.5.6; WP-02 §7.5, vorrangig architecture §5.2; Phase 2 WP-30
 * §4.12). General rules: shutdown running → SERVER_SHUTTING_DOWN; unknown entry → ENTRY_NOT_FOUND;
 * runState `external` → only the console-safe commands, else SESSION_EXTERNAL; archived entry →
 * only the read-mode commands, else SESSION_ARCHIVED (ADR-106) – both gates are checked again
 * inside the lifecycle lock (`assertEntryGate`, R4-01); host commands (`profile.*`,
 * `fs.listDirectory`; Phase 3 `file.*`, `files.*`, `editor.detect` – ADR-140) go to the
 * `HostCommandHandler` with that name (ADR-101), none → NOT_IMPLEMENTED; unexpected errors → logged, INTERNAL_ERROR. Results match
 * `commandResultSchemas` (the hub checks them again). WP-34: image attachments (attachments.ts,
 * ADR-103), external console (external.ts, ADR-104), continue after the rate limit
 * (continuePlan.ts, ADR-112). Phase 3 (WP-51, WP-50 §4.12): PDF/file attachments and pastes
 * (attachments.ts, ADR-146), `session.stopTask` (ADR-149), `plan.list`/`plan.read` (ADR-148) and
 * `approve_fresh_context` (freshContext.ts, ADR-147). WP-63: `session.remove` (remove from
 * Parallax only, files stay). WP-64: `session.setRemoteControl` and the Remote Control default of
 * new entries (remoteControl.ts); archive/remove end the remote session first.
 */
import { LIMITS, type ClientId, type ProfileId } from '@shared/common';
import { makeError } from '@shared/errors';
import { currentSessionId, type Entry, type PlanDecision, type Settings } from '@shared/model';
import {
  isHostCommand,
  type Command,
  type CommandOf,
  type CommandResult,
  type HostCommand,
  type SessionOp,
} from '@shared/protocol';
import { CommandError, type CommandContext, type HostCommandHandler } from '../sync/ports';
import { checkAttachments, checkPastes, materializeAttachments, type PromptAttachments } from './attachments';
import { cancelContinue, planContinue } from './continuePlan';
import {
  assertEntryGate,
  assertWithoutWork,
  commandError,
  errorMessage,
  errorPayloadOf,
  gaugeOf,
  type EngineCore,
  type EntryCommand,
  type EntryState,
} from './entryState';
import { consoleCommand, openExternal, returnFromExternal } from './external';
import { approveFreshContext } from './freshContext';
import { catalogOrFallback, toModelCatalog } from './models';
import { endRemoteBeforeClose, setRemoteControl } from './remoteControl';
import { closeRuntime, deliverPrompt, startRuntime } from './runtime';
import { capTitle, implementPlanPrompt, newConversation, titleFromPrompt } from './summary';
import { regenerateTitle } from './titles';

export interface CommandEngine {
  readonly core: EngineCore;
  state(entryId: string): EntryState | undefined;
  /** Registers a new entry (registry + summary) and returns its state. */
  createEntry(entry: Entry, promptTitle: string | null): EntryState;
  /**
   * WP-63: drops a (closed) entry from the engine, the registry and every window (`summary.remove`,
   * host state); its files stay on disk.
   */
  removeEntry(s: EntryState): void;
  /** Entries with a process (counted BEFORE closing, R0-19). */
  runningCount(): number;
  /** server.shutdown: flag + `setImmediate(onShutdownRequested)` after the ack. */
  requestShutdown(): void;
  /** ADR-101: handlers of the host commands (names disjoint). */
  readonly hostCommands: readonly HostCommandHandler[];
  /** After a successful settings.update: host state, sleep re-plan, `onSettingsChanged`. */
  settingsChanged(prev: Settings, next: Settings): void;
}

export async function handleCommand(
  engine: CommandEngine,
  cmd: Command,
  ctx: CommandContext,
): Promise<unknown> {
  try {
    engine.core.assertRunning();
    switch (cmd.name) {
      case 'session.create':
        return await createSession(engine, cmd, ctx.clientId);
      case 'settings.update': {
        const prev = engine.core.stores.settings.get();
        const settings = engine.core.stores.settings.update(cmd.patch);
        engine.settingsChanged(prev, settings);
        return { settings } satisfies CommandResult<'settings.update'>;
      }
      case 'server.shutdown': {
        const sessionsStopped = engine.runningCount();
        engine.requestShutdown();
        return { sessionsStopped } satisfies CommandResult<'server.shutdown'>;
      }
      default:
        if (isHostCommand(cmd)) return await hostCommand(engine, cmd, ctx);
        return await entryCommand(engine, cmd, ctx.clientId);
    }
  } catch (error) {
    if (error instanceof CommandError) throw error;
    engine.core.reportError(error, `command ${cmd.name}`);
    throw new CommandError(makeError('INTERNAL_ERROR', { command: cmd.name }));
  }
}

function notImplemented(name: string): CommandError {
  return commandError('NOT_IMPLEMENTED', { command: name });
}

/** ADR-101: the handler that lists the name; its CommandErrors pass through unchanged. */
async function hostCommand(engine: CommandEngine, cmd: HostCommand, ctx: CommandContext): Promise<unknown> {
  const handler = engine.hostCommands.find((h) => h.names.includes(cmd.name));
  if (handler === undefined) throw notImplemented(cmd.name);
  return handler.handle(cmd, ctx);
}

/** C.3 / R0-09: `bypassPermissions` only if the profile allows it. */
function assertModeAllowed(core: EngineCore, profileId: ProfileId, mode: string | null | undefined): void {
  if (mode === 'bypassPermissions' && !core.allowsBypass(profileId)) {
    throw commandError('MODE_NOT_ALLOWED', { mode, profileId });
  }
}

async function controlCall<T>(
  method: string,
  call: () => Promise<T>,
  core: EngineCore,
  entryId: string,
): Promise<T> {
  try {
    return await call();
  } catch (error) {
    core.log.warn({ err: error, entryId, method }, 'control request failed');
    throw commandError('CLAUDE_CONTROL_FAILED', { method });
  }
}

// ---- session.create ----

async function createSession(
  engine: CommandEngine,
  cmd: CommandOf<'session.create'>,
  clientId: ClientId,
): Promise<CommandResult<'session.create'>> {
  const core = engine.core;
  const profileId = cmd.profileId ?? core.claude.profiles.getDefault().id;
  const profile = core.profile(profileId);
  if (profile === undefined) throw commandError('PROFILE_NOT_FOUND', { profileId });
  await core.checkCwd(cmd.cwd);
  const permissionMode = cmd.permissionMode ?? profile.defaults.permissionMode;
  assertModeAllowed(core, profileId, permissionMode);
  // ADR-103/146: pastes and attachments are checked before the entry exists (a bad one creates
  // nothing); files are materialized once the entry exists.
  const pastes = checkPastes(cmd.prompt?.text ?? '', cmd.prompt?.pastes ?? []);
  const checked = await checkAttachments(core.stores.blobs, cmd.prompt?.attachments ?? [], {
    files: core.stores.attachments !== null,
  });
  core.assertRunning();

  const now = core.now().toISOString();
  // WP-64: `on`/`off` decide now; `follow_claude` starts from the last known default of this
  // profile and takes Claude's own setting after the first readiness.
  const newSessions = core.stores.settings.get().remoteControl.newSessions;
  const remoteControlWanted =
    newSessions === 'on' || (newSessions === 'follow_claude' && core.remoteControlDefault(profileId) === true);
  const given = cmd.title?.trim() ?? '';
  const promptTitle = cmd.prompt === undefined ? null : titleFromPrompt(cmd.prompt.text);
  const entry: Entry = {
    id: core.ids.newId('en'),
    createdAt: now,
    profileId,
    cwd: cmd.cwd,
    title: given !== '' ? capTitle(given) : (promptTitle ?? ''),
    titleSource: given !== '' ? 'custom' : promptTitle !== null ? 'prompt' : 'none',
    pinned: false,
    archived: false,
    lastActivityAt: now,
    conversations: [newConversation(core.ids.newId('cv'), now)],
    modelSetting: cmd.model ?? profile.defaults.model,
    lastModel: null,
    permissionMode,
    effort: cmd.effort ?? profile.defaults.effort,
    fastMode: null,
    cliVersion: null,
    apiKeySource: null,
    lastRunState: 'sleeping',
    contextPct: null,
    lastError: null,
    lastResultExcerpt: null,
    unread: false,
    context: null,
    gitBranch: null,
    external: null,
    continueAt: null,
    remoteControlWanted,
    turnSummary: null,
    lastSeenAt: null,
  };
  const s = engine.createEntry(entry, promptTitle);
  s.followClaudeDefault = newSessions === 'follow_claude';
  const prompt = cmd.prompt;
  if (prompt === undefined) return { entryId: entry.id, messageUuid: null };
  try {
    const messageUuid = await s.lifecycle.run(async () => {
      const attachments = await materializeForNewEntry(core, s, checked);
      await startRuntime(s, core, { byClientId: clientId });
      return deliverPrompt(s, core, prompt.text, 'next', { attachments, pastes });
    });
    return { entryId: entry.id, messageUuid };
  } catch (error) {
    if (error instanceof CommandError && error.error.code === 'SERVER_SHUTTING_DOWN') throw error;
    // The entry exists; the start failure shows as status `error` in its summary.
    core.log.warn({ err: error, entryId: entry.id }, 'session.create: start failed');
    return { entryId: entry.id, messageUuid: null };
  }
}

/**
 * ADR-146: the files of the first prompt go into the new entry's attachment folder before its
 * start; a failure ends like a failed start (status `error`, px item, lastError) – nothing starts.
 */
async function materializeForNewEntry(
  core: EngineCore,
  s: EntryState,
  checked: PromptAttachments,
): Promise<PromptAttachments> {
  try {
    return await materializeAttachments(core.stores.attachments, s.id, checked);
  } catch (error) {
    core.log.warn({ err: error, entryId: s.id }, 'session.create: attachments could not be materialized');
    const payload = errorPayloadOf(error, makeError('INTERNAL_ERROR', {}, errorMessage(error)));
    s.failStart(payload);
    throw new CommandError(payload);
  }
}

// ---- commands of one entry ----

async function entryCommand(engine: CommandEngine, cmd: EntryCommand, clientId: ClientId): Promise<unknown> {
  const s = engine.state(cmd.entryId);
  if (s === undefined) throw commandError('ENTRY_NOT_FOUND', { entryId: cmd.entryId });
  // Checked again inside the lifecycle lock by every command that waits for it (R4-01).
  assertEntryGate(s, cmd.name);
  const core = engine.core;
  switch (cmd.name) {
    case 'session.sendPrompt':
      return sendPrompt(core, s, cmd, clientId);
    case 'session.interrupt':
      return interrupt(core, s);
    case 'session.setModel': {
      const runtime = running(s);
      if (runtime !== null)
        await controlCall('setModel', () => runtime.agent.setModel(cmd.model), core, s.id);
      s.patch((e) => ({ ...e, modelSetting: cmd.model }));
      return {} satisfies CommandResult<'session.setModel'>;
    }
    case 'session.setPermissionMode': {
      assertModeAllowed(core, s.entry.profileId, cmd.mode);
      const runtime = running(s);
      if (runtime !== null) {
        await controlCall('setPermissionMode', () => runtime.agent.setPermissionMode(cmd.mode), core, s.id);
      }
      // Idle the CLI reports nothing (F.2): the engine takes the mode over locally; dormant it
      // applies on the next resume (C.3-checked again).
      s.patch((e) => ({ ...e, permissionMode: cmd.mode }));
      return {} satisfies CommandResult<'session.setPermissionMode'>;
    }
    case 'session.setEffort': {
      const runtime = running(s);
      if (runtime !== null) {
        await controlCall(
          'applyFlagSettings',
          () => runtime.agent.applyFlagSettings({ effortLevel: cmd.effort }),
          core,
          s.id,
        );
      }
      s.patch((e) => ({ ...e, effort: cmd.effort }));
      return {} satisfies CommandResult<'session.setEffort'>;
    }
    case 'session.setFastMode': {
      // §4.12: running → flag setting first (failure: CLAUDE_CONTROL_FAILED, nothing stored);
      // dormant → stored, the next start passes it (StartSessionRequest.fastMode).
      const runtime = running(s);
      if (runtime !== null) {
        await controlCall(
          'applyFlagSettings',
          () => runtime.agent.applyFlagSettings({ fastMode: cmd.enabled }),
          core,
          s.id,
        );
      }
      s.patch((e) => (e.fastMode === cmd.enabled ? e : { ...e, fastMode: cmd.enabled }));
      return {} satisfies CommandResult<'session.setFastMode'>;
    }
    case 'session.setPinned':
      s.patch((e) => (e.pinned === cmd.pinned ? e : { ...e, pinned: cmd.pinned }));
      return {} satisfies CommandResult<'session.setPinned'>;
    case 'session.setArchived':
      return setArchived(core, s, cmd.archived);
    case 'session.rename':
      return rename(core, s, cmd.title);
    case 'session.close':
      s.cancelRetry();
      await s.lifecycle.run(() => closeRuntime(s, core, 'user'));
      return {} satisfies CommandResult<'session.close'>;
    case 'session.resume':
      s.cancelRetry();
      await s.lifecycle.run(async () => {
        assertEntryGate(s, cmd.name);
        if (s.runtime === null) await startRuntime(s, core, { byClientId: clientId });
      });
      return {} satisfies CommandResult<'session.resume'>;
    case 'decision.respond':
      return respond(core, s, cmd, clientId);
    case 'transcript.loadEarlier': {
      if (!s.entry.conversations.some((c) => c.id === cmd.conversationId)) {
        throw commandError('CONVERSATION_NOT_FOUND', { conversationId: cmd.conversationId });
      }
      const page = await core.stores.transcripts.readBefore(
        s.id,
        cmd.conversationId,
        cmd.beforeOrder,
        cmd.limit,
      );
      return {
        items: page.items,
        hasEarlier: page.hasEarlier,
      } satisfies CommandResult<'transcript.loadEarlier'>;
    }
    case 'session.getContext':
      return getContext(core, s, cmd.detail);
    case 'session.refreshModels':
      return refreshModels(core, s);
    case 'session.switchConversation':
      return switchConversation(core, s, cmd.conversationId, clientId);
    // Phase 2 (WP-34): external console (ADR-104), continue after the rate limit (ADR-112).
    case 'session.openExternal':
      return openExternal(core, s, clientId);
    case 'session.reclaim':
      return returnFromExternal(core, s, 'command');
    case 'session.consoleCommand':
      return consoleCommand(core, s);
    case 'session.continueAfterLimit':
      if (!cmd.enabled) {
        cancelContinue(s);
        return { continueAt: null } satisfies CommandResult<'session.continueAfterLimit'>;
      }
      return { continueAt: planContinue(core, s) } satisfies CommandResult<'session.continueAfterLimit'>;
    // Phase 3 (WP-50 §4.12): stop one task (ADR-149) and the plan versions (ADR-148).
    case 'session.stopTask':
      return stopTask(core, s, cmd.taskId);
    // WP-65: move foreground work to the background, generate the title again.
    case 'session.backgroundTasks':
      return backgroundTasks(core, s, cmd.toolUseId);
    case 'session.regenerateTitle':
      s.cancelRetry();
      await s.lifecycle.run(async () => {
        assertEntryGate(s, cmd.name);
        // generateSessionTitle needs a process: a dormant session starts like session.resume.
        if (s.runtime === null) await startRuntime(s, core, { byClientId: clientId });
      });
      await regenerateTitle(s, core);
      return {} satisfies CommandResult<'session.regenerateTitle'>;
    case 'plan.list':
      return planList(core, s);
    case 'plan.read': {
      const text = await core.stores.decisions.readPlan(s.id, cmd.version);
      if (text === null) throw commandError('PLAN_NOT_FOUND', { version: cmd.version });
      return { version: cmd.version, text } satisfies CommandResult<'plan.read'>;
    }
    // WP-63: remove from Parallax only (files stay on disk).
    case 'session.remove':
      return removeSession(engine, s);
    // WP-64: Remote Control (the wish; a running process is switched at once).
    case 'session.setRemoteControl':
      return setRemoteControl(core, s, cmd.enabled);
  }
}

/**
 * WP-63 `session.remove`: in the lifecycle lock a running process is closed first like
 * `session.close` (also during a turn; open decisions end with the process, `process_exit`), a
 * scheduled "continue" and every timer are dropped; then the entry leaves the engine, the registry
 * and every window (`summary.remove`; subscribers get `session.unavailable`). Nothing on disk is
 * deleted: the claude transcript, `entries/<entryId>/` (transcript log, decisions, plan versions,
 * attachments, file index, command cache) and the blobs stay – no start-up cleanup touches them.
 * Allowed for archived and external entries too (an external console keeps running on its own).
 * A command that waited for the lock meanwhile answers ENTRY_NOT_FOUND (`assertEntryGate`).
 */
async function removeSession(engine: CommandEngine, s: EntryState): Promise<CommandResult<'session.remove'>> {
  const core = engine.core;
  s.cancelRetry();
  await s.lifecycle.run(async () => {
    if (s.removed) return;
    cancelContinue(s);
    // WP-64: the remote session in the Claude app ends with the entry.
    await endRemoteBeforeClose(core, s);
    await closeRuntime(s, core, 'remove');
    engine.removeEntry(s);
  });
  return {};
}

/**
 * ADR-149: the process runs (else SESSION_NOT_RUNNING; external → SESSION_EXTERNAL at the gate);
 * the task is a background task or a running/background tool-call task (else TASK_NOT_FOUND).
 * The effect arrives later as `task_notification stopped`.
 */
async function stopTask(
  core: EngineCore,
  s: EntryState,
  taskId: string,
): Promise<CommandResult<'session.stopTask'>> {
  const runtime = running(s);
  if (runtime === null) throw commandError('SESSION_NOT_RUNNING', { entryId: s.id });
  if (!hasStoppableTask(s, taskId)) throw commandError('TASK_NOT_FOUND', { taskId });
  await controlCall('stopTask', () => runtime.agent.stopTask(taskId), core, s.id);
  return {};
}

/**
 * WP-65: `backgroundTasks(toolUseId?)` like Ctrl+B in the terminal. The process runs (else
 * SESSION_NOT_RUNNING); a given tool use is a running main-thread Bash/Agent call and the CLI found it
 * (else TASK_NOT_FOUND); a failed request → CLAUDE_CONTROL_FAILED. The task panel shows the result.
 */
async function backgroundTasks(
  core: EngineCore,
  s: EntryState,
  toolUseId: string | null,
): Promise<CommandResult<'session.backgroundTasks'>> {
  const runtime = running(s);
  if (runtime === null) throw commandError('SESSION_NOT_RUNNING', { entryId: s.id });
  if (toolUseId !== null) {
    const call = s.findToolCall(toolUseId);
    if (call === null || (call.status !== 'running' && call.status !== 'pending')) {
      throw commandError('TASK_NOT_FOUND', { taskId: toolUseId });
    }
  }
  const moved = await controlCall('backgroundTasks', () => runtime.agent.backgroundTasks(toolUseId), core, s.id);
  if (!moved) throw commandError('TASK_NOT_FOUND', { taskId: toolUseId ?? '' });
  return {};
}

function hasStoppableTask(s: EntryState, taskId: string): boolean {
  const view = s.mirror;
  if (view === null) return false;
  if (view.detail.backgroundTasks.some((t) => t.taskId === taskId)) return true;
  return view.items.some(
    (item) =>
      item.kind === 'tool_call' &&
      item.task?.taskId === taskId &&
      (item.status === 'running' || item.status === 'background'),
  );
}

/**
 * ADR-148: every kept record with a plan version, ascending; `stored` = plans/v<N>.md exists (CR3-09:
 * known versions without reading their text, planIndex.ts).
 */
async function planList(core: EngineCore, s: EntryState): Promise<CommandResult<'plan.list'>> {
  const versions = await Promise.all(
    s.broker.planRecords().map(async (record) => ({
      version: record.planVersion,
      decisionId: record.id,
      conversationId: record.conversationId,
      createdAt: record.createdAt,
      resolvedAt: record.resolvedAt,
      outcome: record.outcome,
      planFilePath: record.planFilePath,
      stored: await planStored(core, s.id, record.planVersion),
    })),
  );
  return { versions };
}

async function planStored(core: EngineCore, entryId: string, version: number): Promise<boolean> {
  try {
    return await core.stores.decisions.planStored(entryId, version);
  } catch (error) {
    core.log.warn({ err: error, entryId, version }, 'plan version unreadable');
    return false;
  }
}

/** The runtime if a process runs and accepts control requests. */
function running(s: EntryState): NonNullable<EntryState['runtime']> | null {
  const runtime = s.runtime;
  return runtime !== null && s.phase === 'running' && runtime.alive && !runtime.closing ? runtime : null;
}

async function sendPrompt(
  core: EngineCore,
  s: EntryState,
  cmd: CommandOf<'session.sendPrompt'>,
  clientId: ClientId,
): Promise<CommandResult<'session.sendPrompt'>> {
  const text = cmd.prompt.text;
  const list = cmd.prompt.attachments;
  /** An own prompt: no auto-retry, no scheduled "continue" (ADR-112), the prompt title. */
  const accept = (): void => {
    s.cancelRetry();
    cancelContinue(s);
    if (s.entry.titleSource === 'none') {
      const title = titleFromPrompt(text);
      if (title !== null) {
        s.promptTitle = title;
        s.patch((e) => ({ ...e, title, titleSource: 'prompt' }));
      }
    }
  };
  // ADR-146: every paste occurs in the text (nothing changes otherwise).
  const pastes = checkPastes(text, cmd.prompt.pastes);
  const messageUuid = await s.lifecycle.run(async () => {
    // R4-01: handed off or archived while this prompt waited for the lock.
    assertEntryGate(s, cmd.name);
    // ADR-103/146: the attachments are checked (and files materialized) before anything starts, is
    // sent or changes – inside the lock, so a Stop right after this prompt still waits for it (R2-15).
    const checked = await checkAttachments(core.stores.blobs, list, {
      files: core.stores.attachments !== null,
    });
    const attachments = await materializeAttachments(core.stores.attachments, s.id, checked);
    // CR2-04: only a prompt past both checks changes plan, retry and title (the title still shows
    // before its own start waits for an orphan check).
    accept();
    if (s.runtime === null) await startRuntime(s, core, { byClientId: clientId });
    return deliverPrompt(s, core, text, cmd.priority, { attachments, pastes });
  });
  return { messageUuid };
}

async function interrupt(core: EngineCore, s: EntryState): Promise<CommandResult<'session.interrupt'>> {
  // R2-15: Stop right after the first prompt – the start (and the delivery) still runs in the lock:
  // wait for it, then stop the turn it began instead of dropping the request.
  if (running(s) === null && s.lifecycle.pending > 0) await s.lifecycle.idle();
  const runtime = running(s);
  // Idle/dormant: nothing to stop (F.10).
  if (runtime === null) return { stillQueued: [] };
  // Open decisions first (deny + interrupt), else the turn may hang in requires_action (§3.4).
  s.broker.cancel('all', 'interrupted', 'deny-interrupt');
  const result = await controlCall('interrupt', () => runtime.agent.interrupt(), core, s.id);
  return { stillQueued: [...result.stillQueued] };
}

/**
 * ADR-106: `true` only without work (SESSION_BUSY) – ends a running process, clears the entry's
 * notifications and a scheduled "continue"; `false` only clears the flag. Both idempotent.
 */
async function setArchived(
  core: EngineCore,
  s: EntryState,
  archived: boolean,
): Promise<CommandResult<'session.setArchived'>> {
  if (!archived) {
    s.patch((e) => (e.archived ? { ...e, archived: false } : e));
    return {};
  }
  if (s.entry.archived) return {};
  s.cancelRetry();
  await s.lifecycle.run(async () => {
    // R4-01: handed off while waiting (never "archived + external") – or archived meanwhile.
    assertEntryGate(s, 'session.setArchived');
    if (s.entry.archived) return;
    assertWithoutWork(s);
    // The flag first: from here on every other command answers SESSION_ARCHIVED (also one that
    // waits for this lock – the lock bodies check the gate again, startRuntime refuses archived
    // entries).
    s.patch((e) => ({ ...e, archived: true }));
    // ADR-112: a scheduled "continue" is dropped (timer, continueAt, wakeupAt).
    cancelContinue(s);
    // WP-64: the remote session in the Claude app ends with the archiving (the wish stays).
    await endRemoteBeforeClose(core, s);
    await closeRuntime(s, core, 'archive');
  });
  s.cancelRetry();
  core.clearNotifications(s.id);
  return {};
}

async function rename(
  core: EngineCore,
  s: EntryState,
  title: string | null,
): Promise<CommandResult<'session.rename'>> {
  if (title === null) {
    // Back to the automatic title (no CLI call).
    const promptTitle = s.promptTitle;
    s.patch((e) => ({
      ...e,
      title: promptTitle ?? '',
      titleSource: promptTitle === null ? 'none' : 'prompt',
    }));
    return {};
  }
  const next = capTitle(title);
  s.patch((e) => ({ ...e, title: next, titleSource: 'custom' }));
  // §4.12: in an external console only the local title (the console owns the Claude session).
  if (s.facts.runState === 'external') return {};
  if (running(s) !== null) {
    renameRunning(core, s, next);
    return {};
  }
  await s.lifecycle.run(async () => {
    if (running(s) !== null) {
      renameRunning(core, s, next);
      return;
    }
    const sessionId = currentSessionId(s.entry);
    if (sessionId === null || s.facts.runState === 'external') return;
    // R2-08: renameSession writes the Claude JSONL – an orphaned claude.exe may still write it.
    await s.orphanCleanup;
    try {
      const launch = await core.claude.launchSpecFor(s.entry.profileId, s.id);
      // C.6: only dormant sessions are renamed through the SDK.
      await core.backend.renameSession({ sessionId, cwd: s.entry.cwd, launch, title: next });
    } catch (error) {
      core.log.warn({ err: error, entryId: s.id }, 'renameSession failed – the local title stays');
    }
  });
  return {};
}

/**
 * Running: the CLI renames itself through its `/rename` command (F.8); the echo is recognized.
 * deliverPrompt sets `pendingRename` – and resets it when send() refuses the prompt (CR2 follow-up).
 */
function renameRunning(core: EngineCore, s: EntryState, title: string): void {
  try {
    deliverPrompt(s, core, `/rename ${title}`, 'next');
  } catch (error) {
    core.log.warn({ err: error, entryId: s.id }, '/rename prompt could not be sent – the local title stays');
  }
}

/**
 * ADR-107 / §4.12: an earlier conversation becomes the current one again. Target ∈ conversations
 * (CONVERSATION_NOT_FOUND) with a Claude session (SESSION_NOT_STARTED), without work
 * (SESSION_BUSY); the current one already → no-op. The process is closed, the current conversation
 * ends with `switched` (its title saved), the target moves to the end (`endedAt/endReason` null);
 * ops: `conversation.reset{trigger 'switch', hasEarlier}` + the target's log tail as `item.upsert`
 * + `detail.patch{conversationId, conversations}`. Title: not `custom` → the target's title. The
 * next prompt resumes the target's Claude session (`currentSessionId`).
 */
async function switchConversation(
  core: EngineCore,
  s: EntryState,
  conversationId: string,
  clientId: ClientId,
): Promise<CommandResult<'session.switchConversation'>> {
  s.cancelRetry();
  await s.lifecycle.run(async () => {
    // R4-01: never switch while (or after) a console took the conversation over.
    assertEntryGate(s, 'session.switchConversation');
    const target = s.entry.conversations.find((c) => c.id === conversationId);
    if (target === undefined) throw commandError('CONVERSATION_NOT_FOUND', { conversationId });
    const previous = s.conversation();
    if (target.id === previous.id) return;
    if (target.sessionId === null) throw commandError('SESSION_NOT_STARTED', { entryId: s.id });
    assertWithoutWork(s);
    // Read first: a failing read changes nothing.
    const tail = await core.stores.transcripts.readTail(s.id, target.id, LIMITS.snapshotItems);
    // R4-08 (ADR-112): a scheduled "continue" belongs to the conversation that is left.
    cancelContinue(s);
    await closeRuntime(s, core, 'switch');
    // Expired cards (A.10) belong to the conversation that is left.
    s.broker.closeExpired(clientId);
    const at = core.now().toISOString();
    const keepCustom = s.entry.titleSource === 'custom';
    s.patch((e) => ({
      ...e,
      conversations: [
        ...e.conversations
          .filter((c) => c.id !== target.id)
          .map((c) =>
            c.id === previous.id
              ? { ...c, endedAt: at, endReason: 'switched' as const, title: e.title === '' ? null : e.title }
              : c,
          ),
        { ...target, endedAt: null, endReason: null },
      ],
      title: keepCustom ? e.title : (target.title ?? ''),
      titleSource: keepCustom ? 'custom' : target.title === null ? 'none' : 'ai',
      // The gauge belonged to the conversation that was left (like /clear).
      context: null,
      contextPct: null,
    }));
    s.promptTitle = null;
    s.pendingRename = null;
    s.resetInTurn = false;
    s.lastSdkMaxTokens = null;
    const ops: SessionOp[] = [
      {
        op: 'conversation.reset',
        conversationId: target.id,
        previousConversationId: previous.id,
        trigger: 'switch',
        hasEarlier: tail.hasEarlier,
      },
      ...tail.items.map((item): SessionOp => ({ op: 'item.upsert', item })),
      { op: 'detail.patch', patch: { conversationId: target.id, conversations: s.entry.conversations } },
    ];
    // The tail is already in the target's log.
    s.emit(ops, { log: false });
  });
  return {};
}

async function respond(
  core: EngineCore,
  s: EntryState,
  cmd: CommandOf<'decision.respond'>,
  clientId: ClientId,
): Promise<CommandResult<'decision.respond'>> {
  const response = cmd.response;
  // ADR-147: while "implement with a fresh context" runs, nothing else is answered (double click).
  if (s.freshContextRunning) throw commandError('SESSION_BUSY', { entryId: s.id });
  if (response.kind === 'plan' && response.response.behavior !== 'revise') {
    assertModeAllowed(core, s.entry.profileId, response.response.mode);
  }
  if (response.kind === 'plan') {
    const approval = response.response;
    if (approval.behavior === 'approve_fresh_context') {
      return approveFreshContext(core, s, { decisionId: cmd.decisionId, response, approval }, clientId);
    }
  }
  const result = s.broker.respond(cmd.decisionId, response, clientId);
  if (result.kind === 'resolved') return { outcome: result.outcome };
  if (result.kind === 'fresh-context') return { outcome: result.outcome };

  // "Fortsetzen & Plan freigeben" (A.10, diagram g): resume with the mode, then the plan prompt.
  s.cancelRetry();
  try {
    await s.lifecycle.run(async () => {
      assertEntryGate(s, 'decision.respond');
      const runtime = running(s);
      if (runtime === null) {
        await startRuntime(s, core, { byClientId: clientId, permissionMode: result.mode });
      } else {
        await controlCall(
          'setPermissionMode',
          () => runtime.agent.setPermissionMode(result.mode),
          core,
          s.id,
        );
        s.patch((e) => ({ ...e, permissionMode: result.mode }));
      }
      deliverPrompt(s, core, planPrompt(result.decision), 'next');
    });
  } catch (error) {
    s.broker.releaseExpired(cmd.decisionId);
    throw error;
  }
  const outcome = { type: 'plan_approved', mode: result.mode, edited: false, freshContext: false } as const;
  s.broker.resolveExpired(cmd.decisionId, outcome, clientId);
  return { outcome };
}

function planPrompt(decision: PlanDecision): string {
  return implementPlanPrompt(decision.planFilePath, decision.plan);
}

async function getContext(
  core: EngineCore,
  s: EntryState,
  detail: 'summary' | 'full',
): Promise<CommandResult<'session.getContext'>> {
  const runtime = running(s);
  if (runtime === null) throw commandError('SESSION_NOT_RUNNING', { entryId: s.id });
  let raw: unknown;
  try {
    raw = await runtime.agent.getContextUsage(detail);
  } catch (error) {
    core.log.warn({ err: error, entryId: s.id }, 'getContextUsage failed');
    throw commandError('CLAUDE_CONTROL_FAILED', { method: 'getContextUsage', detail });
  }
  const context = core.normalizer.normalizeContextUsage(
    raw,
    { contextWindow: runtime.launch.contextWindow },
    core.now(),
    detail,
  );
  if (context === null) throw commandError('CLAUDE_CONTROL_FAILED', { detail });
  if (detail === 'summary') s.setContext(gaugeOf(context));
  return { context };
}

async function refreshModels(
  core: EngineCore,
  s: EntryState,
): Promise<CommandResult<'session.refreshModels'>> {
  const runtime = running(s);
  // Dormant: the profile's last catalog, before any start the CLI aliases (WP22-01).
  if (runtime === null) return { models: catalogOrFallback(core.models(s.entry.profileId)).options };
  const raw = await controlCall('supportedModels', () => runtime.agent.supportedModels(), core, s.id);
  const catalog = toModelCatalog(raw);
  core.setModels(s.entry.profileId, catalog);
  s.emit([{ op: 'detail.patch', patch: { models: catalog.options } }]);
  return { models: catalog.options };
}
