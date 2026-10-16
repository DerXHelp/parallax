import { readFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { z } from 'zod';
import { BUILD_ID } from '@shared/build';
import { LOOPBACK_HOST, backendKindSchema, type BackendKind } from '@shared/http';
import { SETTINGS_SCHEMA_VERSION, settingsFileSchema, type Settings } from '@shared/model';
import { isWindowsPathInside, windowsPathIssue, windowsPathsEqual } from '@shared/paths';
import { PRODUCT_ID, PRODUCT_NAME } from '@shared/product';
import { newUuid } from './lib/ids';
import { logLevelSchema, type LogLevel } from './lib/logger';
import { fsErrorCode } from './lib/paths';
import { SETTINGS_FILE } from './store/settings';

/**
 * Server configuration (ADR-006): CLI flags > env `PARALLAX_*` > settings > defaults, validated
 * with zod. From the settings (`<home>/settings.json`, read-only, ADR-111) only the port is used:
 * flag > `PARALLAX_PORT` > `settings.port` > 4711 – the launcher resolves it with this same
 * function and passes it on (`serverArgsFor`), so both agree. A settings file that cannot be used
 * (invalid, newer schema version) is ignored with a hint in `notes` (logged by main.ts/launcher).
 *
 * Flags: `--dev`, `--backend=fake|sdk`, `--port=<0..65535>`, `--host=127.0.0.1`, `--home=<dir>`,
 * `--log-level=<level>`, `--validate=off|log|throw`, `--toasts=native|off`,
 * `--system-integration=auto|on|off`. Env: `PARALLAX_HOME`, `PARALLAX_PORT` (0 = any free port),
 * `PARALLAX_HOST`, `PARALLAX_BACKEND`, `PARALLAX_DEV` (`1`/`true`), `PARALLAX_LOG_LEVEL`,
 * `PARALLAX_VALIDATE`, `PARALLAX_TOASTS`, `PARALLAX_SYSTEM_INTEGRATION`.
 *
 * The bind address is always 127.0.0.1 (Plan "Sicherheit", A.8; R1-05, ADR-023): `--host` /
 * `PARALLAX_HOST` stay accepted for ADR-006 compatibility, every other value is a ConfigError –
 * on 0.0.0.0 a non-browser client could fake the Host header.
 *
 * The FakeBackend never runs on the real data directory or inside it (R3-02, ADR-061): fake
 * answers, fake session ids and fake PIDs would mix with the real entries – ConfigError.
 */

/** Port of the productive server (`pnpm start`). Dev uses 4712 (DEV_SERVER_PORT in repo.config.ts). */
export const DEFAULT_PORT = 4711;
/** Default data directory in dev mode, relative to the working directory (never %LOCALAPPDATA%). */
export const DEV_HOME_DIR = '.parallax-dev';

/** From @shared/http (the health answer reports it, R3-02). */
export { backendKindSchema, type BackendKind };

/**
 * Schema check of every outgoing value (hub: ops, summaries, host state; transcript lines – R0-28,
 * R1-16): `throw` fails loudly (tests, E2E), `log` logs, counts and drops the value (default, also
 * in production – R3-05, ADR-063), `off` sends unchecked.
 */
export const validationModeSchema = z.enum(['off', 'log', 'throw']);
export type ValidationMode = z.infer<typeof validationModeSchema>;

/**
 * Native Windows toasts (WP22-03/-15, Plan A.9; sessions/nativeToasts.ts): `native` on Windows,
 * `off` under Vitest and in the E2E servers (`NODE_ENV=test`) – a test run must not pop up toasts
 * or write the HKCU app id. Flag `--toasts=native|off`, env `PARALLAX_TOASTS`.
 */
export const toastModeSchema = z.enum(['native', 'off']);
export type ToastMode = z.infer<typeof toastModeSchema>;

/**
 * Windows integration – autostart shortcut and protocol handler `parallax:` (ADR-109/110,
 * system/index.ts): `auto` = only the productive server (default data directory, SDK backend, no
 * `--dev`; `systemIntegrationAvailable`), `on` forces it (live acceptance on a temp home; the
 * registered commands then carry `--home=<home>`), `off`. Under Vitest and `NODE_ENV=test` always
 * `off` – an explicit `on` there is a ConfigError. Flag `--system-integration`, env
 * `PARALLAX_SYSTEM_INTEGRATION`.
 */
export const systemIntegrationModeSchema = z.enum(['auto', 'on', 'off']);
export type SystemIntegrationMode = z.infer<typeof systemIntegrationModeSchema>;

export interface ServerConfig {
  dev: boolean;
  backend: BackendKind;
  /** Outgoing validation (R3-05). */
  validation: ValidationMode;
  /** Native Windows toasts (WP22-03/-15). */
  toasts: ToastMode;
  /** 0 = any free port (tests); the actual port comes from the listening server. */
  port: number;
  /** Bind address: always 127.0.0.1 (LOOPBACK_HOST, R1-05); Host/Origin checks use the same address. */
  host: typeof LOOPBACK_HOST;
  /** Absolute PARALLAX_HOME. */
  home: string;
  /** HostState.dataDirLabel (display only). */
  dataDirLabel: string;
  logLevel: LogLevel;
  /** Autostart + protocol handler (ADR-110); `auto` is decided by `systemIntegrationAvailable`. */
  systemIntegration: SystemIntegrationMode;
  /** Hints for the log (main.ts, launcher), e.g. an ignored settings.json (English, no secrets). */
  notes: string[];
}

export class ConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ConfigError';
  }
}

