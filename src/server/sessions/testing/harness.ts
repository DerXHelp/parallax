/**
 * Engine test harness (WP-13 §3.6, for 13b and WP-20): SessionManager + FakeBackend + memory
 * stores/publisher (hub-like validation) + the real WP-12 modules, with a virtual clock and
 * manual timers (no wall-clock dependence: zero delays fire on the next macrotask, longer ones only
 * on `timers.advance()`). Commands go through `commandSchema.parse` and their results through
 * `commandResultSchemas`, like the hub. `drive()` serves the FakeBackend's gates like the recorder
 * (prompts, interrupt, close, decisions via `answerFromFixture`). Only tests import this.
 */
import { randomUUID } from 'node:crypto';
import type { Logger } from 'pino';
import { z } from 'zod';
import type { ClientId, EntryId, PromptPriority } from '@shared/common';
import type { ErrorPayload } from '@shared/errors';
import type { Decision, DecisionResponse, Profile, SessionSummary } from '@shared/model';
import {
  commandResultSchemas,
  commandSchema,
  type Command,
  type CommandName,
  type CommandResult,
} from '@shared/protocol';
import { sampleId, SAMPLE_TIME } from '@shared/samples';
import { deriveDisplayStatus, type DisplayStatus, type StatusFacts } from '@shared/status';
import {
  createFakeBackend,
  type FakeBackend,
  type FakeBackendOptions,
  type FakeHistoryStore,
  type FakeSessionHandle,
} from '../../backend/fakeBackend';
import { createFakeClaudeIntegration, type FakeClaudeIntegration } from '../../backend/fake/integration';
import { recordedPrompts } from '../../backend/fake/testing';
import { fixtureDecisionPayloadSchema, type ParsedFixture } from '../../backend/fixture';
import { permissionUpdateSchema } from '../../backend/permissionRequest';
import type { MutableProfileStore } from '../../claude/profiles';
import { nextMacrotask } from '../../lib/async';
import { assertSafePath } from '../../lib/paths';
import type { ProcessFilter, ProcessInfo } from '../../lib/process';
import { CommandError, type ClientPresence, type HostCommandHandler } from '../../sync/ports';
import type { ConsoleLauncher } from '../../system/ports';
import { createMemoryCatalogStore, type MemoryCatalogStore } from '../catalogStore';
import { createMemoryCommandCatalogStore, type MemoryCommandCatalogStore } from '../commandCatalog';
import { NEVER_SLEEP, type ProcDeps, type SleepPolicy } from '../entryState';
import { createManualTimers, type ManualTimers } from '../lib/timers';
import {
  createSessionManager,
  type SessionManager,
  type SessionManagerDeps,
  type SessionManagerOptions,
} from '../manager';
import type { NativeToasts } from '../nativeToasts';
import { createMemoryProcessStore, type MemoryProcessStore, type ProcessRecordInput } from '../processStore';
import { createMemoryPublisher, type MemoryPublisher } from './memoryPublisher';
import { createMemoryStores, type MemoryStores, type MemoryStoresSeed } from './memoryStores';

export const HARNESS_CLIENT_ID: ClientId = sampleId('cl', 1);
/** Default cwd of harness entries (checkCwd is stubbed: only the path rules apply). */
export const HARNESS_CWD = 'D:\\work\\parallax-harness';
export const HARNESS_HOST = {
  serverVersion: '0.0.0-test',
  sdkVersion: '0.3.296',
  sdkClaudeCodeVersion: '2.1.296',
  platform: 'win32',
  dataDirLabel: 'test',
  dev: true,
} as const;

export interface HarnessStores extends MemoryStores {
  processes: MemoryProcessStore;
  catalogs: MemoryCatalogStore;
  commandCatalogs: MemoryCommandCatalogStore;
}

