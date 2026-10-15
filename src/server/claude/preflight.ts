/**
 * Checks of `pnpm preflight` (Plan "Paketmanager: pnpm 12", "Claude-Profile"): Node version,
 * pnpm version, registry, every profile's `claude` (path, version, C.7 rule) and login, Microsoft
 * Edge. Pure formatting/rating functions plus `runPreflight` with injectable seams. Output is
 * English (Plan: preflight and logs stay English). Never prints e-mail/org (parseAuthStatus).
 */
import path from 'node:path';
import type { ClaudeInstallStatus, Profile } from '@shared/model';
import { windowsPathIssue } from '@shared/paths';
import { errnoCode, runFile, systemTool } from '../lib/process';
import { getEnvVar } from './env';
import type { ClaudeIntegrationImpl } from './integration';
import {
  compareVersions,
  nodeFsDeps,
  resolveCmdShim,
  searchPath,
  type ClaudeFsDeps,
  type RunFileFn,
} from './resolveClaude';

export type PreflightLevel = 'ok' | 'info' | 'warn' | 'fail';

export interface PreflightCheck {
  id: string;
  title: string;
  level: PreflightLevel;
  detail: string;
  /** What to do about a warning/failure. */
  hint?: string;
}

export const NODE_MIN_MAJOR = 22;
export const NODE_STANDARD_MAJOR = 26;
/** engines.pnpm in package.json. */
export const PNPM_MIN_VERSION = '12.8.0';

// ---- rating (pure) ----

export function checkNode(version: string): PreflightCheck {
  const major = Number.parseInt(version.replace(/^v/, '').split('.')[0] ?? '', 10);
  const base = { id: 'node', title: 'node', detail: version.startsWith('v') ? version : `v${version}` };
  if (!Number.isFinite(major) || major < NODE_MIN_MAJOR) {
    return {
      ...base,
      level: 'fail',
      hint: `Node ${NODE_MIN_MAJOR} or newer is required (standard: ${NODE_STANDARD_MAJOR}).`,
    };
  }
  if (major !== NODE_STANDARD_MAJOR) {
    return {
      ...base,
      level: 'warn',
      hint: `Node ${NODE_STANDARD_MAJOR} is the standard version of this project.`,
    };
  }
  return { ...base, level: 'ok' };
}

export function checkPnpm(version: string | null): PreflightCheck {
  const base = { id: 'pnpm', title: 'pnpm' };
  if (version === null) {
    return { ...base, level: 'warn', detail: 'version unknown', hint: 'Run preflight via `pnpm preflight`.' };
  }
  const order = compareVersions(version, PNPM_MIN_VERSION);
  if (order === null) return { ...base, level: 'warn', detail: version };
  if (order < 0) {
    return {
      ...base,
      level: 'fail',
      detail: version,
      hint: `pnpm ${PNPM_MIN_VERSION} or newer is required.`,
    };
  }
  return { ...base, level: 'ok', detail: version };
}

/** Registry URL without user info, query or fragment (no credentials in the output). */
export function redactRegistry(registry: string): string {
  try {
    const url = new URL(registry);
    url.username = '';
    url.password = '';
    url.search = '';
    url.hash = '';
    return url.toString();
  } catch {
    return registry.replace(/\/\/[^/@]*@/, '//');
  }
}

export function checkRegistry(registry: string | null): PreflightCheck {
  if (registry === null) {
    return {
      id: 'registry',
      title: 'registry',
      level: 'warn',
      detail: 'unknown',
      hint: '`pnpm config get registry` failed.',
    };
  }
  return { id: 'registry', title: 'registry', level: 'info', detail: redactRegistry(registry) };
}

export function checkSdk(sdkVersion: string | null, claudeCodeVersion: string | null): PreflightCheck {
  if (sdkVersion === null) {
    return {
      id: 'sdk',
      title: 'agent sdk',
      level: 'fail',
      detail: 'not installed',
      hint: 'Run `pnpm install --frozen-lockfile`.',
    };
  }
  return {
    id: 'sdk',
    title: 'agent sdk',
    level: 'info',
    detail: `@anthropic-ai/claude-agent-sdk ${sdkVersion} (expects claude >= ${claudeCodeVersion ?? '?'})`,
  };
}

