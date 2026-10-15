/**
 * Windows registry reads without a shell (WP-11 owns this file; R1-08 / ADR-024, Nexus ADR-021):
 * `reg.exe` with its absolute System32 path and an argument array (no PowerShell, no cmd), output
 * parsed language-independently. Failures (missing key, timeout, non-Windows) are never thrown –
 * the callers treat them as "nothing found".
 *
 * Known limit: reg.exe prints in the OEM code page, so non-ASCII characters can arrive garbled.
 * The callers only compare/use values exactly, so a garbled value never matches (fails closed).
 */
import { runFile, systemTool, type RunFileFn } from './process';
import { getEnvVar } from './windows';

export type RegView = 64 | 32;

/** `reg.exe query <key> /ve /reg:<view>` → stdout, or null if the key does not exist / failed. */
export type RegQuery = (key: string, view: RegView) => Promise<string | null>;

/** `reg.exe query <key> /reg:<view>` (all values of the key) → stdout, or null. */
export type RegKeyQuery = (key: string, view: RegView) => Promise<string | null>;

const REG_TIMEOUT_MS = 10_000;

async function runReg(
  run: RunFileFn,
  args: readonly string[],
  maxOutputBytes: number,
): Promise<string | null> {
  try {
    const result = await run(systemTool('reg.exe'), args, { timeoutMs: REG_TIMEOUT_MS, maxOutputBytes });
    return result.exitCode === 0 && !result.timedOut ? result.stdout : null;
  } catch {
    return null;
  }
}

/** Default value of a key (`/ve`), see RegQuery. */
export function regQuery(run: RunFileFn = runFile): RegQuery {
  return (key, view) => runReg(run, ['query', key, '/ve', `/reg:${String(view)}`], 64 * 1024);
}

/** All values of a key, see RegKeyQuery. */
export function regKeyQuery(run: RunFileFn = runFile): RegKeyQuery {
  return (key, view) => runReg(run, ['query', key, `/reg:${String(view)}`], 1024 * 1024);
}

/** Expands `%NAME%` like Windows does for REG_EXPAND_SZ (unknown names stay literal). */
export function expandRegValue(value: string, env: Readonly<Record<string, string | undefined>>): string {
  return value.replace(/%([^%]+)%/g, (whole, name: string) => getEnvVar(env, name) ?? whole);
}

/** Default value of a `reg query <key> /ve` output (REG_SZ or REG_EXPAND_SZ, language-independent). */
export function parseRegDefaultValue(
  output: string,
  env: Readonly<Record<string, string | undefined>>,
): string | null {
  for (const line of output.split(/\r?\n/)) {
    const match = /\s(REG_SZ|REG_EXPAND_SZ)\s+(.+?)\s*$/.exec(line);
    if (match === null) continue;
    let value = (match[2] ?? '').replace(/^"(.*)"$/, '$1');
    if (match[1] === 'REG_EXPAND_SZ') value = expandRegValue(value, env);
    return value === '' ? null : value;
  }
  return null;
}

export interface RegValue {
  name: string;
  type: string;
  /** Raw data as printed (REG_EXPAND_SZ not expanded). */
  data: string;
}

/**
 * Values of a `reg query <key>` output: lines `    <name>    <REG_TYPE>    <data>` (four-space
 * separators; names may contain single spaces, data may be empty). Subkeys and headers are skipped.
 */
export function parseRegValues(output: string): RegValue[] {
  const values: RegValue[] = [];
  for (const line of output.split(/\r?\n/)) {
    const match = /^ {4}(\S(?:.*?\S)?) {4}(REG_[A-Z0-9_]+)(?: {4}(.*))?$/.exec(line);
    if (match === null) continue;
    const [, name, type, data] = match;
    if (name === undefined || type === undefined) continue;
    values.push({ name, type, data: data ?? '' });
  }
  return values;
}

/** Keys of the persistent environment (user, machine), as Windows builds it at logon. */
export const USER_ENVIRONMENT_KEY = 'HKCU\\Environment';
export const MACHINE_ENVIRONMENT_KEY =
  'HKLM\\SYSTEM\\CurrentControlSet\\Control\\Session Manager\\Environment';

/** Persistent environment: upper-cased name → expanded value (user wins over machine, like Windows). */
export type PersistentEnvironment = ReadonlyMap<string, string>;

/**
 * Reads the variables defined persistently in HKCU\Environment and HKLM\…\Session Manager\
 * Environment (REG_SZ / REG_EXPAND_SZ only, REG_EXPAND_SZ expanded against `env`). Errors give an
 * empty part (fail closed: no variable is treated as persistent). Non-Windows: empty.
 */
export async function readPersistentEnvironment(deps: {
  query?: RegKeyQuery;
  env: Readonly<Record<string, string | undefined>>;
  platform?: NodeJS.Platform;
}): Promise<PersistentEnvironment> {
  const result = new Map<string, string>();
  if ((deps.platform ?? process.platform) !== 'win32' && deps.query === undefined) return result;
  const query = deps.query ?? regKeyQuery();
  const [machine, user] = await Promise.all([
    query(MACHINE_ENVIRONMENT_KEY, 64),
    query(USER_ENVIRONMENT_KEY, 64),
  ]);
  for (const output of [machine, user]) {
    if (output === null) continue;
    for (const value of parseRegValues(output)) {
      if (value.type !== 'REG_SZ' && value.type !== 'REG_EXPAND_SZ') continue;
      const data = value.type === 'REG_EXPAND_SZ' ? expandRegValue(value.data, deps.env) : value.data;
      result.set(value.name.toUpperCase(), data);
    }
  }
  return result;
}
