/**
 * The launcher's command line flow (main.ts runs it with the real dependencies): arguments →
 * `loadConfig` → `runLauncher` → console messages and the exit code. Separate from main.ts so the
 * flow is unit-tested (main.ts only wires `process`).
 *
 * Exit codes: 0 = done, 2 = bad option or link (nothing started), 3 = data of a newer Parallax,
 * else 1. Phase 2: `--open <uri>` is checked with `parseSessionProtocolUri` BEFORE anything starts
 * (ADR-109, R5); `--autostart` opens a window only if `settings.autostart.openWindow` (settings
 * read-only, ADR-110).
 */
import type { EntryId } from '@shared/common';
import { serverOrigin, parseSessionProtocolUri } from '@shared/http';
import { DEFAULT_AUTOSTART } from '@shared/model';
import { ConfigError, loadConfig, readSettingsFile, type ServerConfig, type SettingsPeek } from '../config';
import { LAUNCHER_USAGE, parseLauncherArgs, portRequested, serverArgsFor } from './args';
import { LauncherError, type LauncherOptions, type LauncherResult } from './launcher';

export interface LauncherCliDeps {
  env: NodeJS.ProcessEnv;
  /** Base of a relative `--home` (default `process.cwd()`). */
  cwd?: string;
  /** One line to stdout / stderr. */
  out(line: string): void;
  fail(line: string): void;
  /** `runLauncher` with the real dependencies of `options.home`. */
  launch(options: LauncherOptions): Promise<LauncherResult>;
  /** Default `readSettingsFile` (read-only). */
  readSettings?(home: string): SettingsPeek;
}

/** At most this many characters of a refused link are echoed (it comes from any web page). */
const LINK_ECHO_CHARS = 120;

export async function runLauncherCli(argv: readonly string[], deps: LauncherCliDeps): Promise<number> {
  const args = parseLauncherArgs(argv);
  if (args.help) {
    deps.out(LAUNCHER_USAGE);
    return 0;
  }
  if (args.problem !== null) {
    deps.fail(`Invalid option: ${args.problem}\n\n${LAUNCHER_USAGE}`);
    return 2;
  }
  let entryId: EntryId | null = null;
  if (args.open !== null) {
    entryId = parseSessionProtocolUri(args.open);
    if (entryId === null) {
      deps.fail(
        `Invalid Parallax link "${args.open.slice(0, LINK_ECHO_CHARS)}" - expected parallax://session/<id>. ` +
          'Nothing was started.',
      );
      return 2;
    }
  }
  let config: ServerConfig;
  try {
    config = loadConfig({
      argv: args.serverArgv,
      env: deps.env,
      ...(deps.cwd === undefined ? {} : { cwd: deps.cwd }),
    });
  } catch (error) {
    if (!(error instanceof ConfigError)) throw error;
    deps.fail(`Invalid option: ${error.message}\n\n${LAUNCHER_USAGE}`);
    return 2;
  }
  if (config.dev) {
    deps.fail('--dev is for "pnpm dev" (Vite + dev server); the launcher starts the built app.');
    return 2;
  }
  const peek = (deps.readSettings ?? readSettingsFile)(config.home);
  for (const note of new Set([...config.notes, ...(peek.note === null ? [] : [peek.note])])) {
    deps.out(`Note: ${note}`);
  }
  const openWindow = args.autostart
    ? (peek.settings?.autostart.openWindow ?? DEFAULT_AUTOSTART.openWindow)
    : true;
  try {
    const result = await deps.launch({
      home: config.home,
      port: config.port,
      serverArgs: serverArgsFor(config),
      build: args.build,
      printUrl: args.printUrl,
      backend: config.backend,
      // V2-13: a port from the settings is a request too (the hint says when it takes effect).
      portExplicit: portRequested(args.serverArgv, deps.env) || (peek.settings?.port ?? null) !== null,
      entryId,
      openWindow,
    });
    deps.out(resultMessage(result, config, args.printUrl));
    return 0;
  } catch (error) {
    if (error instanceof LauncherError) {
      deps.fail(error.message);
      return error.exitCode;
    }
    deps.fail(
      `Unexpected launcher error: ${error instanceof Error ? (error.stack ?? error.message) : String(error)}`,
    );
    return 1;
  }
}

function resultMessage(result: LauncherResult, config: ServerConfig, printUrl: boolean): string {
  const origin = serverOrigin(result.port);
  if (!result.window) {
    return result.mode === 'started'
      ? `Parallax runs on ${origin} (PID ${String(result.pid)}, data: ${config.home}) - no window (autostart).`
      : `Parallax already runs on ${origin} - no window (autostart).`;
  }
  return result.mode === 'started'
    ? `Parallax runs on ${origin} (PID ${String(result.pid)}, data: ${config.home}).`
    : `Parallax already runs on ${origin} - ${printUrl ? 'new sign-in code above' : 'opened another window'}.`;
}
