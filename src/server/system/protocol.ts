/**
 * Protocol handler `parallax:` (ADR-109, opt-in `settings.notifications.openOnClick`): a click on a
 * native toast with `launch="parallax://session/<id>"` starts the launcher with `--open "%1"`,
 * which opens a new app window on that session. Registered per user under
 * `HKCU\Software\Classes\parallax` with `reg.exe` (lib/registry.ts, absolute System32 path, no
 * shell): `shell\open\command` = `"<node>" <launcher args…> --open "%1"`, default value
 * `URL:Parallax`, empty value `URL Protocol` (the command first: an interrupted registration leaves
 * a key that is recognizably the own one).
 *
 * Only the own key is touched: an existing `parallax` key whose `shell\open\command` does not
 * contain `launcher\main.ts` – or that has no such command at all – belongs to another program; it
 * is never overwritten (`reason: 'foreign'`) and never removed. CR2-01: "key missing" and "query
 * failed" are told apart by reg.exe's exit code (`regKeyReader`); a failed query writes nothing.
 * The launcher refuses anything after the URI (args.ts, R5).
 */
import { PROTOCOL_SCHEME } from '@shared/http';
import { PRODUCT_NAME } from '@shared/product';
import { toError } from '../lib/async';
import { windowsCommandLine } from '../lib/cmdline';
import { systemTool, type RunFileFn } from '../lib/process';
import { parseRegDefaultValue, type RegAddValue, type RegDeleteKey } from '../lib/registry';
import { LAUNCHER_MARKER, type StartCommand } from './autostart';
import type { SystemOpResult } from './run';

export const PROTOCOL_KEY = `HKCU\\Software\\Classes\\${PROTOCOL_SCHEME}`;
export const PROTOCOL_COMMAND_KEY = `${PROTOCOL_KEY}\\shell\\open\\command`;
/** Marks a command as Parallax's own (case-insensitive; the same marker as the autostart shortcut). */
export const OWN_COMMAND_MARKER = LAUNCHER_MARKER;
/** `reason` of a handler that belongs to another program. */
export const FOREIGN_HANDLER = 'foreign';

/** `"<node>" <args…> --open "%1"` (`%1` = the URI, quoted by the shell's substitution rules). */
export function protocolCommand(command: StartCommand): string {
  return `"${command.node}" ${windowsCommandLine(command.args)} --open "%1"`;
}

export function isOwnCommand(command: string): boolean {
  return command.toLowerCase().includes(OWN_COMMAND_MARKER);
}

/**
 * What `reg.exe query <key> /ve` says about a key, judged by the exit code only (the messages are
 * localized): 0 = the key exists (`output`; also without a default value – reg.exe then prints
 * "(value not set)"), 1 = missing, anything else (timeout, not started, other exit code) = failed.
 */
export type RegKeyRead =
  { state: 'present'; output: string } | { state: 'missing' } | { state: 'failed'; reason: string };

export type RegKeyReader = (key: string) => Promise<RegKeyRead>;

const REG_QUERY_TIMEOUT_MS = 10_000;

/** `reg.exe query <key> /ve /reg:64` as a `RegKeyReader` (see there; `run` from system/run.ts, R6). */
export function regKeyReader(run: RunFileFn): RegKeyReader {
  return async (key) => {
    try {
      const result = await run(systemTool('reg.exe'), ['query', key, '/ve', '/reg:64'], {
        timeoutMs: REG_QUERY_TIMEOUT_MS,
        maxOutputBytes: 64 * 1024,
      });
      if (result.timedOut) return { state: 'failed', reason: 'registry query: reg.exe timed out' };
      if (result.exitCode === 0) return { state: 'present', output: result.stdout };
      if (result.exitCode === 1) return { state: 'missing' };
      const output = (result.stderr.trim() || result.stdout.trim()).slice(0, 300);
      return {
        state: 'failed',
        reason: `registry query: reg.exe exit ${String(result.exitCode)}: ${output}`,
      };
    } catch (error) {
      return {
        state: 'failed',
        reason: `registry query: reg.exe could not be started: ${toError(error).message}`,
      };
    }
  };
}

export interface ProtocolRegistryDeps {
  read: RegKeyReader;
  add: RegAddValue;
  remove: RegDeleteKey;
  /** For REG_EXPAND_SZ values of a foreign handler (default: none). */
  env?: Readonly<Record<string, string | undefined>>;
}

/** Who holds `shell\open\command`: nobody (`none`), Parallax, another program, or unknown (failed). */
type Holder = { kind: 'none' } | { kind: 'own' } | { kind: 'foreign' } | { kind: 'failed'; reason: string };

async function commandHolder(deps: ProtocolRegistryDeps): Promise<Holder> {
  const command = await deps.read(PROTOCOL_COMMAND_KEY);
  if (command.state === 'failed') return { kind: 'failed', reason: command.reason };
  if (command.state === 'missing') return { kind: 'none' };
  const value = parseRegDefaultValue(command.output, deps.env ?? {});
  return value !== null && isOwnCommand(value) ? { kind: 'own' } : { kind: 'foreign' };
}

/** Registers (or refreshes) the own handler for `command` (see the file comment). */
export async function registerProtocolHandler(
  command: string,
  deps: ProtocolRegistryDeps,
): Promise<SystemOpResult> {
  let current = await commandHolder(deps);
  if (current.kind === 'none') {
    // No shell\open\command: the scheme key itself may still belong to another program.
    const key = await deps.read(PROTOCOL_KEY);
    if (key.state === 'failed') current = { kind: 'failed', reason: key.reason };
    else if (key.state === 'present') current = { kind: 'foreign' };
  }
  if (current.kind === 'failed') return { ok: false, reason: current.reason };
  if (current.kind === 'foreign') return { ok: false, reason: FOREIGN_HANDLER };
  const steps: [string, string | null, string][] = [
    [PROTOCOL_COMMAND_KEY, null, command],
    [PROTOCOL_KEY, null, `URL:${PRODUCT_NAME}`],
    [PROTOCOL_KEY, 'URL Protocol', ''],
  ];
  for (const [key, name, data] of steps) {
    const result = await deps.add(key, name, data);
    if (!result.ok) return result;
  }
  return { ok: true };
}

/**
 * Removes the own handler (recognized by its command); a missing or foreign one is left alone, a
 * failed query is a failure (the warning stays, the next apply tries again).
 */
export async function unregisterProtocolHandler(deps: ProtocolRegistryDeps): Promise<SystemOpResult> {
  const current = await commandHolder(deps);
  if (current.kind === 'failed') return { ok: false, reason: current.reason };
  if (current.kind !== 'own') return { ok: true };
  return deps.remove(PROTOCOL_KEY);
}