const portSchema = z
  .string()
  .regex(/^\d{1,5}$/, 'port must be a number')
  .transform(Number)
  .pipe(z.number().int().min(0).max(65535));
const hostSchema = z.literal(LOOPBACK_HOST, { error: `only ${LOOPBACK_HOST} is allowed (loopback only)` });
const boolEnvSchema = z.enum(['1', '0', 'true', 'false']).transform((v) => v === '1' || v === 'true');
const homeSchema = z.string().trim().min(1);

function parseOrThrow<T>(schema: z.ZodType<T>, value: unknown, label: string): T {
  const parsed = schema.safeParse(value);
  if (!parsed.success) {
    throw new ConfigError(`invalid ${label}: ${parsed.error.issues[0]?.message ?? 'invalid value'}`);
  }
  return parsed.data;
}

function nonEmpty(value: string | undefined): string | undefined {
  return value === undefined || value === '' ? undefined : value;
}

/** `%LOCALAPPDATA%\Parallax` (falls back to `<home>\AppData\Local\Parallax`). */
export function defaultHome(env: NodeJS.ProcessEnv = process.env): string {
  const base = nonEmpty(env.LOCALAPPDATA) ?? path.join(os.homedir(), 'AppData', 'Local');
  return path.join(base, PRODUCT_NAME);
}

export interface LoadConfigInput {
  /** CLI arguments without node and script (default `process.argv.slice(2)`). */
  argv?: readonly string[];
  env?: NodeJS.ProcessEnv;
  /** Base for a relative `--home` (default `process.cwd()`). */
  cwd?: string;
  /** Text of a file (throws like `readFileSync`); seam for the settings file (default: real fs). */
  readFile?: (file: string) => string;
}

// ---- settings.json, read-only (ADR-111) ----

/** What `readSettingsFile` found: the settings, or null with a hint why they are not used. */
export interface SettingsPeek {
  settings: Settings | null;
  /** English hint for the log; null if the file is fine or simply missing. */
  note: string | null;
}

/** Larger files are not read (a settings file is a few KB). */
const SETTINGS_MAX_BYTES = 1024 * 1024;

function readTextFile(file: string): string {
  const text = readFileSync(file, 'utf8');
  if (text.length > SETTINGS_MAX_BYTES) throw new Error('file too large');
  return text;
}

/**
 * Reads `<home>/settings.json` WITHOUT writing or moving anything (the settings store of the
 * server owns the file; the launcher only peeks): missing → no settings, no hint; unreadable,
 * invalid or written by a newer Parallax version (`schemaVersion` > SETTINGS_SCHEMA_VERSION) →
 * no settings and a hint. Never throws. Under Vitest the real data directory is never read, also
 * not through a hand-made `env` (CLAUDE.md "Tests").
 */
