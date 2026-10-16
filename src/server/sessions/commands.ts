/**
 * Phase-1 commands of the engine (WP-13 §3.5.6; WP-02 §7.5, vorrangig architecture §5.2). General
 * rules: shutdown running → SERVER_SHUTTING_DOWN; unknown entry → ENTRY_NOT_FOUND; runState
 * `external` → SESSION_EXTERNAL (Phase 2+); unexpected errors → logged, INTERNAL_ERROR. Results
 * match `commandResultSchemas` (the hub checks them again).
 */
import type { ClientId, ProfileId } from '@shared/common';
import { makeError } from '@shared/errors';
import { currentSessionId, type Entry, type PlanDecision } from '@shared/model';
import {
  isHostCommand,
  type Command,
  type CommandOf,
  type CommandResult,
  type HostCommandName,
} from '@shared/protocol';
import { CommandError, type CommandContext } from '../sync/ports';
import { commandError, gaugeOf, type EngineCore, type EntryState } from './entryState';
import { catalogOrFallback, toModelCatalog } from './models';
import { closeRuntime, deliverPrompt, startRuntime } from './runtime';
import { capTitle, implementPlanPrompt, newConversation, titleFromPrompt } from './summary';

export interface CommandEngine {
  readonly core: EngineCore;
  state(entryId: string): EntryState | undefined;
  /** Registers a new entry (registry + summary) and returns its state. */
  createEntry(entry: Entry, promptTitle: string | null): EntryState;
  /** Entries with a process (counted BEFORE closing, R0-19). */
  runningCount(): number;
  /** server.shutdown: flag + `setImmediate(onShutdownRequested)` after the ack. */
  requestShutdown(): void;
}

type EntryCommand = Exclude<
  Command,
  { name: 'session.create' | 'settings.update' | 'server.shutdown' | HostCommandName }
>;

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
        const settings = engine.core.stores.settings.update(cmd.patch);
        engine.core.publishHostState();
        return { settings } satisfies CommandResult<'settings.update'>;
      }
      case 'server.shutdown': {
        const sessionsStopped = engine.runningCount();
        engine.requestShutdown();
        return { sessionsStopped } satisfies CommandResult<'server.shutdown'>;
      }
      default:
        // Phase 2 (ADR-101): host commands go to HostCommandHandlers – routing follows in WP-31.
        if (isHostCommand(cmd)) throw notImplemented(cmd.name);
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
  if (cmd.prompt !== undefined && cmd.prompt.attachments.length > 0) throw notImplemented('attachments');
  core.assertRunning();

  const now = core.now().toISOString();
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
  };
  const s = engine.createEntry(entry, promptTitle);
  const prompt = cmd.prompt;
  if (prompt === undefined) return { entryId: entry.id, messageUuid: null };
  try {
    const messageUuid = await s.lifecycle.run(async () => {
      await startRuntime(s, core, { byClientId: clientId });
      return deliverPrompt(s, core, prompt.text, 'next');
    });
    return { entryId: entry.id, messageUuid };
  } catch (error) {
    if (error instanceof CommandError && error.error.code === 'SERVER_SHUTTING_DOWN') throw error;
    // The entry exists; the start failure shows as status `error` in its summary.
    core.log.warn({ err: error, entryId: entry.id }, 'session.create: start failed');
    return { entryId: entry.id, messageUuid: null };
  }
}

// ---- commands of one entry ----

async function entryCommand(engine: CommandEngine, cmd: EntryCommand, clientId: ClientId): Promise<unknown> {
  const s = engine.state(cmd.entryId);
  if (s === undefined) throw commandError('ENTRY_NOT_FOUND', { entryId: cmd.entryId });
  if (s.facts.runState === 'external' && cmd.name !== 'transcript.loadEarlier') {
    throw commandError('SESSION_EXTERNAL', { entryId: s.id });
  }
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
    case 'session.setFastMode':
    case 'session.setPinned':
    case 'session.setArchived':
      throw notImplemented(cmd.name);
    case 'session.rename':
      return rename(core, s, cmd.title);
    case 'session.close':
      s.cancelRetry();
      await s.lifecycle.run(() => closeRuntime(s, core, 'user'));
      return {} satisfies CommandResult<'session.close'>;
    case 'session.resume':
      s.cancelRetry();
      await s.lifecycle.run(async () => {
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
    // Phase 2 (WP-30 §4.12): implemented by WP-31 (switchConversation) and WP-34 (the others).
    case 'session.switchConversation':
    case 'session.openExternal':
    case 'session.reclaim':
    case 'session.consoleCommand':
    case 'session.continueAfterLimit':
      throw notImplemented(cmd.name);
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
  if (cmd.prompt.attachments.length > 0) throw notImplemented('attachments');
  s.cancelRetry();
  const text = cmd.prompt.text;
  if (s.entry.titleSource === 'none') {
    const title = titleFromPrompt(text);
    if (title !== null) {
      s.promptTitle = title;
      s.patch((e) => ({ ...e, title, titleSource: 'prompt' }));
    }
  }
  const messageUuid = await s.lifecycle.run(async () => {
    if (s.runtime === null) await startRuntime(s, core, { byClientId: clientId });
    return deliverPrompt(s, core, text, cmd.priority);
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
    if (sessionId === null) return;
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

/** Running: the CLI renames itself through its `/rename` command (F.8); the echo is recognized. */
function renameRunning(core: EngineCore, s: EntryState, title: string): void {
  s.pendingRename = title;
  try {
    deliverPrompt(s, core, `/rename ${title}`, 'next');
  } catch (error) {
    core.log.warn({ err: error, entryId: s.id }, '/rename prompt could not be sent – the local title stays');
  }
}

async function respond(
  core: EngineCore,
  s: EntryState,
  cmd: CommandOf<'decision.respond'>,
  clientId: ClientId,
): Promise<CommandResult<'decision.respond'>> {
  const response = cmd.response;
  if (response.kind === 'plan' && response.response.behavior !== 'revise') {
    assertModeAllowed(core, s.entry.profileId, response.response.mode);
  }
  const result = s.broker.respond(cmd.decisionId, response, clientId);
  if (result.kind === 'resolved') return { outcome: result.outcome };

  // "Fortsetzen & Plan freigeben" (A.10, diagram g): resume with the mode, then the plan prompt.
  s.cancelRetry();
  try {
    await s.lifecycle.run(async () => {
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
  const outcome = { type: 'plan_approved', mode: result.mode, edited: false } as const;
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
