/**
 * One live SDK session for the recorder: streaming-input query() against the installed `claude`
 * with Haiku, a permission policy behind canUseTool, a spawn wrapper (pid, stderr, exit) and a
 * close procedure that checks the process tree for orphans. Every observation goes to the
 * FixtureRecorder. Fatal guards (API key in use, auth/credit errors, budget) stop the session at once.
 */
import {
  query,
  type CanUseTool,
  type Options,
  type PermissionMode,
  type PermissionResult,
  type Query,
  type SDKMessage,
  type SDKResultMessage,
  type SDKSystemMessage,
  type SDKUserMessage,
  type SpawnedProcess,
  type SpawnOptions,
} from '@anthropic-ai/claude-agent-sdk';
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { performance } from 'node:perf_hooks';
import { setTimeout as sleep } from 'node:timers/promises';
import { assertSpawnableFile } from '../../src/server/lib/process';
import type { ModelUsageLite } from './context';
import { isAssistant, isInit, isResult, isState } from './messages';
import { killTree, listProcesses, processTree, survivors, type ProcInfo } from './processes';
import type { FixtureRecorder } from './writer';

export type Uuid = ReturnType<typeof randomUUID>;
type CanUseToolOptions = Parameters<CanUseTool>[2];
export type PolicyOptions = Omit<CanUseToolOptions, 'signal'>;
export type PermissionPolicy = (
  toolName: string,
  input: Record<string, unknown>,
  options: PolicyOptions,
) => PermissionResult | Promise<PermissionResult>;

/** Stops the whole recorder run (auth problem, API key in use, budget, rate limit rejected). */
export class FatalError extends Error {
  constructor(
    readonly kind: 'auth' | 'budget' | 'guard',
    message: string,
  ) {
    super(message);
    this.name = 'FatalError';
  }
}

export class WaitTimeoutError extends Error {
  constructor(label: string, timeoutMs: number) {
    super(`timeout after ${timeoutMs} ms waiting for ${label}`);
    this.name = 'WaitTimeoutError';
  }
}

const AUTH_ERRORS: ReadonlySet<string> = new Set([
  'authentication_failed',
  'oauth_org_not_allowed',
  'account_on_hold',
  'verification_required',
  'billing_error',
  'cloud_credential_error',
]);

export function describeError(error: unknown): { name: string; message: string } {
  if (error instanceof Error) return { name: error.name, message: error.message };
  return { name: 'unknown', message: String(error) };
}

// ---------------------------------------------------------------------------------------------
// Permission decisions (the PermissionResult shapes Parallax will send)

export function allowOnce(input: Record<string, unknown>): PermissionResult {
  return { behavior: 'allow', updatedInput: input, decisionClassification: 'user_temporary' };
}

export function allowAlways(input: Record<string, unknown>, options: PolicyOptions): PermissionResult {
  return {
    behavior: 'allow',
    updatedInput: input,
    updatedPermissions: options.suggestions ?? [],
    decisionClassification: 'user_permanent',
  };
}

export function deny(message: string, interrupt = false): PermissionResult {
  return {
    behavior: 'deny',
    message,
    ...(interrupt ? { interrupt: true } : {}),
    decisionClassification: 'user_reject',
  };
}

export const allowEverythingOnce: PermissionPolicy = (_toolName, input) => allowOnce(input);

// ---------------------------------------------------------------------------------------------

/** Streaming input: an AsyncIterable the SDK reads user messages from. */
class InputQueue implements AsyncIterable<SDKUserMessage> {
  private readonly items: SDKUserMessage[] = [];
  private readonly waiting: ((result: IteratorResult<SDKUserMessage, undefined>) => void)[] = [];
  private closed = false;

  push(message: SDKUserMessage): void {
    if (this.closed) throw new Error('input queue is closed');
    const waiter = this.waiting.shift();
    if (waiter) waiter({ value: message, done: false });
    else this.items.push(message);
  }

  close(): void {
    this.closed = true;
    for (const waiter of this.waiting.splice(0)) waiter({ value: undefined, done: true });
  }

  [Symbol.asyncIterator](): AsyncIterator<SDKUserMessage, undefined> {
    return {
      next: () => {
        const item = this.items.shift();
        if (item !== undefined) return Promise.resolve({ value: item, done: false });
        if (this.closed) return Promise.resolve({ value: undefined, done: true });
        return new Promise((resolve) => this.waiting.push(resolve));
      },
      return: () => {
        this.close();
        return Promise.resolve({ value: undefined, done: true });
      },
    };
  }
}