export interface HarnessProc extends ProcDeps {
  /** pids passed to killProcessTree. */
  readonly killed: number[];
  /** Live processes by pid: isProcessAlive and queryProcesses answer from it (absent = dead). */
  readonly info: Map<number, ProcessInfo>;
  /** Filters of every queryProcesses call (R2-02: one bundled call for all live records). */
  readonly queries: ProcessFilter[];
}

export interface EngineHarnessOptions {
  /** FakeBackend scenario per start (n = 0-based start counter). Default: the interactive scenario. */
  scenario?: FakeBackendOptions['scenario'];
  seed?: MemoryStoresSeed;
  /** Reuse stores (restart). */
  stores?: HarnessStores;
  processes?: readonly ProcessRecordInput[];
  /** Shared Claude history (resume, readHistory). */
  history?: FakeHistoryStore;
  allowsBypass?: boolean;
  profiles?: readonly Profile[];
  options?: Partial<SessionManagerOptions>;
  proc?: Partial<ProcDeps>;
  gitBranch?: (cwd: string, env: Record<string, string>) => Promise<string | null>;
  checkCwd?: (cwd: string) => Promise<void>;
  /**
   * Idle sleep: default NEVER (Phase-1 tests count exact timers); `'settings'` = the manager's real
   * policy from `settings.idleSleep` (ADR-105); or a test policy. Likewise `options.gitRefreshMs`
   * defaults to 0 here (the 60-s git refresh only where a test enables it).
   */
  sleepPolicy?: SleepPolicy | 'settings';
  /** Phase 2 (ADR-101). */
  hostCommands?: readonly HostCommandHandler[];
  onSettingsChanged?: SessionManagerDeps['onSettingsChanged'];
  extraWarnings?: SessionManagerDeps['extraWarnings'];
  /** HostState.port / systemIntegration (default: absent → null / false). */
  port?: () => number | null;
  systemIntegration?: boolean;
  /** Start of the virtual clock (default SAMPLE_TIME); `timers.advance(ms)` moves it. */
  clockStart?: string;
  /** Hub-like validation of everything published (default true). */
  validate?: boolean;
  presence?: readonly ClientPresence[];
  /** Native toasts (WP22-03); default off. */
  toasts?: NativeToasts;
  onShutdownRequested?: () => void;
  /** Call manager.start() (default true). */
  start?: boolean;
  /** Phase 2 (WP-34): the console of `session.openExternal` (default: none). */
  consoleLauncher?: ConsoleLauncher;
  /** Phase 2 (WP-34): `SystemIntegration.toastLaunchUri` (click target of native toasts). */
  toastLaunchUri?: (entryId: EntryId) => string | null;
  /** Phase 2 (WP-34): env (secrets) of every console spec of the fake integration. */
  consoleEnv?: Readonly<Record<string, string>>;
  /** Phase 2 (WP-34): profile store of the fake integration (wins over `profiles`). */
  profileStore?: MutableProfileStore;
  /** Engine logger (default: the root logger). */
  logger?: Logger;
}

export type CommandInput = z.input<typeof commandSchema>;
type ResultOf<C extends CommandInput> = C['name'] extends CommandName ? CommandResult<C['name']> : never;

export interface DriveOptions {
  /** Recorded prompts already sent (e.g. the first one with session.create). Default 1. */
  skipPrompts?: number;
  /** Intercepts the n-th recorded prompt (0-based); return true when it was handled. */
  onInput?: (index: number, text: string, priority: PromptPriority) => Promise<boolean> | boolean;
  answer?: FixtureAnswerer;
  /** Close the session at its exit gate (default true); false stops there. */
  close?: boolean;
  /** Stop as soon as this holds (checked whenever the backend rests). */
  until?: () => boolean;
  maxSteps?: number;
}

