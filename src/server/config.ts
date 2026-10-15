import { readFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { z } from 'zod';
import { BUILD_ID } from '@shared/build';
import { LOOPBACK_HOST } from '@shared/http';
import { windowsPathIssue, windowsPathsEqual } from '@shared/paths';
import { PRODUCT_ID, PRODUCT_NAME } from '@shared/product';
import { newUuid } from './lib/ids';
import { logLevelSchema, type LogLevel } from './lib/logger';

/**
 * Server configuration (ADR-006): CLI flags > env `PARALLAX_*` > settings > defaults, validated
 * with zod. Settings (`settings.json`) have no server fields in Phase 1 (port/autostart follow in
 * Phase 2), so that layer is empty for now.
 *
 * Flags: `--dev`, `--backend=fake|sdk`, `--port=<0..65535>`, `--host=<ip>`, `--home=<dir>`,
 * `--log-level=<level>`. Env: `PARALLAX_HOME`, `PARALLAX_PORT` (0 = any free port),
 * `PARALLAX_HOST`, `PARALLAX_BACKEND`, `PARALLAX_DEV` (`1`/`true`), `PARALLAX_LOG_LEVEL`.
 */

/** Port of the productive server (`pnpm start`). Dev uses 4712 (DEV_SERVER_PORT in repo.config.ts). */
export const DEFAULT_PORT = 4711;
/** Default data directory in dev mode, relative to the working directory (never %LOCALAPPDATA%). */
export const DEV_HOME_DIR = '.parallax-dev';

export const backendKindSchema = z.enum(['sdk', 'fake']);
export type BackendKind = z.infer<typeof backendKindSchema>;

export interface ServerConfig {
  dev: boolean;
  backend: BackendKind;
  /** 0 = any free port (tests); the actual port comes from the listening server. */
  port: number;
  /** Bind address, default 127.0.0.1. Host/Origin checks stay on 127.0.0.1 (src/shared/http.ts). */
  host: string;
  /** Absolute PARALLAX_HOME. */
  home: string;
  /** HostState.dataDirLabel (display only). */
  dataDirLabel: string;
  logLevel: LogLevel;
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
const hostSchema = z.union([z.ipv4(), z.ipv6()]);
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

  const portRaw = flag('port') ?? nonEmpty(env.PARALLAX_PORT);
  const port = portRaw === undefined ? DEFAULT_PORT : parseOrThrow(portSchema, portRaw, 'port');

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
  if (isRealHome && env.VITEST !== undefined) {
    throw new ConfigError(`tests must not use the real data directory ${realHome}`);
  }

  return {
    dev,
    backend,
    port,
    host,
    home,
    dataDirLabel: isRealHome ? `%LOCALAPPDATA%\\${PRODUCT_NAME}` : dev ? 'dev' : home,
    logLevel,
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