/** Cumulative cost/usage per query(); /clear resets the running total, so segments are summed. */
class UsageTracker {
  private committedCost = 0;
  private committedUsage: Record<string, ModelUsageLite> = {};
  private currentCost = 0;
  private currentUsage: Record<string, ModelUsageLite> = {};
  firstCost: number | undefined;
  results = 0;
  numTurns = 0;

  onResult(result: SDKResultMessage): void {
    this.results += 1;
    this.numTurns += result.num_turns;
    this.firstCost ??= result.total_cost_usd;
    if (result.total_cost_usd + 1e-9 < this.currentCost) {
      this.committedCost += this.currentCost;
      this.committedUsage = addUsage(this.committedUsage, this.currentUsage);
    }
    this.currentCost = result.total_cost_usd;
    const usage: Record<string, ModelUsageLite> = {};
    for (const [model, value] of Object.entries(result.modelUsage)) {
      usage[model] = {
        inputTokens: value.inputTokens,
        outputTokens: value.outputTokens,
        cacheReadInputTokens: value.cacheReadInputTokens,
        cacheCreationInputTokens: value.cacheCreationInputTokens,
        costUSD: value.costUSD,
      };
    }
    this.currentUsage = usage;
  }

  get costUsd(): number {
    return this.committedCost + this.currentCost;
  }

  get modelUsage(): Record<string, ModelUsageLite> {
    return addUsage(this.committedUsage, this.currentUsage);
  }
}

export function addUsage(
  a: Record<string, ModelUsageLite>,
  b: Record<string, ModelUsageLite>,
  sign = 1,
): Record<string, ModelUsageLite> {
  const out: Record<string, ModelUsageLite> = { ...a };
  for (const [model, usage] of Object.entries(b)) {
    const base = out[model] ?? {
      inputTokens: 0,
      outputTokens: 0,
      cacheReadInputTokens: 0,
      cacheCreationInputTokens: 0,
      costUSD: 0,
    };
    out[model] = {
      inputTokens: base.inputTokens + sign * usage.inputTokens,
      outputTokens: base.outputTokens + sign * usage.outputTokens,
      cacheReadInputTokens: base.cacheReadInputTokens + sign * usage.cacheReadInputTokens,
      cacheCreationInputTokens: base.cacheCreationInputTokens + sign * usage.cacheCreationInputTokens,
      costUSD: base.costUSD + sign * usage.costUSD,
    };
  }
  return out;
}

export interface SessionEnvironment {
  claudePath: string;
  env: Record<string, string>;
  envSummary: Record<string, unknown>;
  /** Called with this session's running cost; returns true when the global budget is exceeded. */
  onCost(sessionCostUsd: number): boolean;
}

export interface LiveSessionConfig {
  cwd: string;
  permissionMode?: PermissionMode;
  resume?: string;
  extraArgs?: Record<string, string | null>;
  promptSuggestions?: boolean;
  maxTurns?: number;
  policy?: PermissionPolicy;
  /** Additional env for this session only (set after the spike env). */
  env?: Record<string, string>;
}

export interface SendOptions {
  uuid?: Uuid;
  priority?: 'now' | 'next' | 'later';
}

export interface TurnOutcome {
  uuid: Uuid;
  result: SDKResultMessage;
  /** Index into `messages` where this turn started. */
  from: number;
}

export class LiveSession {
  readonly messages: SDKMessage[] = [];
  readonly sessionIds = new Set<string>();
  readonly permissionModes: string[] = [];
  readonly assistantMessageIds = new Set<string>();
  readonly usage = new UsageTracker();
  policy: PermissionPolicy;
  init: SDKSystemMessage | undefined;
  pid: number | undefined;
  exitMsSinceClose: number | null = null;
  orphans = 0;
  lastResult: SDKResultMessage | undefined;
  fatal: FatalError | undefined;

  private readonly input = new InputQueue();
  private readonly listeners = new Set<() => void>();
  private query: Query | undefined;
  private pumpDone: Promise<void> = Promise.resolve();
  private exited: Promise<void> | undefined;
  private closeAt: number | undefined;
  private ended = false;
  private closed = false;

  constructor(
    private readonly environment: SessionEnvironment,
    private readonly rec: FixtureRecorder,
    readonly config: LiveSessionConfig,
  ) {
    this.policy = config.policy ?? allowEverythingOnce;
  }

  get q(): Query {
    if (this.query === undefined) throw new Error('session not started');
    return this.query;
  }