export interface EngineHarness {
  readonly manager: SessionManager;
  readonly backend: FakeBackend;
  readonly claude: FakeClaudeIntegration;
  readonly stores: HarnessStores;
  readonly publisher: MemoryPublisher;
  readonly timers: ManualTimers;
  readonly proc: HarnessProc;
  /** Unexpected engine errors (should stay empty). */
  readonly errors: { error: unknown; context: string }[];
  now(): Date;
  /** Runs a command like the hub (schema defaults, result check); throws CommandError. */
  cmd<C extends CommandInput>(cmd: C, clientId?: ClientId): Promise<ResultOf<C>>;
  /** The ErrorPayload of a command that must fail. */
  cmdError(cmd: CommandInput, clientId?: ClientId): Promise<ErrorPayload>;
  /** Creates an entry with a prompt (or without) and returns its id. */
  create(
    prompt?: string | null,
    extra?: Partial<Extract<CommandInput, { name: 'session.create' }>>,
  ): Promise<EntryId>;
  summary(entryId: EntryId): SessionSummary;
  facts(entryId: EntryId): StatusFacts;
  status(entryId: EntryId): DisplayStatus;
  /** Open + expired decisions of an entry (its view). */
  decisions(entryId: EntryId): Promise<Decision[]>;
  /** The latest FakeBackend session of an entry. */
  session(entryId: EntryId): FakeSessionHandle;
  sessions(entryId: EntryId): FakeSessionHandle[];
  waitFor(predicate: () => boolean, timeoutMs?: number): Promise<void>;
  /** Backend at rest + a few macrotasks (the engine handles every event synchronously). */
  settle(): Promise<void>;
  drive(entryId: EntryId, parsed: Pick<ParsedFixture, 'events'>, options?: DriveOptions): Promise<void>;
  /** A new manager (and backend, publisher) on the same stores and Claude history (§5.2 restart). */
  restart(options?: Partial<EngineHarnessOptions>): Promise<EngineHarness>;
  close(): Promise<void>;
}

function createHarnessProc(overrides: Partial<ProcDeps> = {}): HarnessProc {
  const killed: number[] = [];
  const info = new Map<number, ProcessInfo>();
  const queries: ProcessFilter[] = [];
  const queryProcesses = overrides.queryProcesses;
  return {
    killed,
    info,
    queries,
    isProcessAlive: overrides.isProcessAlive ?? ((pid) => info.has(pid)),
    queryProcesses: (filter) => {
      queries.push(filter);
      if (queryProcesses !== undefined) return queryProcesses(filter);
      const pids = new Set(filter.pids ?? []);
      const parents = new Set(filter.parentPids ?? []);
      const processes = [...info.values()].filter(
        (p) => pids.has(p.pid) || (p.parentPid !== null && parents.has(p.parentPid)),
      );
      return Promise.resolve({ kind: 'ok', processes });
    },
    listProcesses:
      overrides.listProcesses ?? (() => Promise.resolve({ kind: 'ok', processes: [...info.values()] })),
    killProcessTree:
      overrides.killProcessTree ??
      ((pid) => {
        killed.push(pid);
        return Promise.resolve();
      }),
  };
}

