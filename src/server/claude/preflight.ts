/**
 * Checks of `pnpm preflight` (Plan "Paketmanager: pnpm 12", "Claude-Profile"): Node version,
 * pnpm version, registry, every profile's `claude` (path, version, C.7 rule) and login, Microsoft
 * Edge and Edge policies that can sign in/sync its app profile (V2-01), a hint for antivirus
 * products that scan local web traffic (V1-08) and whether other users
 * can read PARALLAX_HOME (R2-13). Pure
 * formatting/rating functions plus `runPreflight` with injectable seams. Output is English (Plan:
 * preflight and logs stay English). Never prints e-mail/org (parseAuthStatus).
 */
import path from 'node:path';
import { z } from 'zod';
import type { ClaudeInstallStatus, Profile } from '@shared/model';
import { windowsPathIssue } from '@shared/paths';
import { findEdge } from '../lib/edge';
import { checkHomeAccess, type HomeAccess } from '../lib/homeAccess';
import { errnoCode, runFile, systemTool, type RunFileFn } from '../lib/process';
import { parseRegValues, regKeyQuery, regQuery, type RegKeyQuery, type RegQuery } from '../lib/registry';
import { getEnvVar, nodeFsProbe, resolveExecutable, type FsProbe } from '../lib/windows';
import type { ClaudeIntegrationImpl } from './integration';
import { compareVersions } from './resolveClaude';

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

/** Where Edge reads group/MDM policies (machine and user). */
export const EDGE_POLICY_KEYS = [
  'HKLM\\SOFTWARE\\Policies\\Microsoft\\Edge',
  'HKCU\\SOFTWARE\\Policies\\Microsoft\\Edge',
] as const;

/**
 * Edge policies that can override the app profile's "never sign in, never sync" switches (V2-01,
 * ADR-060), with the values that do. A policy beats a command-line switch; `FeatureFlagOverridesControl`
 * = 0 even makes Edge ignore `--disable-features=msImplicitSignin`.
 */
const RISKY_EDGE_POLICIES: Readonly<Record<string, (data: string) => boolean>> = {
  BrowserSignin: (data) => data === '0x2', // force sign-in
  ForceSync: (data) => data === '0x1',
  ImplicitSignInEnabled: (data) => data === '0x1',
  ConfigureOnPremisesAccountAutoSignIn: (data) => data !== '0x0',
  FeatureFlagOverridesControl: (data) => data === '0x0', // command-line feature switches ignored
  UserDataDir: () => true, // the own --user-data-dir is replaced
};

/** Relevant Edge policies (`<name>=<data>`): warn if one can sign in/sync the app profile; none → no line. */
export function checkEdgePolicies(
  values: readonly { key: string; name: string; data: string }[],
): PreflightCheck {
  const relevant = values.filter(
    (v) => Object.hasOwn(RISKY_EDGE_POLICIES, v.name) || /sync|signin/i.test(v.name),
  );
  // WP22-11: always one line, so the output shows that the policies were checked.
  if (relevant.length === 0)
    return { id: 'edge-policies', title: 'edge policies', level: 'ok', detail: 'none' };
  const risky = relevant.filter((v) => RISKY_EDGE_POLICIES[v.name]?.(v.data.toLowerCase()) === true);
  const detail = relevant.map((v) => `${v.name}=${v.data}`).join(', ');
  if (risky.length === 0) return { id: 'edge-policies', title: 'edge policies', level: 'info', detail };
  return {
    id: 'edge-policies',
    title: 'edge policies',
    level: 'warn',
    detail,
    hint:
      `${risky.map((v) => v.name).join(', ')} can sign the Parallax Edge profile in to the Windows/work ` +
      'account or turn on sync despite its switches (README "Edge-Profil"). Check edge://signin-internals ' +
      'in a Parallax window after the first start.',
  };
}