/** Path/version and login checks of one profile from its checkProfile() result. */
export function checkProfileStatus(
  profile: Pick<Profile, 'id' | 'name'>,
  status: ClaudeInstallStatus,
  requiredVersion: string | null,
): PreflightCheck[] {
  const label = `profile "${profile.name}"`;
  const claude: PreflightCheck = { id: `claude:${profile.id}`, title: 'claude', level: 'ok', detail: '' };
  const login: PreflightCheck = { id: `login:${profile.id}`, title: 'login', level: 'ok', detail: '' };

  if (status.state === 'not_found') {
    claude.level = 'fail';
    claude.detail = `not found (${label})`;
    claude.hint = 'Install Claude Code (claude.exe on the PATH) or set a fixed path in the profile.';
    return [claude];
  }
  if (status.path === null) {
    claude.level = 'fail';
    claude.detail = `${status.error?.code ?? 'error'} (${label})`;
    return [claude];
  }
  const version = status.version ?? 'unknown version';
  claude.detail = `${status.path}, ${version} (${label})`;
  if (status.state === 'error') {
    claude.level = 'fail';
    claude.hint = `\`claude --version\` failed: ${status.error?.code ?? 'error'} ${JSON.stringify(status.error?.params ?? {})}`;
    return [claude];
  }
  if (status.versionStatus === 'too_old') {
    claude.level = 'fail';
    claude.hint = `claude ${version} is older than ${requiredVersion ?? '?'} expected by the SDK – update Claude Code.`;
  } else if (status.versionStatus === 'unknown') {
    claude.level = 'warn';
    claude.hint = 'The version could not be compared with the SDK requirement.';
  }

  const auth = status.auth;
  if (auth.state === 'logged_in') {
    const parts = [
      auth.method,
      auth.apiProvider,
      auth.subscriptionType === null ? null : `subscription ${auth.subscriptionType}`,
    ];
    login.detail = `logged in (${parts.filter((part) => part !== null).join(', ')})`;
  } else if (auth.state === 'logged_out') {
    login.level = 'fail';
    login.detail = `not logged in (${label})`;
    login.hint = 'Run `claude` in a terminal and log in (/login).';
  } else {
    login.level = 'fail';
    login.detail = `unknown (${status.error?.code ?? 'error'})`;
    login.hint = '`claude auth status --json` could not be read.';
  }
  return [claude, login];
}

export function checkEdge(edgePath: string | null): PreflightCheck {
  if (edgePath === null) {
    return {
      id: 'edge',
      title: 'edge',
      level: 'fail',
      detail: 'not found',
      hint: 'Parallax opens its window with Microsoft Edge (App Paths or Program Files).',
    };
  }
  return { id: 'edge', title: 'edge', level: 'ok', detail: edgePath };
}

/** 0 = no failure (warnings allowed), 1 = at least one failure. */
export function preflightExitCode(checks: readonly PreflightCheck[]): number {
  return checks.some((check) => check.level === 'fail') ? 1 : 0;
}

export function formatPreflight(checks: readonly PreflightCheck[]): string {
  const width = Math.max(...checks.map((check) => check.title.length), 6);
  const lines = ['Parallax preflight'];
  for (const check of checks) {
    lines.push(`  ${check.level.toUpperCase().padEnd(5)} ${check.title.padEnd(width)}  ${check.detail}`);
    if (check.hint !== undefined) lines.push(`  ${' '.repeat(5)} ${' '.repeat(width)}  -> ${check.hint}`);
  }
  const failures = checks.filter((check) => check.level === 'fail').length;
  const warnings = checks.filter((check) => check.level === 'warn').length;
  const plural = (n: number, word: string): string => `${n} ${word}${n === 1 ? '' : 's'}`;
  lines.push(
    `Result: ${failures === 0 ? 'OK' : 'FAILED'} (${plural(failures, 'failure')}, ${plural(warnings, 'warning')})`,
  );
  return `${lines.join('\n')}\n`;
}

