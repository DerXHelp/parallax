/**
 * Command line of the launcher: its own flags plus the server flags of `loadConfig` (config.ts),
 * which resolves home and port exactly like the server does (flags > PARALLAX_* env > settings.json
 * > defaults, ADR-111).
 *
 * Phase 2: `--open <uri>`/`--open=<uri>` (the protocol handler `parallax:`, ADR-109) and
 * `--autostart` (the autostart shortcut, ADR-110). The handler is registered as
 * `"<node>" <launcher…> --open "%1"`, so the URI is always the LAST argument: anything after it is
 * refused – a crafted link that smuggles `" --home=… "` into `%1` cannot add options (R5). WP-81
 * (ADR-211): the link names the session (`parallax://session/<id>`) or a session of another
 * computer (`parallax://session/<hostId>/<id>`, the toast of a controlling computer) – `OPEN_LINK_FORMS`.
 *
 * WP-87b: `--apply-update=<v>` (+ `--restore`, `--wait-pid=<pid>`) makes this process the
 * orchestrator of a version switch (applyUpdate.ts), started by the server of the old version
 * (update/handoff.ts `orchestratorCommand`). It needs `--install-root` and `--wait-pid` and cannot
 * be combined with `--open`, `--autostart` or `--print-url`.
 */
import { z } from 'zod';
import { windowsPathIssue } from '@shared/paths';
import type { ServerConfig } from '../config';
import { APPLY_UPDATE_FLAG, RESTORE_FLAG, WAIT_PID_FLAG } from '../update/handoff';
import { releaseVersionSchema } from './release';

/** `--apply-update` and its companions (WP-87b, docs/wp/WP-87.md §2.2). */
export interface ApplyUpdateArgs {
  /** Target version (`versions\<v>` must be staged). */
  version: string;
  /** `--restore`: switch with the backup of that version (`needsRestore`). */
  restore: boolean;
  /** `--wait-pid`: PID of the server that hands over. */
  waitPid: number;
}