  get sessionId(): string | undefined {
    return this.init?.session_id;
  }

  start(): void {
    const { config, environment } = this;
    const options: Options = {
      cwd: config.cwd,
      model: 'haiku',
      pathToClaudeCodeExecutable: environment.claudePath,
      env: { ...environment.env, ...config.env },
      settingSources: ['user', 'project', 'local'],
      systemPrompt: { type: 'preset', preset: 'claude_code' },
      includePartialMessages: true,
      thinking: { type: 'adaptive', display: 'summarized' },
      toolConfig: { askUserQuestion: { previewFormat: 'markdown' } },
      maxTurns: config.maxTurns ?? 10,
      canUseTool: this.canUseTool,
      stderr: (data) => {
        this.rec.record('stderr', { source: 'callback', data });
      },
      spawnClaudeCodeProcess: this.spawnProcess,
      ...(config.permissionMode === undefined ? {} : { permissionMode: config.permissionMode }),
      ...(config.resume === undefined ? {} : { resume: config.resume }),
      ...(config.extraArgs === undefined ? {} : { extraArgs: config.extraArgs }),
      ...(config.promptSuggestions === true ? { promptSuggestions: true } : {}),
    };

    this.rec.options = {
      cwd: config.cwd,
      model: 'haiku',
      pathToClaudeCodeExecutable: environment.claudePath,
      settingSources: options.settingSources,
      systemPrompt: options.systemPrompt,
      includePartialMessages: true,
      thinking: options.thinking,
      toolConfig: options.toolConfig,
      maxTurns: options.maxTurns,
      permissionMode: config.permissionMode ?? '(omitted)',
      resume: config.resume ?? null,
      extraArgs: config.extraArgs ?? null,
      promptSuggestions: config.promptSuggestions === true,
      canUseTool: 'recorder policy',
      spawnClaudeCodeProcess: 'recorder wrapper (pid, stderr pipe)',
      env: { ...environment.envSummary, sessionExtra: config.env ?? {} },
    };

    this.rec.mark('start');
    this.query = query({ prompt: this.input, options });
    this.pumpDone = this.pump(this.query);
  }

  // -------------------------------------------------------------------------------------------
  // SDK callbacks

  private readonly canUseTool: CanUseTool = async (toolName, input, options) => {
    const { signal, ...rest } = options;
    this.rec.record('canUseTool', { toolName, input, options: rest, signalAborted: signal.aborted });
    const onAbort = (): void => {
      this.rec.record('abort', { source: 'canUseTool.signal', toolName, toolUseID: rest.toolUseID });
    };
    signal.addEventListener('abort', onAbort, { once: true });
    try {
      const result = await this.policy(toolName, input, rest);
      this.rec.record('decision', { toolName, toolUseID: rest.toolUseID, result });
      return result;
    } catch (error) {
      this.rec.record('error', { where: 'policy', ...describeError(error) });
      const result = deny('Recorder policy failed.');
      this.rec.record('decision', { toolName, toolUseID: rest.toolUseID, result });
      return result;
    } finally {
      signal.removeEventListener('abort', onAbort);
    }
  };

  private readonly spawnProcess = (options: SpawnOptions): SpawnedProcess => {
    // R1-04: only an absolute .exe (pathToClaudeCodeExecutable), never a bare name searched in the cwd.
    assertSpawnableFile(options.command);
    const child = spawn(options.command, options.args, {
      cwd: options.cwd,
      env: options.env,
      signal: options.signal,
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true,
    });
    this.pid = child.pid;
    this.rec.record('spawn', {
      pid: child.pid ?? null,
      command: options.command,
      args: options.args,
      cwd: options.cwd ?? null,
    });
    // The SDK does not read stderr of a custom-spawned process; drain it here.
    child.stderr.setEncoding('utf8');
    child.stderr.on('data', (chunk: string) => {
      this.rec.record('stderr', { source: 'pipe', data: chunk });
    });
    this.exited = new Promise((resolve) => {
      child.once('exit', (code, signal) => {
        this.exitMsSinceClose =
          this.closeAt === undefined ? null : Math.round(performance.now() - this.closeAt);
        this.rec.record('exit', {
          pid: child.pid ?? null,
          code,
          signal,
          msSinceClose: this.exitMsSinceClose,
        });
        resolve();
      });
    });
    child.once('error', (error) => {
      this.rec.record('error', { where: 'spawn', ...describeError(error) });
    });
    return child;
  };