// ---- pnpm ----

export interface PnpmCommand {
  file: string;
  /** Arguments before the pnpm arguments (the script when pnpm is a JS file run by node). */
  prefix: string[];
}

/** pnpm that runs this script (`npm_execpath`), else `where pnpm` (.exe or npm shim → .exe). */
export async function findPnpm(
  env: Readonly<Record<string, string | undefined>>,
  fs: ClaudeFsDeps,
  nodeExecutable: string,
): Promise<PnpmCommand | null> {
  const execPath = getEnvVar(env, 'npm_execpath');
  if (execPath !== undefined && windowsPathIssue(execPath) === null && (await fs.isFile(execPath))) {
    const ext = path.win32.extname(execPath).toLowerCase();
    if (ext === '.exe') return { file: execPath, prefix: [] };
    if (['.js', '.cjs', '.mjs'].includes(ext)) return { file: nodeExecutable, prefix: [execPath] };
  }
  const hits = await searchPath('pnpm', env, fs);
  const exe = hits.find((hit) => path.win32.extname(hit).toLowerCase() === '.exe');
  if (exe !== undefined) return { file: exe, prefix: [] };
  for (const hit of hits) {
    const ext = path.win32.extname(hit).toLowerCase();
    if (ext !== '.cmd' && ext !== '.ps1') continue;
    const target = await resolveCmdShim(hit, fs, 'pnpm.exe');
    if (target !== null) return { file: target, prefix: [] };
  }
  return null;
}

/** `pnpm/<version>` from npm_config_user_agent. */
export function pnpmVersionFromUserAgent(userAgent: string | undefined): string | null {
  return /(?:^|\s)pnpm\/(\S+)/.exec(userAgent ?? '')?.[1] ?? null;
}

async function runText(
  run: RunFileFn,
  file: string,
  args: readonly string[],
  cwd: string,
): Promise<string | null> {
  try {
    const result = await run(file, args, { cwd, timeoutMs: 30_000, maxOutputBytes: 64 * 1024 });
    if (result.exitCode !== 0 || result.timedOut) return null;
    const text = result.stdout.trim().split(/\r?\n/)[0]?.trim() ?? '';
    return text === '' || text === 'undefined' ? null : text;
  } catch {
    return null;
  }
}

// ---- Edge ----

export type RegQuery = (key: string, view: 64 | 32) => Promise<string | null>;

/** Default value of a `reg query <key> /ve` output (REG_SZ or REG_EXPAND_SZ, language-independent). */
export function parseRegDefaultValue(
  output: string,
  env: Readonly<Record<string, string | undefined>>,
): string | null {
  for (const line of output.split(/\r?\n/)) {
    const match = /\s(REG_SZ|REG_EXPAND_SZ)\s+(.+?)\s*$/.exec(line);
    if (match === null) continue;
    let value = (match[2] ?? '').replace(/^"(.*)"$/, '$1');
    if (match[1] === 'REG_EXPAND_SZ') {
      value = value.replace(/%([^%]+)%/g, (whole, name: string) => getEnvVar(env, name) ?? whole);
    }
    return value === '' ? null : value;
  }
  return null;
}

/** `reg.exe query <key> /ve /reg:<view>` (System32, no shell); null if the key does not exist. */
export function regQuery(run: RunFileFn = runFile): RegQuery {
  return async (key, view) => {
    try {
      const result = await run(systemTool('reg.exe'), ['query', key, '/ve', `/reg:${view}`], {
        timeoutMs: 10_000,
        maxOutputBytes: 64 * 1024,
      });
      return result.exitCode === 0 ? result.stdout : null;
    } catch {
      return null;
    }
  };
}

const EDGE_APP_PATH = 'SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\App Paths\\msedge.exe';

