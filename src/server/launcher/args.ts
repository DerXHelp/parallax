/**
 * Command line of the launcher: its own flags plus the server flags of `loadConfig` (config.ts),
 * which resolves home and port exactly like the server does (flags > PARALLAX_* env > settings.json
 * > defaults, ADR-111).
 *
 * Phase 2: `--open <uri>`/`--open=<uri>` (the protocol handler `parallax:`, ADR-109) and
 * `--autostart` (the autostart shortcut, ADR-110). The handler is registered as
 * `"<node>" <launcher…> --open "%1"`, so the URI is always the LAST argument: anything after it is
 * refused – a crafted link that smuggles `" --home=… "` into `%1` cannot add options (R5).
 */
import type { ServerConfig } from '../config';

export interface LauncherArgs {
  /** `--print-url`: print the address with the one-time code instead of opening Edge. */
  printUrl: boolean;
  /** `--no-build`: do not check/build `dist`. */
  build: boolean;
  /** `--help` / `-h`. */
  help: boolean;
  /** `--open <uri>`: raw URI (checked with parseSessionProtocolUri by main.ts); null = none. */
  open: string | null;
  /** `--autostart`: started by the autostart shortcut (window only if the settings say so). */
  autostart: boolean;
  /** A malformed launcher option (main.ts: exit 2, nothing started); null = fine. */
  problem: string | null;
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
  '--autostart': (args) => {
    args.autostart = true;
  },
};

const OPEN_FLAG = '--open';

/**
 * `--` is skipped: pnpm 12 passes it on literally (`pnpm start -- --port=4800`), and loadConfig
 * (`parseArgs` without positionals) would reject it as an unexpected argument (WP-20a gap 2).
 */
export function parseLauncherArgs(argv: readonly string[]): LauncherArgs {
  const args: LauncherArgs = {
    printUrl: false,
    build: true,
    help: false,
    open: null,
    autostart: false,
    problem: null,
    serverArgv: [],
  };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i] ?? '';
    if (args.open !== null) {
      // R5: the URI of `--open` is the last argument (see the file comment).
      args.problem = `${OPEN_FLAG} must be the last option, got "${arg.slice(0, 100)}" after it`;
      break;
    }
    if (arg === '--') continue;
    if (arg === OPEN_FLAG || arg.startsWith(`${OPEN_FLAG}=`)) {
      const value = arg === OPEN_FLAG ? argv[i + 1] : arg.slice(OPEN_FLAG.length + 1);
      if (arg === OPEN_FLAG) i += 1;
      if (value === undefined || value === '') {
        args.problem = `${OPEN_FLAG} needs a parallax://session/<id> link`;
        break;
      }
      args.open = value;
      continue;
    }
    const own = OWN_FLAGS[arg];
    if (own === undefined) args.serverArgv.push(arg);
    else own(args);
  }
  if (args.problem === null && args.open !== null && args.autostart) {
    args.problem = `${OPEN_FLAG} and --autostart cannot be combined`;
  }
  return args;
}

/**
 * Arguments for `dist/server.js`: the resolved values, so launcher and server agree (CR-11: also
 * `--toasts`, so `parallax --toasts=off` reaches the server like `PARALLAX_TOASTS=off`; Phase 2:
 * the port from settings.json and `--system-integration`).
 */
export function serverArgsFor(
  config: Pick<
    ServerConfig,
    'home' | 'port' | 'backend' | 'logLevel' | 'validation' | 'toasts' | 'systemIntegration'
  >,
): string[] {
  return [
    `--home=${config.home}`,
    `--port=${String(config.port)}`,
    `--backend=${config.backend}`,
    `--log-level=${config.logLevel}`,
    `--validate=${config.validation}`,
    `--toasts=${config.toasts}`,
    `--system-integration=${config.systemIntegration}`,
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
  '                [--validate=off|log|throw] [--toasts=native|off]',
  '                [--system-integration=auto|on|off] [--no-build] [--print-url]',
  '                [--autostart] [--help] [--open <parallax://session/<id>>]',
  '',
  'Starts the Parallax server in the background (building it first if needed) and opens an Edge',
  'app window. If Parallax already runs, only another window is opened.',
  '  --port=<n>     server port (default: the port in the settings, else 4711; also PARALLAX_PORT)',
  '  --home=<dir>   data directory (default %LOCALAPPDATA%\\Parallax; also PARALLAX_HOME)',
  '  --backend=...  sdk (default, real claude) or fake (no tokens, for trying it out and E2E;',
  '                 also PARALLAX_BACKEND) - fake needs its own --home, never the real data',
  '                 directory',
  '  --validate=... check of outgoing data: log (default: log and drop), throw (tests), off',
  '                 (also PARALLAX_VALIDATE)',
  '  --toasts=...   native Windows toasts when no window can show a notification: native',
  '                 (default) or off (also PARALLAX_TOASTS)',
  '  --system-integration=...',
  '                 autostart shortcut and the parallax: link handler: auto (default: only the',
  '                 server on the default data directory with the real claude), on (also on',
  '                 another --home, for tests by hand), off (also PARALLAX_SYSTEM_INTEGRATION)',
  '  --no-build     do not check or rebuild dist/',
  '  --print-url    print the sign-in address (valid 60 s) instead of opening Edge',
  '  --autostart    used by the autostart shortcut: starts the server, opens a window only if',
  '                 "open a window at logon" is on in the settings',
  '  --open <link>  open the session of a parallax://session/<id> link (Windows notification',
  '                 click); must be the last option',
].join('\n');