export async function createEngineHarness(options: EngineHarnessOptions = {}): Promise<EngineHarness> {
  const timers = createManualTimers();
  const clockStart = Date.parse(options.clockStart ?? SAMPLE_TIME);
  const now = (): Date => new Date(clockStart + timers.elapsed());
  const stores: HarnessStores = options.stores ?? {
    ...createMemoryStores(options.seed ?? {}, { now }),
    processes: createMemoryProcessStore(options.processes ?? []),
    catalogs: createMemoryCatalogStore(),
    commandCatalogs: createMemoryCommandCatalogStore(),
  };
  const sleepPolicy = options.sleepPolicy ?? NEVER_SLEEP;
  const publisher = createMemoryPublisher({ validate: options.validate ?? true });
  publisher.setPresence(options.presence ?? []);
  const backend = createFakeBackend({
    ...(options.scenario === undefined ? {} : { scenario: options.scenario }),
    ...(options.history === undefined ? {} : { history: options.history }),
    speed: 0,
    now,
  });
  const claude = createFakeClaudeIntegration({
    ...(options.profiles === undefined ? {} : { profiles: options.profiles }),
    ...(options.profileStore === undefined ? {} : { store: options.profileStore }),
    ...(options.allowsBypass === undefined ? {} : { allowsBypass: options.allowsBypass }),
    ...(options.consoleEnv === undefined ? {} : { consoleEnv: options.consoleEnv }),
    now,
  });
  const proc = createHarnessProc(options.proc);
  const errors: { error: unknown; context: string }[] = [];
  const manager = createSessionManager({
    backend,
    claude,
    stores,
    host: {
      ...HARNESS_HOST,
      ...(options.port === undefined ? {} : { port: options.port }),
      ...(options.systemIntegration === undefined ? {} : { systemIntegration: options.systemIntegration }),
    },
    ...(options.hostCommands === undefined ? {} : { hostCommands: options.hostCommands }),
    ...(options.onSettingsChanged === undefined ? {} : { onSettingsChanged: options.onSettingsChanged }),
    ...(options.extraWarnings === undefined ? {} : { extraWarnings: options.extraWarnings }),
    checkCwd:
      options.checkCwd ??
      ((cwd) => {
        assertSafePath(cwd);
        return Promise.resolve();
      }),
    proc,
    gitBranch: options.gitBranch ?? (() => Promise.resolve(null)),
    ...(sleepPolicy === 'settings' ? {} : { sleepPolicy }),
    ...(options.onShutdownRequested === undefined
      ? {}
      : { onShutdownRequested: options.onShutdownRequested }),
    ...(options.toasts === undefined ? {} : { toasts: options.toasts }),
    ...(options.consoleLauncher === undefined ? {} : { consoleLauncher: options.consoleLauncher }),
    ...(options.toastLaunchUri === undefined
      ? {}
      : { systemIntegration: { toastLaunchUri: options.toastLaunchUri } }),
    ...(options.logger === undefined ? {} : { logger: options.logger }),
    now,
    timers,
    onInternalError: (error, context) => {
      errors.push({ error, context });
    },
    // The heartbeat snapshot (WP22-06) and the git refresh (ADR-113) are off unless a test enables
    // them (their timers would show in `timers.pending()`).
    options: {
      contextRefreshDelayMs: 0,
      aiTitleDelayMs: 0,
      processSnapshotMs: 0,
      gitRefreshMs: 0,
      ...options.options,
    },
  });
  manager.attachPublisher(publisher);
  if (options.start !== false) await manager.start();

  const run = async (cmd: CommandInput, clientId: ClientId): Promise<unknown> => {
    const parsed: Command = commandSchema.parse(cmd);
    const result = await manager.handleCommand(parsed, { clientId, cmdId: randomUUID() });
    const schema: z.ZodType = commandResultSchemas[parsed.name];
    const checked = schema.safeParse(result);
    if (!checked.success) {
      throw new Error(`result of ${parsed.name} does not match its schema: ${checked.error.message}`);
    }
    return result;
  };

  const sessions = (entryId: EntryId): FakeSessionHandle[] =>
    backend.sessions.filter((s) => s.entryId === entryId);

  const harness: EngineHarness = {
    manager,
    backend,
    claude,
    stores,
    publisher,
    timers,
    proc,
    errors,
    now,

    async cmd<C extends CommandInput>(cmd: C, clientId: ClientId = HARNESS_CLIENT_ID): Promise<ResultOf<C>> {
      const result = await run(cmd, clientId);
      // The schema check above guarantees the shape; the generic result type mirrors it.
      return result as ResultOf<C>;
    },

    async cmdError(cmd, clientId = HARNESS_CLIENT_ID) {
      try {
        await run(cmd, clientId);
      } catch (error) {
        if (error instanceof CommandError) return error.error;
        throw error;
      }
      throw new Error(`command ${cmd.name} succeeded but was expected to fail`);
    },

    async create(prompt = 'Reply with exactly: OK', extra = {}) {
      const result = await run(
        {
          name: 'session.create',
          cwd: HARNESS_CWD,
          ...(prompt === null ? {} : { prompt: { text: prompt } }),
          ...extra,
        },
        HARNESS_CLIENT_ID,
      );
      const parsed = commandResultSchemas['session.create'].parse(result);
      return parsed.entryId;
    },

    summary(entryId) {
      const summary = manager.listSummaries().find((s) => s.entryId === entryId);
      if (summary === undefined) throw new Error(`no summary for ${entryId}`);
      return summary;
    },

    facts(entryId) {
      return harness.summary(entryId).status;
    },

    status(entryId) {
      return deriveDisplayStatus(harness.facts(entryId), now());
    },

    async decisions(entryId) {
      const view = await manager.loadView(entryId);
      return view?.decisions ?? [];
    },

    session(entryId) {
      const list = sessions(entryId);
      const last = list.at(-1);
      if (last === undefined) throw new Error(`no backend session for ${entryId}`);
      return last;
    },

    sessions,

    waitFor: (predicate, timeoutMs = 20_000) => publisher.waitFor(predicate, timeoutMs),

    async settle() {
      await backend.settle();
      for (let i = 0; i < 3; i += 1) await nextMacrotask();
    },

    async drive(entryId, parsed, o = {}) {
      const prompts = recordedPrompts(parsed.events, randomUUID).map((p) => ({
        text: p.content.map((c) => (c.type === 'text' ? c.text : '')).join(''),
        priority: p.priority,
      }));
      const answer = o.answer ?? answerFromFixture(parsed);
      let next = o.skipPrompts ?? 1;
      for (let step = 0; step < (o.maxSteps ?? 500); step += 1) {
        await harness.settle();
        if (o.until?.() === true) return;
        const handle = sessions(entryId).at(-1);
        if (handle === undefined) return;
        switch (handle.state) {
          case 'exited':
            return;
          case 'waiting-input': {
            const index = next;
            const prompt = prompts[index];
            if (prompt === undefined) return;
            next += 1;
            const handled = (await o.onInput?.(index, prompt.text, prompt.priority)) === true;
            if (!handled) {
              await run(
                {
                  name: 'session.sendPrompt',
                  entryId,
                  prompt: { text: prompt.text },
                  priority: prompt.priority,
                },
                HARNESS_CLIENT_ID,
              );
            }
            break;
          }
          case 'waiting-control':
            await run({ name: 'session.interrupt', entryId }, HARNESS_CLIENT_ID);
            break;
          case 'waiting-close':
            if (o.close === false) return;
            await run({ name: 'session.close', entryId }, HARNESS_CLIENT_ID);
            break;
          case 'waiting-decision': {
            const open = (await harness.decisions(entryId)).filter((d) => d.state === 'open');
            if (open.length === 0)
              throw new Error(`session ${entryId} waits for a decision the engine does not show`);
            for (const decision of open) {
              const response = answer(decision);
              if (response === null) throw new Error(`no recorded answer for ${decision.toolUseId}`);
              await run(
                { name: 'decision.respond', entryId, decisionId: decision.id, response },
                HARNESS_CLIENT_ID,
              );
            }
            break;
          }
          case 'running':
            break;
        }
      }
      throw new Error(`drive(${entryId}) did not finish`);
    },

    async restart(next = {}) {
      await manager.shutdown();
      return createEngineHarness({
        ...options,
        ...next,
        stores,
        history: backend.history,
      });
    },

    async close() {
      await manager.shutdown();
    },
  };
  return harness;
}

