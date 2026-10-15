/**
 * Command line of the launcher: its own flags plus the server flags of `loadConfig` (config.ts),
 * which resolves home and port exactly like the server does (flags > PARALLAX_* env > defaults).
 */
import type { ServerConfig } from '../config';

export interface LauncherArgs {
  /** `--print-url`: print the address with the one-time code instead of opening Edge. */
  printUrl: boolean;
  /** `--no-build`: do not check/build `dist`. */
  build: boolean;
  /** `--help` / `-h`. */
  help: boolean;
  /** Everything else, for loadConfig({ argv }). */
  serverArgv: string[];
}

const OWN_FLAGS: Readonly<Record<string, (args: LauncherArgs) => void>> = {
  '--print-url': (args) => {
    args.printUrl = true;
  },
  '--no-build': (args) => {
    args.build = false;
  },
  '--help': (args) => {
    args.help = true;
  },
  '-h': (args) => {
    args.help = true;
  },
};

/**
 * `--` is skipped: pnpm 12 passes it on literally (`pnpm start -- --port=4800`), and loadConfig
 * (`parseArgs` without positionals) would reject it as an unexpected argument (WP-20a gap 2).
 */
export function parseLauncherArgs(argv: readonly string[]): LauncherArgs {
  const args: LauncherArgs = { printUrl: false, build: true, help: false, serverArgv: [] };
  for (const arg of argv) {
    if (arg === '--') continue;
    const own = OWN_FLAGS[arg];
    if (own === undefined) args.serverArgv.push(arg);
    else own(args);
  }
  return args;
}

/** Arguments for `dist/server.js`: the resolved values, so launcher and server agree. */
export function serverArgsFor(
  config: Pick<ServerConfig, 'home' | 'port' | 'backend' | 'logLevel' | 'validation'>,
): string[] {
  return [
    `--home=${config.home}`,
    `--port=${String(config.port)}`,
    `--backend=${config.backend}`,
    `--log-level=${config.logLevel}`,
    `--validate=${config.validation}`,
  ];
}

/** Was a port asked for (`--port`/`PARALLAX_PORT`)? Only then a running server elsewhere gets a hint (V2-13). */
export function portRequested(serverArgv: readonly string[], env: NodeJS.ProcessEnv): boolean {
  return (
    serverArgv.some((arg) => arg === '--port' || arg.startsWith('--port=')) ||
    (env.PARALLAX_PORT ?? '') !== ''
  );
}

export const LAUNCHER_USAGE = [
  'Usage: parallax [--port=<n>] [--home=<dir>] [--backend=sdk|fake] [--log-level=<level>]',
  '                [--validate=off|log|throw] [--no-build] [--print-url] [--help]',
  '',
  'Starts the Parallax server in the background (building it first if needed) and opens an Edge',
  'app window. If Parallax already runs, only another window is opened.',
  '  --port=<n>     server port (default 4711; also PARALLAX_PORT)',
  '  --home=<dir>   data directory (default %LOCALAPPDATA%\\Parallax; also PARALLAX_HOME)',
  '  --backend=...  sdk (default, real claude) or fake (no tokens, for trying it out and E2E;',
  '                 also PARALLAX_BACKEND) - fake needs its own --home, never the real data',
  '                 directory',
  '  --validate=... check of outgoing data: log (default: log and drop), throw (tests), off',
  '                 (also PARALLAX_VALIDATE)',
  '  --no-build     do not check or rebuild dist/',
  '  --print-url    print the sign-in address (valid 60 s) instead of opening Edge',
].join('\n');