export function readSettingsFile(
  home: string,
  readFile: (file: string) => string = readTextFile,
): SettingsPeek {
  if (process.env.VITEST !== undefined && isWindowsPathInside(home, defaultHome(process.env))) {
    return { settings: null, note: null };
  }
  const file = path.join(home, SETTINGS_FILE);
  const ignored = (why: string): SettingsPeek => ({
    settings: null,
    note: `${file} ignored (${why}) - using the defaults for port and autostart`,
  });
  let text: string;
  try {
    text = readFile(file);
  } catch (error) {
    const code = fsErrorCode(error);
    if (code === 'ENOENT' || code === 'ENOTDIR') return { settings: null, note: null };
    return ignored(`not readable: ${code ?? (error instanceof Error ? error.message : 'unknown error')}`);
  }
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    return ignored('not valid JSON');
  }
  const version =
    typeof raw === 'object' && raw !== null && 'schemaVersion' in raw ? raw.schemaVersion : null;
  if (typeof version === 'number' && version > SETTINGS_SCHEMA_VERSION) {
    return ignored(`written by a newer Parallax version, schemaVersion ${String(version)}`);
  }
  const parsed = settingsFileSchema.safeParse(raw);
  if (!parsed.success) return ignored('invalid settings file');
  return { settings: parsed.data.settings, note: null };
}

/** Vitest or an E2E server (`NODE_ENV=test`) – in `env` or in this process. */
function isTestRun(env: NodeJS.ProcessEnv): boolean {
  return env.VITEST !== undefined || env.NODE_ENV === 'test' || process.env.VITEST !== undefined;
}

/**
 * The effective mode (see `systemIntegrationModeSchema`): in a test run always `off`, an explicit
 * `on` there is a ConfigError (a test must never change HKCU or the autostart folder, R6).
 */
export function resolveSystemIntegrationMode(
  requested: SystemIntegrationMode,
  testRun: boolean,
): SystemIntegrationMode {
  if (!testRun) return requested;
  if (requested === 'on') {
    throw new ConfigError(
      'system integration "on" is not allowed in tests (it changes HKCU and the autostart folder)',
    );
  }
  return 'off';
}

/**
 * HostState.systemIntegration (ADR-110): `on` → true, `off` → false, `auto` → only the productive
 * server: Windows, SDK backend, no `--dev`, the default data directory.
 */
export function systemIntegrationAvailable(
  config: Pick<ServerConfig, 'systemIntegration' | 'home' | 'backend' | 'dev'>,
  env: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform,
): boolean {
  if (config.systemIntegration !== 'auto') return config.systemIntegration === 'on';
  return (
    platform === 'win32' &&
    config.backend === 'sdk' &&
    !config.dev &&
    windowsPathsEqual(config.home, defaultHome(env))
  );
}