/** The values of EDGE_POLICY_KEYS (`reg query`; a missing key has none). */
export async function edgePolicyValues(
  query: RegKeyQuery,
): Promise<{ key: string; name: string; data: string }[]> {
  const values: { key: string; name: string; data: string }[] = [];
  for (const key of EDGE_POLICY_KEYS) {
    const output = await query(key, 64);
    if (output === null) continue;
    for (const value of parseRegValues(output)) values.push({ key, name: value.name, data: value.data });
  }
  return values;
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

/**
 * Antivirus products known to filter local web traffic. Kaspersky's Web Anti-Virus was observed
 * injecting a script into http://127.0.0.1 pages, rewriting the CSP and reading the `#code=`
 * one-time code (V1-08); the others offer comparable HTTP(S) filtering.
 */
const WEB_SCANNERS: readonly { pattern: RegExp; name: string }[] = [
  { pattern: /kaspersky/i, name: 'Kaspersky' },
  { pattern: /\beset\b/i, name: 'ESET' },
  { pattern: /bitdefender/i, name: 'Bitdefender' },
  { pattern: /\bavast\b/i, name: 'Avast' },
  { pattern: /\bavg\b/i, name: 'AVG' },
];

/** Antivirus check: warn for a known web-traffic scanner, info otherwise; null if unknown. */
export function checkAntivirus(products: readonly string[] | null): PreflightCheck | null {
  if (products === null) return null;
  const base = { id: 'antivirus', title: 'antivirus' };
  const scanners = WEB_SCANNERS.filter((scanner) => products.some((p) => scanner.pattern.test(p))).map(
    (scanner) => scanner.name,
  );
  if (scanners.length > 0) {
    return {
      ...base,
      level: 'warn',
      detail: `${scanners.join(', ')} (scans web traffic)`,
      hint:
        'Exclude 127.0.0.1 / the Parallax port from web traffic scanning: injected scripts weaken the ' +
        'page CSP and can read the one-time login code (README: "Virenscanner mit Web-Traffic-Scan").',
    };
  }
  // Security Center often lists one product several times (one entry per component).
  const names = [...new Set(products)];
  return { ...base, level: 'info', detail: names.length === 0 ? 'none registered' : names.join(', ') };
}

const antivirusOutputSchema = z.union([z.array(z.string()), z.string()]);

/**
 * Display names of the registered antivirus products (Windows Security Center, `root/SecurityCenter2`
 * – readable without admin rights on client Windows). Null if unavailable (Windows Server, CIM error).
 */
export async function antivirusProducts(run: RunFileFn = runFile): Promise<string[] | null> {
  if (process.platform !== 'win32') return null;
  const script =
    "$p = @(Get-CimInstance -Namespace 'root/SecurityCenter2' -ClassName AntiVirusProduct -ErrorAction Stop | " +
    'ForEach-Object { [string]$_.displayName }); ConvertTo-Json -InputObject $p -Compress';
  try {
    const result = await run(
      systemTool(path.win32.join('WindowsPowerShell', 'v1.0', 'powershell.exe')),
      ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', script],
      { timeoutMs: 20_000, maxOutputBytes: 64 * 1024 },
    );
    if (result.exitCode !== 0 || result.timedOut) return null;
    const parsed = antivirusOutputSchema.safeParse(JSON.parse(result.stdout.trim()) as unknown);
    if (!parsed.success) return null;
    return typeof parsed.data === 'string' ? [parsed.data] : parsed.data;
  } catch {
    return null;
  }
}

/**
 * R2-13 (warn only, no ACL change): the data folder holds the launcher token and the cookie
 * secret – other users must not be able to read it (multi-user/RDP machines, `--home` on another
 * drive). An unknown result is only `info`.
 */
export function checkHomeAccessResult(home: string, access: HomeAccess): PreflightCheck {
  const base = { id: 'home', title: 'data dir' };
  switch (access.kind) {
    case 'private':
      return { ...base, level: 'ok', detail: `${home} (only you)` };
    case 'missing':
      return { ...base, level: 'info', detail: `${home} (not created yet)` };
    case 'unknown':
      return { ...base, level: 'info', detail: `${home} (access not checked: ${access.reason})` };
    case 'shared':
      return {
        ...base,
        level: 'warn',
        detail: `${home} is readable by ${access.principals.join(', ')}`,
        hint:
          'It holds the launcher token and the cookie secret. Use a folder only you can read (the default ' +
          `under %LOCALAPPDATA% is) or restrict it, e.g. icacls "${home}" /inheritance:r /grant:r ` +
          '"%USERNAME%:(OI)(CI)F" "*S-1-5-18:(OI)(CI)F" "*S-1-5-32-544:(OI)(CI)F".',
      };
  }
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
  fs: FsProbe,
  nodeExecutable: string,
): Promise<PnpmCommand | null> {
  const execPath = getEnvVar(env, 'npm_execpath');
  if (execPath !== undefined && windowsPathIssue(execPath) === null && (await fs.isFile(execPath))) {
    const ext = path.win32.extname(execPath).toLowerCase();
    if (ext === '.exe') return { file: execPath, prefix: [] };
    if (['.js', '.cjs', '.mjs'].includes(ext)) return { file: nodeExecutable, prefix: [execPath] };
  }
  const exe = await resolveExecutable('pnpm', env, fs);
  return exe === null ? null : { file: exe, prefix: [] };
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
  fs?: FsProbe;
  runFile?: RunFileFn;
  regQuery?: RegQuery;
  /** Edge policy keys (`reg query <key>`, default reg.exe); V2-01. */
  regKeyQuery?: RegKeyQuery;
  /** Registered antivirus products (default: Windows Security Center via CIM); null = unknown. */
  antivirus?: () => Promise<string[] | null>;
  /** PARALLAX_HOME to check for other readers (R2-13); omitted/null = no check. */
  home?: string | null;
  /** Default lib/homeAccess.ts `checkHomeAccess`. */
  homeAccess?: (home: string) => Promise<HomeAccess>;
}

export interface PreflightReport {
  checks: PreflightCheck[];
  exitCode: number;
}

export async function runPreflight(deps: PreflightDeps): Promise<PreflightReport> {
  const fs = deps.fs ?? nodeFsProbe;
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
  checks.push(checkEdgePolicies(await edgePolicyValues(deps.regKeyQuery ?? regKeyQuery(run))));
  const antivirus = checkAntivirus(await (deps.antivirus ?? (() => antivirusProducts(run)))());
  if (antivirus !== null) checks.push(antivirus);
  const home = deps.home ?? null;
  if (home !== null) {
    const access = await (deps.homeAccess ?? ((h: string) => checkHomeAccess(h, { run })))(home);
    checks.push(checkHomeAccessResult(home, access));
  }
  return { checks, exitCode: preflightExitCode(checks) };
}
