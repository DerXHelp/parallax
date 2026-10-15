import path from 'node:path';
import { pino, type DestinationStream, type Logger } from 'pino';
import { z } from 'zod';
import { PRODUCT_ID } from '@shared/product';

/**
 * The one logger of the server (never `console.*` in src/server). Logs are English.
 *
 * - `logger` is a process-wide singleton; modules use `logger.child({ module: '<name>' })`.
 * - Until `initLogging()` runs it writes JSON lines to stdout (level from `PARALLAX_LOG_LEVEL`,
 *   default `info`; `silent` under Vitest). `initLogging()` (called once by main.ts, WP-20) adds
 *   the rotating file `PARALLAX_HOME/logs/parallax.<date>.<n>.log` (pino-roll, in-process) and
 *   pretty console output in dev mode.
 * - Redaction (B "Der Logger maskiert Env-Werte und Tokens"): values under `REDACT_PATHS` are
 *   censored (an `env` object keeps its keys, every value becomes `[REDACTED]`), and every
 *   finished line is scrubbed by `redactText` (registered secrets, Bearer tokens, API keys,
 *   device-cookie values, `*_TOKEN=`/`*_KEY=` assignments).
 */

export const LOG_LEVELS = ['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent'] as const;
export const logLevelSchema = z.enum(LOG_LEVELS);
export type LogLevel = z.infer<typeof logLevelSchema>;

export const REDACTED = '[REDACTED]';

/** pino redact paths; `*` matches one level. */
export const REDACT_PATHS: readonly string[] = [
  'env',
  '*.env',
  '*.*.env',
  '*.*.*.env',
  'headers.cookie',
  'headers.authorization',
  'headers["set-cookie"]',
  '*.headers.cookie',
  '*.headers.authorization',
  '*.headers["set-cookie"]',
  'cookie',
  '*.cookie',
  'authorization',
  '*.authorization',
  'token',
  '*.token',
  'launcherToken',
  '*.launcherToken',
  'authCode',
  '*.authCode',
  'secret',
  '*.secret',
  'password',
  '*.password',
  'apiKey',
  '*.apiKey',
];

function censor(value: unknown): unknown {
  if (typeof value === 'object' && value !== null && !Array.isArray(value)) {
    // Env objects: keep the variable names (useful for debugging), hide every value.
    return Object.fromEntries(Object.keys(value).map((key) => [key, REDACTED]));
  }
  return REDACTED;
}

// ---- Free-text scrubbing (applied to every finished log line) ----

const secretValues = new Set<string>();

/**
 * Registers a secret value (launcher token, cookie secret, …) that must never appear in a log
 * line; occurrences are replaced by `[REDACTED]`. Values shorter than 8 chars are ignored.
 */
export function registerSecret(value: string): void {
  if (value.length >= 8) secretValues.add(value);
}

export function unregisterSecret(value: string): void {
  secretValues.delete(value);
}