export function loadConfig(input: LoadConfigInput = {}): ServerConfig {
  const env = input.env ?? process.env;
  const cwd = input.cwd ?? process.cwd();
  let values: Record<string, string | boolean | undefined>;
  try {
    ({ values } = parseArgs({
      args: [...(input.argv ?? process.argv.slice(2))],
      options: {
        dev: { type: 'boolean' },
        backend: { type: 'string' },
        port: { type: 'string' },
        host: { type: 'string' },
        home: { type: 'string' },
        'log-level': { type: 'string' },
        validate: { type: 'string' },
        toasts: { type: 'string' },
        'system-integration': { type: 'string' },
      },
      strict: true,
      allowPositionals: false,
    }));
  } catch (error) {
    throw new ConfigError(error instanceof Error ? error.message : 'invalid arguments');
  }

  const flag = (name: string): string | undefined => {
    const value = values[name];
    return typeof value === 'string' ? value : undefined;
  };

  const dev =
    values.dev === true ||
    (nonEmpty(env.PARALLAX_DEV) !== undefined &&
      parseOrThrow(boolEnvSchema, env.PARALLAX_DEV, 'PARALLAX_DEV'));

  const backendRaw = flag('backend') ?? nonEmpty(env.PARALLAX_BACKEND);
  const backend =
    backendRaw === undefined
      ? dev
        ? 'fake'
        : 'sdk'
      : parseOrThrow(backendKindSchema, backendRaw, 'backend');

  const hostRaw = flag('host') ?? nonEmpty(env.PARALLAX_HOST);
  const host = hostRaw === undefined ? LOOPBACK_HOST : parseOrThrow(hostSchema, hostRaw, 'host');

  const logLevelRaw = flag('log-level') ?? nonEmpty(env.PARALLAX_LOG_LEVEL);
  const logLevel =
    logLevelRaw === undefined
      ? dev
        ? 'debug'
        : 'info'
      : parseOrThrow(logLevelSchema, logLevelRaw, 'log level');

  const homeRaw = flag('home') ?? nonEmpty(env.PARALLAX_HOME);
  const realHome = defaultHome(env);
  const home =
    homeRaw === undefined
      ? dev
        ? path.resolve(cwd, DEV_HOME_DIR)
        : realHome
      : path.resolve(cwd, parseOrThrow(homeSchema, homeRaw, 'home'));
  if (process.platform === 'win32') {
    const issue = windowsPathIssue(home);
    if (issue !== null) throw new ConfigError(`invalid home (${issue}): ${home}`);
  }
  const isRealHome = windowsPathsEqual(home, realHome);
  // Also no folder inside it (R0-23).
  if (env.VITEST !== undefined && isWindowsPathInside(home, realHome)) {
    throw new ConfigError(`tests must not use the real data directory ${realHome}`);
  }
  if (backend === 'fake' && isWindowsPathInside(home, realHome)) {
    throw new ConfigError(
      `the FakeBackend never uses the real data directory ${realHome} - pass --home=<dir> or ` +
        'PARALLAX_HOME (e.g. a folder in %TEMP%), or start without --backend=fake/PARALLAX_BACKEND=fake',
    );
  }

  // Port (ADR-111): flag > env > settings.json (read only when needed, after the home checks) > 4711.
  const notes: string[] = [];
  const portRaw = flag('port') ?? nonEmpty(env.PARALLAX_PORT);
  let port: number;
  if (portRaw !== undefined) {
    port = parseOrThrow(portSchema, portRaw, 'port');
  } else {
    const peek = readSettingsFile(home, input.readFile);
    if (peek.note !== null) notes.push(peek.note);
    port = peek.settings?.port ?? DEFAULT_PORT;
  }

  const integrationRaw = flag('system-integration') ?? nonEmpty(env.PARALLAX_SYSTEM_INTEGRATION);
  const systemIntegration = resolveSystemIntegrationMode(
    integrationRaw === undefined
      ? 'auto'
      : parseOrThrow(systemIntegrationModeSchema, integrationRaw, 'system integration'),
    isTestRun(env),
  );

  // Explicit > env > test runs (Vitest, NODE_ENV=test as set by the E2E servers) fail loudly > log.
  const validateRaw = flag('validate') ?? nonEmpty(env.PARALLAX_VALIDATE);
  const validation =
    validateRaw !== undefined
      ? parseOrThrow(validationModeSchema, validateRaw, 'validate')
      : env.VITEST !== undefined || env.NODE_ENV === 'test'
        ? 'throw'
        : 'log';

  const toastsRaw = flag('toasts') ?? nonEmpty(env.PARALLAX_TOASTS);
  const toasts: ToastMode =
    toastsRaw !== undefined
      ? parseOrThrow(toastModeSchema, toastsRaw, 'toasts')
      : process.platform === 'win32' && env.VITEST === undefined && env.NODE_ENV !== 'test'
        ? 'native'
        : 'off';

  return {
    dev,
    backend,
    validation,
    toasts,
    port,
    host,
    home,
    dataDirLabel: isRealHome ? `%LOCALAPPDATA%\\${PRODUCT_NAME}` : dev ? 'dev' : home,
    logLevel,
    systemIntegration,
    notes,
  };
}

// ---- Server instance (identity of one server start) ----

export interface ServerInstance {
  /** New UUID per start (hello, health, auth status, lock file). */
  serverInstanceId: string;
  /** package.json version. */
  serverVersion: string;
  /** `BUILD_ID` (`dev` when unbundled). */
  buildId: string;
  startedAt: string;
}

const packageJsonSchema = z.looseObject({ name: z.string(), version: z.string().min(1) });

/**
 * Version from the repo's package.json, found by walking up from this module (works for
 * src/server/config.ts and the bundle dist/server.js). Fallback `0.0.0`.
 */
export function readServerVersion(): string {
  let dir = path.dirname(fileURLToPath(import.meta.url));
  for (let i = 0; i < 6; i++) {
    try {
      const raw: unknown = JSON.parse(readFileSync(path.join(dir, 'package.json'), 'utf8'));
      const pkg = packageJsonSchema.safeParse(raw);
      if (pkg.success && pkg.data.name === PRODUCT_ID) return pkg.data.version;
    } catch {
      // not here, keep walking up
    }
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return '0.0.0';
}

export function createServerInstance(
  options: { serverVersion?: string; buildId?: string; now?: Date } = {},
): ServerInstance {
  return {
    serverInstanceId: newUuid(),
    serverVersion: options.serverVersion ?? readServerVersion(),
    buildId: options.buildId ?? BUILD_ID,
    startedAt: (options.now ?? new Date()).toISOString(),
  };
}