// =====================================================================================
// answerFromFixture: recorded PermissionResult → the user's intent (DecisionResponse)
// =====================================================================================

export type FixtureAnswerer = (decision: Decision) => DecisionResponse | null;

type RecordedResult = z.infer<typeof fixtureDecisionPayloadSchema>['result'];

const answersSchema = z.record(z.string(), z.string());
const annotationsSchema = z.record(z.string(), z.looseObject({ notes: z.string().optional() }));

/**
 * The intent a user would send to produce the recorded decision (WP-13 §3.6): permission allow →
 * `remember` = destination of the recorded rules/directories (if offered), `acceptEdits` = a
 * recorded setMode acceptEdits; deny → message + interrupt; question → labels/free text/notes;
 * plan → revise with the feedback or approve with the mode and the edited plan.
 */
export function answerFromFixture(parsed: Pick<ParsedFixture, 'events'>): FixtureAnswerer {
  const recorded = new Map<string, RecordedResult>();
  for (const event of parsed.events) {
    if (event.kind !== 'decision') continue;
    const decision = fixtureDecisionPayloadSchema.safeParse(event.payload);
    if (decision.success) recorded.set(decision.data.toolUseID, decision.data.result);
  }
  return (decision) => {
    const r = recorded.get(decision.toolUseId);
    return r === undefined ? null : intentOf(decision, r);
  };
}

