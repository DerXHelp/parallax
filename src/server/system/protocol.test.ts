import { describe, expect, it } from 'vitest';
import type { RegAddValue, RegDeleteKey, RegQuery, RegWriteResult } from '../lib/registry';
import type { StartCommand } from './autostart';
import {
  FOREIGN_HANDLER,
  PROTOCOL_COMMAND_KEY,
  PROTOCOL_KEY,
  isOwnCommand,
  protocolCommand,
  registerProtocolHandler,
  unregisterProtocolHandler,
  type ProtocolRegistryDeps,
} from './protocol';

const COMMAND: StartCommand = {
  node: 'C:\\Program Files\\nodejs\\node.exe',
  args: [
    'D:\\dev\\Parallax Repo\\node_modules\\tsx\\dist\\cli.mjs',
    '--tsconfig',
    'D:\\dev\\Parallax Repo\\src\\server\\tsconfig.json',
    'D:\\dev\\Parallax Repo\\src\\server\\launcher\\main.ts',
  ],
  cwd: 'D:\\dev\\Parallax Repo',
};

/** `reg query <key> /ve` output as printed by reg.exe. */
const queryOutput = (value: string) =>
  `\r\nHKEY_CURRENT_USER\\Software\\Classes\\parallax\\shell\\open\\command\r\n    (Default)    REG_SZ    ${value}\r\n\r\n`;

function registry(existing: string | null, add: RegWriteResult = { ok: true }) {
  const adds: [string, string | null, string][] = [];
  const removes: string[] = [];
  const queries: string[] = [];
  const query: RegQuery = (key) => {
    queries.push(key);
    return Promise.resolve(existing === null ? null : queryOutput(existing));
  };
  const addValue: RegAddValue = (key, name, data) => {
    adds.push([key, name, data]);
    return Promise.resolve(add);
  };
  const remove: RegDeleteKey = (key) => {
    removes.push(key);
    return Promise.resolve({ ok: true });
  };
  const deps: ProtocolRegistryDeps = { query, add: addValue, remove };
  return { deps, adds, removes, queries };
}

describe('protocol handler parallax: (ADR-109)', () => {
  it('command: quoted node, the launcher arguments, --open "%1" last', () => {
    expect(protocolCommand(COMMAND)).toBe(
      '"C:\\Program Files\\nodejs\\node.exe" "D:\\dev\\Parallax Repo\\node_modules\\tsx\\dist\\cli.mjs" ' +
        '--tsconfig "D:\\dev\\Parallax Repo\\src\\server\\tsconfig.json" ' +
        '"D:\\dev\\Parallax Repo\\src\\server\\launcher\\main.ts" --open "%1"',
    );
    expect(isOwnCommand(protocolCommand(COMMAND))).toBe(true);
    expect(isOwnCommand('"C:\\Other\\app.exe" "%1"')).toBe(false);
  });

  it('registers the three values under HKCU\\Software\\Classes\\parallax', async () => {
    const r = registry(null);
    const command = protocolCommand(COMMAND);
    expect(await registerProtocolHandler(command, r.deps)).toEqual({ ok: true });
    expect(r.queries).toEqual([PROTOCOL_COMMAND_KEY]);
    expect(r.adds).toEqual([
      [PROTOCOL_KEY, null, 'URL:Parallax'],
      [PROTOCOL_KEY, 'URL Protocol', ''],
      ['HKCU\\Software\\Classes\\parallax\\shell\\open\\command', null, command],
    ]);
  });

  it('refreshes an own handler (another node path or repo), never a foreign one', async () => {
    const own = registry('"C:\\old\\node.exe" "C:\\old repo\\src\\server\\Launcher\\Main.ts" --open "%1"');
    expect(await registerProtocolHandler(protocolCommand(COMMAND), own.deps)).toEqual({ ok: true });
    expect(own.adds).toHaveLength(3);
    const foreign = registry('"C:\\Program Files\\Other\\other.exe" "%1"');
    expect(await registerProtocolHandler(protocolCommand(COMMAND), foreign.deps)).toEqual({
      ok: false,
      reason: FOREIGN_HANDLER,
    });
    expect(foreign.adds).toEqual([]);
  });

  it('stops at the first failed write', async () => {
    const r = registry(null, { ok: false, reason: 'reg.exe exit 1: denied' });
    expect(await registerProtocolHandler(protocolCommand(COMMAND), r.deps)).toEqual({
      ok: false,
      reason: 'reg.exe exit 1: denied',
    });
    expect(r.adds).toHaveLength(1);
  });

  it('removes only the own key; a missing or foreign one is left alone', async () => {
    const own = registry(protocolCommand(COMMAND));
    expect(await unregisterProtocolHandler(own.deps)).toEqual({ ok: true });
    expect(own.removes).toEqual([PROTOCOL_KEY]);
    const foreign = registry('"C:\\Other\\app.exe" "%1"');
    expect(await unregisterProtocolHandler(foreign.deps)).toEqual({ ok: true });
    expect(foreign.removes).toEqual([]);
    const missing = registry(null);
    expect(await unregisterProtocolHandler(missing.deps)).toEqual({ ok: true });
    expect(missing.removes).toEqual([]);
  });
});
