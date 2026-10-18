/**
 * Protocol handler `parallax:` (ADR-109, opt-in `settings.notifications.openOnClick`): a click on a
 * native toast with `launch="parallax://session/<id>"` starts the launcher with `--open "%1"`,
 * which opens a new app window on that session. Registered per user under
 * `HKCU\Software\Classes\parallax` with `reg.exe` (lib/registry.ts, absolute System32 path, no
 * shell): default value `URL:Parallax`, empty value `URL Protocol`, and
 * `shell\open\command` = `"<node>" <launcher args…> --open "%1"`.
 *
 * Only the own key is touched: an existing `parallax` handler whose command does not contain
 * `launcher\main.ts` belongs to another program – it is never overwritten (`reason: 'foreign'`)
 * and never removed. The launcher refuses anything after the URI (args.ts, R5).
 */
import { PROTOCOL_SCHEME } from '@shared/http';
import { PRODUCT_NAME } from '@shared/product';
import { windowsCommandLine } from '../lib/cmdline';
import { parseRegDefaultValue, type RegAddValue, type RegDeleteKey, type RegQuery } from '../lib/registry';
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

export interface ProtocolRegistryDeps {
  query: RegQuery;
  add: RegAddValue;
  remove: RegDeleteKey;
  /** For REG_EXPAND_SZ values of a foreign handler (default: none). */
  env?: Readonly<Record<string, string | undefined>>;
}

/** The registered command (null = no handler, or the query failed – both read as "none"). */
async function currentCommand(deps: ProtocolRegistryDeps): Promise<string | null> {
  const output = await deps.query(PROTOCOL_COMMAND_KEY, 64);
  return output === null ? null : parseRegDefaultValue(output, deps.env ?? {});
}

/** Registers (or refreshes) the own handler for `command` (see the file comment). */
export async function registerProtocolHandler(
  command: string,
  deps: ProtocolRegistryDeps,
): Promise<SystemOpResult> {
  const existing = await currentCommand(deps);
  if (existing !== null && !isOwnCommand(existing)) return { ok: false, reason: FOREIGN_HANDLER };
  const steps: [string, string | null, string][] = [
    [PROTOCOL_KEY, null, `URL:${PRODUCT_NAME}`],
    [PROTOCOL_KEY, 'URL Protocol', ''],
    [PROTOCOL_COMMAND_KEY, null, command],
  ];
  for (const [key, name, data] of steps) {
    const result = await deps.add(key, name, data);
    if (!result.ok) return result;
  }
  return { ok: true };
}

/** Removes the own handler; a missing or foreign one is left alone. */
export async function unregisterProtocolHandler(deps: ProtocolRegistryDeps): Promise<SystemOpResult> {
  const existing = await currentCommand(deps);
  if (existing === null || !isOwnCommand(existing)) return { ok: true };
  return deps.remove(PROTOCOL_KEY);
}