  private async pump(stream: Query): Promise<void> {
    try {
      for await (const message of stream) {
        this.rec.record('message', message);
        this.messages.push(message);
        this.inspect(message);
        this.notify();
      }
    } catch (error) {
      this.rec.record('error', { where: 'iterator', ...describeError(error) });
    } finally {
      this.ended = true;
      this.notify();
    }
  }

  private inspect(message: SDKMessage): void {
    if (typeof message.session_id === 'string' && message.session_id !== '') {
      this.sessionIds.add(message.session_id);
    }
    if (isInit(message)) {
      this.init = message;
      this.permissionModes.push(message.permissionMode);
      if (message.apiKeySource !== 'none') {
        this.fail(
          new FatalError('auth', `system/init.apiKeySource is "${message.apiKeySource}" (API key in use)`),
        );
      }
    } else if (
      message.type === 'system' &&
      message.subtype === 'status' &&
      message.permissionMode !== undefined
    ) {
      this.permissionModes.push(message.permissionMode);
    } else if (isAssistant(message)) {
      this.assistantMessageIds.add(message.message.id);
      if (message.error !== undefined && AUTH_ERRORS.has(message.error)) {
        this.fail(new FatalError('auth', `assistant.error = ${message.error}`));
      }
    } else if (message.type === 'rate_limit_event') {
      const info = message.rate_limit_info;
      if (info.errorCode === 'credits_required')
        this.fail(new FatalError('auth', 'rate_limit_event: credits_required'));
      else if (info.status === 'rejected') this.fail(new FatalError('guard', 'rate_limit_event: rejected'));
    } else if (isResult(message)) {
      this.lastResult = message;
      this.usage.onResult(message);
      if (message.subtype !== 'success' && message.startup_failure_reason !== undefined) {
        this.fail(new FatalError('auth', `startup_failure_reason = ${message.startup_failure_reason}`));
      }
      if (this.environment.onCost(this.usage.costUsd)) {
        this.fail(
          new FatalError(
            'budget',
            `budget of the spike exceeded (session ${this.usage.costUsd.toFixed(4)} USD)`,
          ),
        );
      }
    }
  }

  fail(error: FatalError): void {
    if (this.fatal !== undefined) return;
    this.fatal = error;
    this.rec.record('abort', { source: 'guard', kind: error.kind, reason: error.message });
    this.query?.close();
    this.notify();
  }

  private notify(): void {
    for (const listener of [...this.listeners]) listener();
  }

  // -------------------------------------------------------------------------------------------
  // Scenario API

  send(text: string, options: SendOptions = {}): Uuid {
    if (this.fatal !== undefined) throw this.fatal;
    const uuid = options.uuid ?? randomUUID();
    const message: SDKUserMessage = {
      type: 'user',
      message: { role: 'user', content: text },
      parent_tool_use_id: null,
      uuid,
      origin: { kind: 'human' },
      ...(options.priority === undefined ? {} : { priority: options.priority }),
    };
    this.rec.record('input', message);
    this.input.push(message);
    return uuid;
  }

  /** Resolves with the first message at index >= from matching `predicate`. */
  waitFor(
    predicate: (message: SDKMessage) => boolean,
    options: { label: string; from?: number; timeoutMs?: number },
  ): Promise<SDKMessage> {
    const timeoutMs = options.timeoutMs ?? 120_000;
    let index = options.from ?? 0;
    return new Promise((resolve, reject) => {
      const cleanup = (): void => {
        clearTimeout(timer);
        this.listeners.delete(check);
      };
      const check = (): void => {
        for (; index < this.messages.length; index += 1) {
          const message = this.messages[index];
          if (message !== undefined && predicate(message)) {
            cleanup();
            resolve(message);
            return;
          }
        }
        if (this.fatal !== undefined) {
          cleanup();
          reject(this.fatal);
        } else if (this.ended) {
          cleanup();
          reject(new Error(`stream ended while waiting for ${options.label}`));
        }
      };
      const timer = setTimeout(() => {
        cleanup();
        reject(new WaitTimeoutError(options.label, timeoutMs));
      }, timeoutMs);
      this.listeners.add(check);
      check();
    });
  }

  async waitForResult(from: number, label: string, timeoutMs = 180_000): Promise<SDKResultMessage> {
    const message = await this.waitFor(isResult, { from, label, timeoutMs });
    if (!isResult(message)) throw new Error('unreachable');
    return message;
  }

