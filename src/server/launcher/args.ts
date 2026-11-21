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
 *
 * WP-107 (docs/wp/WP-100.md §5.3/§5.8, WP-76 §B.13): `--server` runs the server in the foreground
 * without Chrome (systemd, SSH; `--print-url` prints the sign-in address for a tunnel). Two
 * subcommands as the FIRST argument: `parallax service install|uninstall|status` (systemd user
 * service, Linux) and `parallax remote status|enable|disable|pair [--level <level>]|cancel|unpair|
 * level <level>` (the running server's "Share" over `POST /api/launcher/remote`). Their remaining
 * flags are server flags (`--home`, `--port`, `--key-store` …).
 */
import { z } from 'zod';
import { launcherRemoteRequestSchema, type LauncherRemoteRequest } from '@shared/http';
import { REMOTE_PEER_LEVELS, remotePeerLevelSchema } from '@shared/model';
import type { ServerConfig } from '../config';
import { HOST_PATH_RULES } from '../lib/paths';
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

/** WP-107: the systemd user service (Linux). */
export const SERVICE_ACTIONS = ['install', 'uninstall', 'status'] as const;
export type ServiceAction = (typeof SERVICE_ACTIONS)[number];

/** WP-107: the actions of `parallax remote` (`launcherRemoteRequestSchema`). */
export const REMOTE_ACTIONS = ['status', 'enable', 'disable', 'pair', 'cancel', 'unpair', 'level'] as const;

/** WP-107: a subcommand instead of a start. */
export type LauncherCommand =
  { kind: 'service'; action: ServiceAction } | { kind: 'remote'; request: LauncherRemoteRequest };

export interface LauncherArgs {
  /** `--print-url`: print the address with the one-time code instead of opening Chrome. */
  printUrl: boolean;
  /** WP-107 `--server`: the server in the foreground, no Chrome (systemd, SSH). */
  server: boolean;
  /** WP-107: `parallax service …` / `parallax remote …`; null = a start. */
  command: LauncherCommand | null;
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
  '--server': (args) => {
    args.server = true;
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
  if (args.open !== null || args.autostart || args.printUrl || args.server) {
    return `${APPLY_UPDATE_FLAG} cannot be combined with ${OPEN_FLAG}, --autostart, --print-url or --server`;
  }
  return { version: version.data, restore: raw.restore, waitPid: waitPid.data };
}

const LEVEL_FLAG = '--level';

/** `--install-root`'s value into `args` (false = refused, `args.problem` says why). */
function takeInstallRoot(value: string | undefined, args: LauncherArgs): boolean {
  // WP-107: the rules of this computer (Linux: `/opt/…`, never a Windows path).
  const issue = value === undefined ? 'empty' : HOST_PATH_RULES.issue(value);
  if (issue !== null) {
    args.problem = `${INSTALL_ROOT_FLAG} needs an absolute local folder (${issue})`;
    return false;
  }
  args.installRoot = value ?? null;
  return true;
}

/** WP-107: `service …` / `remote …` (`rest` starts with the subcommand). */
function parseCommand(rest: readonly string[], args: LauncherArgs): void {
  const [kind, action] = rest;
  let i = 2;
  if (kind === 'service') {
    const parsed = z.enum(SERVICE_ACTIONS).safeParse(action);
    if (!parsed.success) {
      args.problem = `service needs one of ${SERVICE_ACTIONS.join(', ')}`;
      return;
    }
    args.command = { kind: 'service', action: parsed.data };
  } else {
    const parsed = z.enum(REMOTE_ACTIONS).safeParse(action);
    if (!parsed.success) {
      args.problem = `remote needs one of ${REMOTE_ACTIONS.join(', ')}`;
      return;
    }
    let level: string | undefined;
    if (parsed.data === 'level') {
      level = rest[2];
      i = 3;
      if (!remotePeerLevelSchema.safeParse(level).success) {
        args.problem = `remote level needs ${REMOTE_PEER_LEVELS.join(' or ')}`;
        return;
      }
    }
    for (; i < rest.length; i++) {
      const value = parsed.data === 'pair' ? valueOf(rest, i, LEVEL_FLAG) : null;
      if (value !== null) {
        i += value.skip;
        level = value.value ?? '';
        if (!remotePeerLevelSchema.safeParse(level).success) {
          args.problem = `${LEVEL_FLAG} needs ${REMOTE_PEER_LEVELS.join(' or ')}`;
          return;
        }
        continue;
      }
      if (!collectCommandFlag(rest[i] ?? '', args)) return;
    }
    const request = launcherRemoteRequestSchema.safeParse({
      action: parsed.data,
      ...(level === undefined ? {} : { level }),
    });
    if (!request.success) {
      args.problem = `remote ${parsed.data}: invalid arguments`;
      return;
    }
    args.command = { kind: 'remote', request: request.data };
    return;
  }
  for (; i < rest.length; i++) {
    if (!collectCommandFlag(rest[i] ?? '', args)) return;
  }
}

/** A flag after a subcommand: `--help`, else a server flag; positionals are refused. */
function collectCommandFlag(arg: string, args: LauncherArgs): boolean {
  if (arg === '--help' || arg === '-h') {
    args.help = true;
    return true;
  }
  if (!arg.startsWith('-')) {
    args.problem = `unexpected argument "${arg.slice(0, 100)}"`;
    return false;
  }
  args.serverArgv.push(arg);
  return true;
}

/**
 * `--` is skipped: pnpm 12 passes it on literally (`pnpm start -- --port=4800`), and loadConfig
 * (`parseArgs` without positionals) would reject it as an unexpected argument (WP-20a gap 2).
 */
export function parseLauncherArgs(argv: readonly string[]): LauncherArgs {
  const args: LauncherArgs = {
    printUrl: false,
    server: false,
    command: null,
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
  // WP-107: a subcommand comes first – after the `--install-root` that start.mjs puts in front.
  const rest = argv.filter((arg) => arg !== '--');
  let start = 0;
  let rootValue: string | undefined | null = null;
  while (start < rest.length) {
    const root = valueOf(rest, start, INSTALL_ROOT_FLAG);
    if (root === null) break;
    rootValue = root.value;
    start += root.skip + 1;
  }
  if (rest[start] === 'service' || rest[start] === 'remote') {
    if (rootValue !== null && !takeInstallRoot(rootValue, args)) return args;
    parseCommand(rest.slice(start), args);
    return args;
  }
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
      if (!takeInstallRoot(value, args)) break;
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
  if (args.problem === null && args.server && (args.open !== null || args.autostart)) {
    args.problem = `--server cannot be combined with ${OPEN_FLAG} or --autostart`;
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
  > &
    Partial<Pick<ServerConfig, 'keyStore'>>,
): string[] {
  return [
    `--home=${config.home}`,
    `--port=${String(config.port)}`,
    `--backend=${config.backend}`,
    `--log-level=${config.logLevel}`,
    `--validate=${config.validation}`,
    `--toasts=${config.toasts}`,
    `--system-integration=${config.systemIntegration}`,
    // WP-107: the opt-in of the key file (Linux) reaches the server like the other flags.
    ...(config.keyStore === 'file' ? ['--key-store=file'] : []),
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
  '       parallax --server [--print-url] [server options]',
  '       parallax service install|uninstall|status [server options]',
  '       parallax remote status|enable|disable|pair [--level control|manage]|cancel|unpair',
  '       parallax remote level control|manage',
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
  '  --server       server mode: runs the server in the foreground without a window and logs to',
  '                 the console as well (a systemd service, a computer without a desktop); with',
  '                 --print-url it prints the sign-in address (for an SSH tunnel)',
  '  --key-store=file',
  '                 Linux without a keyring or systemd-creds: keep the keys of "Several computers"',
  '                 in a file only you can read (a copy of the data folder contains them)',
  '  service ...    Linux: the systemd user service "parallax" (parallax --server): install',
  '                 (and start), uninstall, status',
  '  remote ...     "Share" of the running server from the command line: status, enable,',
  '                 disable, pair (shows the pairing code here; --level manage also allows',
  '                 settings, profiles and updates), cancel, unpair, level control|manage',
].join('\n');