function intentOf(decision: Decision, r: RecordedResult): DecisionResponse {
  const updates = (r.updatedPermissions ?? []).flatMap((u) => {
    const parsed = permissionUpdateSchema.safeParse(u);
    return parsed.success ? [parsed.data] : [];
  });
  const setMode = updates.find((u) => u.type === 'setMode');
  switch (decision.kind) {
    case 'permission': {
      if (r.behavior === 'deny') {
        return {
          kind: 'permission',
          response: { behavior: 'deny', message: r.message ?? '', interrupt: r.interrupt ?? false },
        };
      }
      const remembered = updates.find((u) => u.type === 'addRules' || u.type === 'addDirectories');
      const destination =
        remembered !== undefined && 'destination' in remembered ? remembered.destination : null;
      const remember = decision.offer.ruleDestinations.find((d) => d === destination) ?? null;
      const acceptEdits =
        decision.offer.acceptEdits &&
        setMode !== undefined &&
        'mode' in setMode &&
        setMode.mode === 'acceptEdits';
      return { kind: 'permission', response: { behavior: 'allow', remember, acceptEdits } };
    }
    case 'question': {
      if (r.behavior === 'deny')
        return { kind: 'question', response: { behavior: 'decline', message: r.message ?? '' } };
      const answers = answersSchema.safeParse(r.updatedInput?.answers);
      const annotations = annotationsSchema.safeParse(r.updatedInput?.annotations ?? {});
      const list = decision.questions.flatMap((q) => {
        const text = answers.success ? answers.data[q.question] : undefined;
        if (text === undefined) return [];
        const labels = new Set(q.options.map((o) => o.label));
        const parts = text.split(', ');
        const selected = parts.filter((p) => labels.has(p));
        const other = parts.filter((p) => !labels.has(p)).join(', ');
        const notes = annotations.success ? (annotations.data[q.question]?.notes ?? null) : null;
        return [{ question: q.question, selected, otherText: other === '' ? null : other, notes }];
      });
      return { kind: 'question', response: { behavior: 'answer', answers: list } };
    }
    case 'plan': {
      if (r.behavior === 'deny') {
        return {
          kind: 'plan',
          response: { behavior: 'revise', feedback: r.message ?? 'Please revise the plan.' },
        };
      }
      const mode = setMode !== undefined && 'mode' in setMode ? setMode.mode : 'default';
      const plan = r.updatedInput?.plan;
      const editedPlan = typeof plan === 'string' && plan !== decision.plan ? plan : null;
      return { kind: 'plan', response: { behavior: 'approve', mode, editedPlan } };
    }
  }
}
