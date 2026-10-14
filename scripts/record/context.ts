/**
 * Run context of the recorder: scratch folders, CLI/SDK versions, auth status, sanitizer secrets,
 * persistent spike state (.recordings/spike-state.json, git-ignored) and the budget guard.
 */
import { execFile } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';
import { buildSpikeEnv, type SpikeEnvResult } from './env';
import { createSanitizer, type SanitizeSecrets, type Sanitizer } from './sanitize';

export const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
export const FIXTURES_DIR = path.join(REPO_ROOT, 'test', 'fixtures', 'sdk');
export const RECORDINGS_ROOT = path.join(REPO_ROOT, '.recordings');
export const STATE_FILE = path.join(RECORDINGS_ROOT, 'spike-state.json');

/** Hard budget for all live spike runs together (estimated USD from result.total_cost_usd). */
export const BUDGET_USD = 2;

const modelUsageSchema = z.object({
  inputTokens: z.number(),
  outputTokens: z.number(),
  cacheReadInputTokens: z.number(),
  cacheCreationInputTokens: z.number(),
  costUSD: z.number(),
});
export type ModelUsageLite = z.infer<typeof modelUsageSchema>;

const sessionRecordSchema = z.object({
  scenario: z.string(),
  stamp: z.string(),
  cwd: z.string(),
  sessionIds: z.array(z.string()),
  startedAt: z.string(),
  costUsd: z.number(),
  rawCostUsd: z.number(),
  modelUsage: z.record(z.string(), modelUsageSchema),
  results: z.number(),
  numTurns: z.number(),
  assistantMessageIds: z.number(),
  pid: z.number().nullable(),
  exitMsSinceClose: z.number().nullable(),
  orphans: z.number(),
  permissionModes: z.array(z.string()),
  ok: z.boolean(),
  error: z.string().optional(),
});
export type SessionRecord = z.infer<typeof sessionRecordSchema>;

const stateSchema = z.object({
  version: z.literal(1),
  blocked: z.object({ reason: z.string(), at: z.string() }).optional(),
  authProbeOk: z.boolean().default(false),
  sessions: z.array(sessionRecordSchema).default([]),
});
export type SpikeState = z.infer<typeof stateSchema>;

const authStatusSchema = z.looseObject({
  loggedIn: z.boolean(),
  authMethod: z.string().optional(),
  apiProvider: z.string().optional(),
  email: z.string().optional(),
  orgId: z.string().optional(),
  orgName: z.string().optional(),
  subscriptionType: z.string().optional(),
  configDirectory: z.string().optional(),
  projectsDirectory: z.string().optional(),
});
export type AuthStatus = z.infer<typeof authStatusSchema>;

function run(file: string, args: readonly string[], env: NodeJS.ProcessEnv): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(file, args, { windowsHide: true, timeout: 60_000, env, encoding: 'utf8' }, (error, stdout) => {
      if (error) reject(new Error(error.message, { cause: error }));
      else resolve(stdout);
    });
  });
}

export function loadState(): SpikeState {
  if (!existsSync(STATE_FILE)) return { version: 1, authProbeOk: false, sessions: [] };
  return stateSchema.parse(JSON.parse(readFileSync(STATE_FILE, 'utf8')) as unknown);
}

export function saveState(state: SpikeState): void {
  mkdirSync(RECORDINGS_ROOT, { recursive: true });
  writeFileSync(STATE_FILE, `${JSON.stringify(state, null, 2)}\n`);
}

function timestamp(date: Date): string {
  const pad = (value: number): string => String(value).padStart(2, '0');
  return (
    `${date.getFullYear()}${pad(date.getMonth() + 1)}${pad(date.getDate())}-` +
    `${pad(date.getHours())}${pad(date.getMinutes())}${pad(date.getSeconds())}`
  );
}