  /** Waits for session_state_changed:idle at index >= from; records a mark instead of failing. */
  async waitIdle(from: number, timeoutMs = 20_000): Promise<boolean> {
    try {
      await this.waitFor((message) => isState(message, 'idle'), { from, label: 'idle', timeoutMs });
      return true;
    } catch (error) {
      if (error instanceof FatalError) throw error;
      this.rec.mark('idle-not-seen', { from, error: describeError(error).message });
      return false;
    }
  }

  /** Sends one prompt and waits for its result and the following idle state. */
  async turn(
    text: string,
    options: SendOptions & { timeoutMs?: number; idleTimeoutMs?: number } = {},
  ): Promise<TurnOutcome> {
    const from = this.messages.length;
    const uuid = this.send(text, options);
    const result = await this.waitForResult(from, `result of "${text.slice(0, 40)}"`, options.timeoutMs);
    await this.waitIdle(from, options.idleTimeoutMs);
    return { uuid, result, from };
  }

  /** State-changing Query method, recorded as kind `control`. */
  async control<T>(method: string, args: unknown[], fn: (q: Query) => Promise<T>): Promise<T | undefined> {
    const started = performance.now();
    try {
      const result = await fn(this.q);
      this.rec.record('control', {
        method,
        args,
        result: (result as unknown) ?? null,
        ms: Math.round(performance.now() - started),
      });
      return result;
    } catch (error) {
      this.rec.record('control', {
        method,
        args,
        error: describeError(error),
        ms: Math.round(performance.now() - started),
      });
      return undefined;
    }
  }

  /** Read-only Query method, recorded as kind `call`. */
  async call<T>(fn: string, args: unknown[], body: (q: Query) => Promise<T>): Promise<T | undefined> {
    const started = performance.now();
    try {
      const result = await body(this.q);
      this.rec.record('call', {
        fn,
        args,
        result: (result as unknown) ?? null,
        ms: Math.round(performance.now() - started),
      });
      return result;
    } catch (error) {
      this.rec.record('call', {
        fn,
        args,
        error: describeError(error),
        ms: Math.round(performance.now() - started),
      });
      return undefined;
    }
  }

  /**
   * Ends the session. `close` calls Query.close() (Parallax "Server beenden"), `eof` only ends the
   * streaming input (graceful). Records the process tree before, the exit and any survivors, and
   * kills survivors with taskkill /T /F.
   */
  async close(mode: 'close' | 'eof' = 'close'): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    const rootPid = this.pid;
    let before: ProcInfo[] = [];
    if (rootPid !== undefined) {
      try {
        before = processTree(await listProcesses(), rootPid);
      } catch (error) {
        this.rec.record('error', { where: 'process-snapshot', ...describeError(error) });
      }
    }
    this.rec.record('process', {
      phase: 'before-close',
      mode,
      rootPid: rootPid ?? null,
      processes: before.map((proc) => ({ pid: proc.pid, ppid: proc.ppid, name: proc.name })),
    });

    this.closeAt = performance.now();
    this.rec.mark(`close:${mode}`);
    if (mode === 'eof') {
      this.input.close();
    } else {
      this.query?.close();
      this.input.close();
    }

    const waitExit = async (ms: number): Promise<boolean> =>
      this.exited === undefined
        ? true
        : Promise.race([this.exited.then(() => true), sleep(ms).then(() => false)]);
    let exited = await waitExit(mode === 'eof' ? 20_000 : 10_000);
    if (!exited && mode === 'eof') {
      this.rec.mark('eof-timeout-fallback-close');
      this.query?.close();
      exited = await waitExit(10_000);
    }
    if (!exited) this.rec.mark('exit-not-seen');

    await sleep(3_000);
    if (rootPid !== undefined && before.length > 0) {
      try {
        const alive = survivors(before, await listProcesses());
        this.orphans = alive.length;
        this.rec.record('process', {
          phase: 'after-close',
          rootPid,
          survivors: alive.map((proc) => ({ pid: proc.pid, ppid: proc.ppid, name: proc.name })),
        });
        if (alive.length > 0) {
          const killed: { pid: number; name: string; output: string }[] = [];
          for (const proc of alive)
            killed.push({ pid: proc.pid, name: proc.name, output: await killTree(proc.pid) });
          this.rec.record('process', { phase: 'cleanup', killed });
        }
      } catch (error) {
        this.rec.record('error', { where: 'process-check', ...describeError(error) });
      }
    }
    await Promise.race([this.pumpDone, sleep(5_000)]);
  }
}