/**
 * msedge.exe via App Paths (HKCU, HKLM 64/32 bit) or the usual install folders (C.9: `msedge`
 * is not on the PATH). Null if none exists.
 */
export async function findEdge(deps: {
  regQuery: RegQuery;
  fs: ClaudeFsDeps;
  env: Readonly<Record<string, string | undefined>>;
}): Promise<string | null> {
  const fromRegistry: string[] = [];
  for (const [key, view] of [
    [`HKCU\\${EDGE_APP_PATH}`, 64],
    [`HKLM\\${EDGE_APP_PATH}`, 64],
    [`HKLM\\${EDGE_APP_PATH}`, 32],
  ] as const) {
    const output = await deps.regQuery(key, view);
    const value = output === null ? null : parseRegDefaultValue(output, deps.env);
    if (value !== null) fromRegistry.push(value);
  }
  const folders = ['ProgramFiles(x86)', 'ProgramFiles', 'LOCALAPPDATA']
    .map((name) => getEnvVar(deps.env, name))
    .filter((value): value is string => value !== undefined && value !== '')
    .map((root) => path.win32.join(root, 'Microsoft', 'Edge', 'Application', 'msedge.exe'));
  for (const candidate of [...fromRegistry, ...folders]) {
    if (windowsPathIssue(candidate) !== null) continue;
    if (path.win32.extname(candidate).toLowerCase() !== '.exe') continue;
    if (await deps.fs.isFile(candidate)) return candidate;
  }
  return null;
}

// ---- run ----

export interface PreflightDeps {
  integration: ClaudeIntegrationImpl;
  nodeVersion: string;
  /** For pnpm/registry/Edge lookups (normally process.env). */
  env: Readonly<Record<string, string | undefined>>;
  /** Working directory for `pnpm config get registry` (repo root). */
  cwd: string;
  /** node.exe for a JS pnpm (process.execPath). */
  nodeExecutable: string;
  sdk: { sdkVersion: string; claudeCodeVersion: string } | null;
  fs?: ClaudeFsDeps;
  runFile?: RunFileFn;
  regQuery?: RegQuery;
}

export interface PreflightReport {
  checks: PreflightCheck[];
  exitCode: number;
}

export async function runPreflight(deps: PreflightDeps): Promise<PreflightReport> {
  const fs = deps.fs ?? nodeFsDeps;
  const run = deps.runFile ?? runFile;
  const checks: PreflightCheck[] = [checkNode(deps.nodeVersion)];

  const pnpm = await findPnpm(deps.env, fs, deps.nodeExecutable);
  const pnpmVersion =
    (pnpm === null ? null : await runText(run, pnpm.file, [...pnpm.prefix, '--version'], deps.cwd)) ??
    pnpmVersionFromUserAgent(getEnvVar(deps.env, 'npm_config_user_agent'));
  checks.push(checkPnpm(pnpmVersion));
  const registry =
    pnpm === null
      ? null
      : await runText(run, pnpm.file, [...pnpm.prefix, 'config', 'get', 'registry'], deps.cwd);
  checks.push(checkRegistry(registry));

  checks.push(checkSdk(deps.sdk?.sdkVersion ?? null, deps.sdk?.claudeCodeVersion ?? null));
  for (const profile of deps.integration.profiles.list()) {
    try {
      const status = await deps.integration.checkProfile(profile.id);
      checks.push(...checkProfileStatus(profile, status, deps.sdk?.claudeCodeVersion ?? null));
    } catch (error) {
      checks.push({
        id: `claude:${profile.id}`,
        title: 'claude',
        level: 'fail',
        detail: `check failed (${errnoCode(error) ?? (error instanceof Error ? error.message : 'error')})`,
      });
    }
  }

  const edge = await findEdge({ regQuery: deps.regQuery ?? regQuery(run), fs, env: deps.env });
  checks.push(checkEdge(edge));
  return { checks, exitCode: preflightExitCode(checks) };
}