const TEXT_PATTERNS: readonly (readonly [RegExp, string])[] = [
  [/\b(Bearer\s+)[A-Za-z0-9._~+/=-]{8,}/gi, `$1${REDACTED}`],
  [/\bsk-ant-[A-Za-z0-9_-]{8,}/g, REDACTED],
  [new RegExp(`\\b(${PRODUCT_ID}_\\d+=)[^;\\s"\\\\]+`, 'g'), `$1${REDACTED}`],
  [/\b([A-Z0-9_]*(?:API_KEY|AUTH_TOKEN|_TOKEN|_SECRET|PASSWORD)=)[^\s"\\]+/g, `$1${REDACTED}`],
  // JSON form at any depth (R1-20): "GITHUB_TOKEN":"…", also escaped inside a string value.
  [/("[A-Za-z0-9_-]*(?:TOKEN|SECRET|PASSWORD|API_?KEY)"\s*:\s*")(?:[^"\\]|\\.)*"/gi, `$1${REDACTED}"`],
  [
    /(\\"[A-Za-z0-9_-]*(?:TOKEN|SECRET|PASSWORD|API_?KEY)\\"\s*:\s*\\")(?:[^"\\]|\\[^"])*\\"/gi,
    `$1${REDACTED}\\"`,
  ],
];

/** Removes registered secrets and token-like patterns from a text (also usable for stderr lines). */
export function redactText(text: string): string {
  let result = text;
  for (const secret of secretValues) {
    if (result.includes(secret)) result = result.split(secret).join(REDACTED);
  }
  for (const [pattern, replacement] of TEXT_PATTERNS) result = result.replace(pattern, replacement);
  return result;
}

// ---- Repeated failures ----

/** A repeated failure logs its first REPEATED_LOG_FIRST occurrences, then every REPEATED_LOG_EVERY-th. */
export const REPEATED_LOG_FIRST = 20;
export const REPEATED_LOG_EVERY = 100;

/**
 * Should occurrence number `count` (1-based) of a repeated failure be logged? A broken stream must
 * not flood the log (R3-05: invalid outgoing values in `log` mode carry the running count).
 */
export function shouldLogRepeated(count: number): boolean {
  return count <= REPEATED_LOG_FIRST || count % REPEATED_LOG_EVERY === 0;
}

// ---- Destinations ----

interface LineSink {
  write(line: string): unknown;
}

/** Fan-out destination whose targets `initLogging` swaps at runtime (the singleton keeps working). */
class SwitchableDestination implements DestinationStream {
  targets: LineSink[] = [process.stdout];

  write(line: string): void {
    for (const target of this.targets) target.write(line);
  }
}

const rootDestination = new SwitchableDestination();

function defaultLevel(env: NodeJS.ProcessEnv = process.env): LogLevel {
  const parsed = logLevelSchema.safeParse(env.PARALLAX_LOG_LEVEL);
  if (parsed.success) return parsed.data;
  return env.VITEST === undefined ? 'info' : 'silent';
}

export interface CreateLoggerOptions {
  level?: LogLevel;
  /** Default: stdout. Tests pass an in-memory sink. */
  destination?: DestinationStream;
}

/** A logger with the project's redaction rules (the singleton `logger` is built the same way). */
export function createLogger(options: CreateLoggerOptions = {}): Logger {
  return pino(
    {
      name: PRODUCT_ID,
      level: options.level ?? defaultLevel(),
      redact: { paths: [...REDACT_PATHS], censor },
      hooks: { streamWrite: redactText },
    },
    options.destination ?? process.stdout,
  );
}

/** The server logger (see module comment). */
export const logger: Logger = createLogger({ destination: rootDestination });

// ---- File rotation + console (initLogging) ----

interface RollingFile extends LineSink {
  end(): void;
  flushSync?(): void;
  once(event: 'close', listener: () => void): unknown;
}

function isRollingFile(value: unknown): value is RollingFile {
  return (
    typeof value === 'object' &&
    value !== null &&
    'write' in value &&
    typeof value.write === 'function' &&
    'end' in value &&
    typeof value.end === 'function' &&
    'once' in value &&
    typeof value.once === 'function'
  );
}

type RollBuild = (options: Record<string, unknown>) => Promise<unknown>;

function isRollBuild(value: unknown): value is RollBuild {
  return typeof value === 'function';
}

/** pino-roll ships no typings: load it untyped and check the shape at runtime. */
async function openRollingFile(file: string): Promise<RollingFile> {
  const specifier = 'pino-roll';
  const mod: unknown = await import(specifier);
  const build: unknown = typeof mod === 'object' && mod !== null && 'default' in mod ? mod.default : mod;
  if (!isRollBuild(build)) throw new Error('pino-roll: unexpected module shape');
  const stream = await build({
    file,
    frequency: 'daily',
    dateFormat: 'yyyy-MM-dd',
    size: '20m',
    mkdir: true,
    limit: { count: 14 },
  });
  if (!isRollingFile(stream)) throw new Error('pino-roll: unexpected stream shape');
  return stream;
}

async function openPrettyConsole(): Promise<LineSink> {
  // pino-pretty is a devDependency: only loaded in dev mode.
  const { default: pretty } = await import('pino-pretty');
  return pretty({ colorize: true, translateTime: 'SYS:HH:MM:ss.l', ignore: 'pid,hostname,name' });
}

export interface InitLoggingOptions {
  /** PARALLAX_HOME; null = no log file. */
  home: string | null;
  dev: boolean;
  level: LogLevel;
  /** Console output (pretty in dev, JSON lines otherwise). Default true. */
  console?: boolean;
}

export interface LoggingHandle {
  /** Base path of the rotating log file (pino-roll appends `.<date>.<n>.log`), or null. */
  readonly logFile: string | null;
  /** Flushes and closes the log file; the singleton falls back to stdout. */
  close(): Promise<void>;
}

/** Configures the singleton `logger` (once per process, main.ts / WP-20). */
export async function initLogging(options: InitLoggingOptions): Promise<LoggingHandle> {
  const targets: LineSink[] = [];
  let file: RollingFile | null = null;
  const logFile = options.home === null ? null : path.join(options.home, 'logs', `${PRODUCT_ID}.log`);
  if (logFile !== null) {
    file = await openRollingFile(logFile);
    targets.push(file);
  }
  if (options.console ?? true) targets.push(options.dev ? await openPrettyConsole() : process.stdout);
  rootDestination.targets = targets;
  logger.level = options.level;

  return {
    logFile,
    close: async () => {
      rootDestination.targets = [process.stdout];
      if (file === null) return;
      const closing = file;
      file = null;
      await new Promise<void>((resolve) => {
        closing.once('close', resolve);
        closing.end();
      });
    },
  };
}