export interface LauncherArgs {
  /** `--print-url`: print the address with the one-time code instead of opening Chrome. */
  printUrl: boolean;
  /** `--no-build`: do not check/build `dist`. */
  build: boolean;
  /** `--help` / `-h`. */
  help: boolean;
  /** `--open <uri>`: raw URI (checked with parseHostSessionProtocolUri by cli.ts); null = none. */
  open: string | null;
  /** `--autostart`: started by the autostart shortcut (window only if the settings say so). */
  autostart: boolean;
  /**
   * `--install-root <dir>` (WP-85, package mode): root folder of an installation, passed by its
   * `start.mjs`; working directory of server and Chrome instead of the version folder. null = none.
   */
  installRoot: string | null;
  /** WP-87b `--apply-update=<v>`: run as the orchestrator of a version switch; null = normal start. */
  applyUpdate: ApplyUpdateArgs | null;
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
const INSTALL_ROOT_FLAG = '--install-root';

/** Both accepted forms of an `--open` link (messages and usage). */
export const OPEN_LINK_FORMS = 'parallax://session/<id> or parallax://session/<computer>/<id>';

const waitPidSchema = z
  .string()
  .regex(/^\d{1,10}$/u)
  .transform(Number)
  .pipe(z.number().int().positive().max(0xffffffff));

/** `--flag=<value>` or `--flag <value>`: the value and how many arguments it took; null = not this flag. */
function valueOf(
  argv: readonly string[],
  i: number,
  flag: string,
): { value: string | undefined; skip: number } | null {
  const arg = argv[i] ?? '';
  if (arg === flag) return { value: argv[i + 1], skip: 1 };
  if (arg.startsWith(`${flag}=`)) return { value: arg.slice(flag.length + 1), skip: 0 };
  return null;
}

/** The orchestrator flags (WP-87b) together; null = none given, a string = the problem. */
function applyUpdateArgs(
  raw: { version: string | null; restore: boolean; waitPid: string | null },
  args: LauncherArgs,
): ApplyUpdateArgs | string | null {
  if (raw.version === null) {
    if (raw.restore || raw.waitPid !== null) {
      return `${RESTORE_FLAG} and ${WAIT_PID_FLAG} belong to ${APPLY_UPDATE_FLAG}`;
    }
    return null;
  }
  const version = releaseVersionSchema.safeParse(raw.version);
  if (!version.success) return `${APPLY_UPDATE_FLAG} needs a release version (X.Y.Z or X.Y.Z-rc.N)`;
  const waitPid = waitPidSchema.safeParse(raw.waitPid ?? '');
  if (raw.waitPid === null || !waitPid.success) {
    return `${APPLY_UPDATE_FLAG} needs ${WAIT_PID_FLAG}=<pid> of the server that hands over`;
  }
  if (args.installRoot === null) return `${APPLY_UPDATE_FLAG} needs ${INSTALL_ROOT_FLAG}=<dir>`;
  if (args.open !== null || args.autostart || args.printUrl) {
    return `${APPLY_UPDATE_FLAG} cannot be combined with ${OPEN_FLAG}, --autostart or --print-url`;
  }
  return { version: version.data, restore: raw.restore, waitPid: waitPid.data };
}

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
    installRoot: null,
    applyUpdate: null,
    problem: null,
    serverArgv: [],
  };
  const apply: { version: string | null; restore: boolean; waitPid: string | null } = {
    version: null,
    restore: false,
    waitPid: null,
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
        args.problem = `${OPEN_FLAG} needs a ${OPEN_LINK_FORMS} link`;
        break;
      }
      args.open = value;
      continue;
    }
    if (arg === INSTALL_ROOT_FLAG || arg.startsWith(`${INSTALL_ROOT_FLAG}=`)) {
      const value = arg === INSTALL_ROOT_FLAG ? argv[i + 1] : arg.slice(INSTALL_ROOT_FLAG.length + 1);
      if (arg === INSTALL_ROOT_FLAG) i += 1;
      const issue = value === undefined ? 'empty' : windowsPathIssue(value);
      if (issue !== null) {
        args.problem = `${INSTALL_ROOT_FLAG} needs an absolute local folder (${issue})`;
        break;
      }
      args.installRoot = value ?? null;
      continue;
    }
    const version = valueOf(argv, i, APPLY_UPDATE_FLAG);
    if (version !== null) {
      i += version.skip;
      apply.version = version.value ?? '';
      continue;
    }
    const waitPid = valueOf(argv, i, WAIT_PID_FLAG);
    if (waitPid !== null) {
      i += waitPid.skip;
      apply.waitPid = waitPid.value ?? '';
      continue;
    }
    if (arg === RESTORE_FLAG) {
      apply.restore = true;
      continue;
    }
    const own = OWN_FLAGS[arg];
    if (own === undefined) args.serverArgv.push(arg);
    else own(args);
  }
  if (args.problem === null && args.open !== null && args.autostart) {
    args.problem = `${OPEN_FLAG} and --autostart cannot be combined`;
  }
  if (args.problem === null) {
    const applied = applyUpdateArgs(apply, args);
    if (typeof applied === 'string') args.problem = applied;
    else args.applyUpdate = applied;
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
  '                [--autostart] [--install-root=<dir>] [--help]',
  '                [--open <parallax://session/<id>>]',
  '',
  'Starts the Parallax server in the background (building it first if needed) and opens a Chrome',
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
  '  --print-url    print the sign-in address (valid 60 s) instead of opening Chrome',
  '  --autostart    used by the autostart shortcut: starts the server, opens a window only if',
  '                 "open a window at logon" is on in the settings',
  '  --install-root=<dir>',
  '                 root folder of an installation (passed by its start.mjs): working folder of',
  '                 the server and the Chrome window',
  '  --open <link>  open the session of a parallax://session/<id> link, or of a session of',
  '                 another computer: parallax://session/<computer>/<id> (Windows notification',
  '                 click); must be the last option',
  '  --apply-update=<version> --wait-pid=<pid> [--restore]',
  '                 internal: started by the Parallax server to switch an installation to a',
  '                 prepared version (needs --install-root)',
].join('\n');