export interface RunContext {
  stamp: string;
  scratchRoot: string;
  workDir: string;
  parallaxHome: string;
  recordingsDir: string;
  claudePath: string;
  cliVersion: string;
  sdkVersion: string;
  authStatus: AuthStatus;
  envInfo: SpikeEnvResult;
  secrets: SanitizeSecrets;
  state: SpikeState;
  budgetUsd: number;
  /** Fresh sanitizer per fixture (learned secrets do not leak between fixtures). */
  sanitizer(): Sanitizer;
  /** Creates `<work>\<name>`; with lowerDrive the cwd string starts with a lower-case drive letter. */
  scenarioCwd(name: string, options?: { lowerDrive?: boolean }): string;
  /** Spent USD of all finished sessions in the state file. */
  spentUsd(): number;
  save(): void;
}

export function claudeExecutable(): string {
  return process.env.PARALLAX_CLAUDE ?? path.join(os.homedir(), '.local', 'bin', 'claude.exe');
}

/** `claude auth status --json` with the spike env (never interactive). */
export async function readAuthStatus(claudePath: string, env: NodeJS.ProcessEnv): Promise<AuthStatus> {
  const stdout = await run(claudePath, ['auth', 'status', '--json'], env);
  return authStatusSchema.parse(JSON.parse(stdout) as unknown);
}

export async function readCliVersion(claudePath: string, env: NodeJS.ProcessEnv): Promise<string> {
  const stdout = await run(claudePath, ['--version'], env);
  return /^(\S+)/.exec(stdout.trim())?.[1] ?? stdout.trim();
}

export function readSdkVersion(): string {
  const pkgPath = path.join(REPO_ROOT, 'node_modules', '@anthropic-ai', 'claude-agent-sdk', 'package.json');
  const pkg = z.object({ version: z.string() }).parse(JSON.parse(readFileSync(pkgPath, 'utf8')) as unknown);
  return pkg.version;
}

/** Machine and account values the sanitizer must replace. */
export function secretsFor(authStatus: AuthStatus): SanitizeSecrets {
  return {
    home: os.homedir(),
    tmpDir: os.tmpdir(),
    username: os.userInfo().username,
    hostname: os.hostname(),
    emails: authStatus.email === undefined ? [] : [authStatus.email],
    orgNames: authStatus.orgName === undefined ? [] : [authStatus.orgName],
    ids: authStatus.orgId === undefined ? [] : [authStatus.orgId],
  };
}

export async function createRunContext(): Promise<RunContext> {
  const stamp = timestamp(new Date());
  const scratchRoot = path.join(os.tmpdir(), `parallax-spike-${stamp}`);
  const workDir = path.join(scratchRoot, 'work');
  const parallaxHome = path.join(scratchRoot, 'home');
  mkdirSync(workDir, { recursive: true });
  mkdirSync(parallaxHome, { recursive: true });
  process.env.PARALLAX_HOME = parallaxHome;

  const claudePath = claudeExecutable();
  if (!existsSync(claudePath)) throw new Error(`claude executable not found: ${claudePath}`);

  const envInfo = buildSpikeEnv(process.env, { extra: { PARALLAX_HOME: parallaxHome } });
  const [cliVersion, authStatus] = await Promise.all([
    readCliVersion(claudePath, envInfo.env),
    readAuthStatus(claudePath, envInfo.env),
  ]);

  const secrets = secretsFor(authStatus);
  const state = loadState();
  return {
    stamp,
    scratchRoot,
    workDir,
    parallaxHome,
    recordingsDir: path.join(RECORDINGS_ROOT, stamp),
    claudePath,
    cliVersion,
    sdkVersion: readSdkVersion(),
    authStatus,
    envInfo,
    secrets,
    state,
    budgetUsd: BUDGET_USD,
    sanitizer: () => createSanitizer(secrets),
    scenarioCwd(name, options = {}) {
      const dir = path.join(workDir, name);
      mkdirSync(dir, { recursive: true });
      if (options.lowerDrive === true && /^[A-Za-z]:/.test(dir)) {
        return `${dir.charAt(0).toLowerCase()}${dir.slice(1)}`;
      }
      return dir;
    },
    spentUsd() {
      return state.sessions.reduce((sum, session) => sum + session.costUsd, 0);
    },
    save() {
      saveState(state);
    },
  };
}
