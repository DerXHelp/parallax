/**
 * The Windows key store (docs/wp/WP-76.md §B.5): DPAPI (`ProtectedData`, CurrentUser) with the
 * purpose-bound entropy `parallax-keystore-v1:<purpose>`, run by Windows PowerShell 5.1 with a
 * CONSTANT script (`-EncodedCommand`).
 *
 * - Data travels only over stdin/stdout (base64) – never in arguments, environment or the script.
 * - The script touches secrets only through .NET calls (`[Console]::In`, `[Convert]`,
 *   `ProtectedData`, `[Console]::Out`), never as a cmdlet parameter: module logging (event 4103)
 *   records cmdlet parameters and transcription records host output; script block logging only
 *   sees the constant script.
 * - `powershell.exe` is the absolute System32 path (`powerShellPath`, never resolved via PATH),
 *   started hidden without a shell (`spawnHidden`), killed as a tree after 15 s.
 * - Errors become `KeyStoreError` without any data; stderr is read and dropped (never logged).
 * - Buffers with secrets are zeroed after use where Node allows it (V8 strings cannot be).
 */
import { randomBytes } from 'node:crypto';
import type { ChildProcess } from 'node:child_process';
import type { Logger } from 'pino';
import { logger as rootLogger } from '../lib/logger';
import { encodePowerShell } from '../lib/powershell';
import { killProcessTree, powerShellPath, spawnHidden, windowsPowerShellEnv } from '../lib/process';
import { KeyStoreError, type KeyPurpose, type KeyStore } from './ports';

/** Purposes the store accepts (`KeyPurpose`, host ids as `hostIdSchema`). */
export const KEY_PURPOSE_PATTERN =
  /^(?:identity|coupling:[a-z0-9][a-z0-9-]{0,31}|auth:[a-z0-9][a-z0-9-]{0,31})$/u;
export const DPAPI_TIMEOUT_MS = 15_000;
/** Largest plaintext (a PKCS#8 ML-DSA-87 key is ~54 bytes in seed form, ~4.9 KB expanded). */
export const KEY_STORE_MAX_PLAINTEXT = 64 * 1024;
/** Largest output read from the helper (base64 of a ciphertext of at most the plaintext above). */
const MAX_OUTPUT_BYTES = 256 * 1024;
/** A failed probe is repeated at most this often (a working store is cached for the process). */
const PROBE_RETRY_MS = 60_000;
const BASE64 = /^[A-Za-z0-9+/]*={0,2}$/u;

/**
 * The constant script. Input on stdin: three lines `<op>`, `<base64 purpose>`, `<base64 data>` with
 * op `P` (protect), `U` (unprotect) or `T` (probe: protect + unprotect of the data, prints `OK`).
 * Output on stdout: base64 of the result, nothing else. Exit code 0 = success.
 */
export const DPAPI_SCRIPT = String.raw`
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
try {
  Add-Type -AssemblyName System.Security
  $text = [Console]::In.ReadToEnd()
  $parts = $text.Split([char]10)
  if ($parts.Length -lt 3) { exit 3 }
  $op = $parts[0].Trim()
  $purpose = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String($parts[1].Trim()))
  $data = [Convert]::FromBase64String($parts[2].Trim())
  $text = $null
  $parts = $null
  $entropy = [Text.Encoding]::UTF8.GetBytes('parallax-keystore-v1:' + $purpose)
  $scope = [Security.Cryptography.DataProtectionScope]::CurrentUser
  if ($op -ceq 'P') {
    $out = [Security.Cryptography.ProtectedData]::Protect($data, $entropy, $scope)
  } elseif ($op -ceq 'U') {
    $out = [Security.Cryptography.ProtectedData]::Unprotect($data, $entropy, $scope)
  } elseif ($op -ceq 'T') {
    $sealed = [Security.Cryptography.ProtectedData]::Protect($data, $entropy, $scope)
    $back = [Security.Cryptography.ProtectedData]::Unprotect($sealed, $entropy, $scope)
    if ([Convert]::ToBase64String($back) -cne [Convert]::ToBase64String($data)) { exit 5 }
    $out = [Text.Encoding]::ASCII.GetBytes('OK')
  } else {
    exit 4
  }
  [Array]::Clear($data, 0, $data.Length)
  [Console]::Out.Write([Convert]::ToBase64String($out))
  [Array]::Clear($out, 0, $out.Length)
  exit 0
} catch {
  exit 1
}
`;

const ENCODED_SCRIPT = encodePowerShell(DPAPI_SCRIPT);
export const DPAPI_ARGS: readonly string[] = [
  '-NoLogo',
  '-NoProfile',
  '-NonInteractive',
  '-EncodedCommand',
  ENCODED_SCRIPT,
];

type Operation = 'P' | 'U' | 'T';

/** Starts the helper (seam for tests; the default is `spawnHidden(powerShellPath(), DPAPI_ARGS)`). */
export type DpapiSpawn = () => ChildProcess;

export interface DpapiKeyStoreOptions {
  platform?: NodeJS.Platform;
  env?: NodeJS.ProcessEnv;
  timeoutMs?: number;
  spawn?: DpapiSpawn;
  logger?: Logger;
}

function defaultSpawn(env: NodeJS.ProcessEnv): DpapiSpawn {
  return () =>
    spawnHidden(powerShellPath(env), DPAPI_ARGS, {
      env: windowsPowerShellEnv(env),
      stdio: ['pipe', 'pipe', 'pipe'],
      // Read and dropped: PowerShell's own errors never contain our data, but nothing is logged anyway.
      onStderr: () => undefined,
    });
}

/** Runs one operation; resolves with the decoded output, rejects with KeyStoreError. */
function runHelper(
  spawn: DpapiSpawn,
  timeoutMs: number,
  op: Operation,
  purpose: string,
  data: Buffer,
): Promise<Buffer> {
  return new Promise<Buffer>((resolve, reject) => {
    let child: ChildProcess;
    try {
      child = spawn();
    } catch {
      reject(new KeyStoreError('unavailable', 'key store helper could not be started'));
      return;
    }
    const chunks: Buffer[] = [];
    let size = 0;
    let settled = false;
    let timedOut = false;
    const input = Buffer.from(
      `${op}\n${Buffer.from(purpose, 'utf8').toString('base64')}\n${data.toString('base64')}\n`,
      'ascii',
    );

    const wipe = (): void => {
      input.fill(0);
      for (const chunk of chunks) chunk.fill(0);
      chunks.length = 0;
    };
    const fail = (error: KeyStoreError): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      wipe();
      reject(error);
    };
    const timer = setTimeout(() => {
      timedOut = true;
      const pid = child.pid;
      if (pid !== undefined) void killProcessTree(pid).catch(() => child.kill('SIGKILL'));
      fail(new KeyStoreError('timeout'));
    }, timeoutMs);

    child.stdout?.on('data', (chunk: Buffer) => {
      size += chunk.length;
      if (size > MAX_OUTPUT_BYTES) {
        chunk.fill(0);
        return;
      }
      chunks.push(chunk);
    });
    child.once('error', () => {
      fail(new KeyStoreError('unavailable', 'key store helper could not be started'));
    });
    child.once('close', (code) => {
      if (settled || timedOut) return;
      if (code !== 0 || size > MAX_OUTPUT_BYTES) {
        fail(new KeyStoreError('failed'));
        return;
      }
      const raw = Buffer.concat(chunks);
      const text = raw.toString('ascii');
      raw.fill(0);
      if (text.length === 0 || !BASE64.test(text)) {
        fail(new KeyStoreError('failed'));
        return;
      }
      settled = true;
      clearTimeout(timer);
      wipe();
      resolve(Buffer.from(text, 'base64'));
    });
    child.stdin?.on('error', () => undefined);
    child.stdin?.end(input);
  });
}

function checkPurpose(purpose: string): void {
  if (!KEY_PURPOSE_PATTERN.test(purpose)) throw new KeyStoreError('failed', 'invalid key purpose');
}

/** DPAPI key store (Windows only; elsewhere `available()` is false and every call fails). */
export function createDpapiKeyStore(options: DpapiKeyStoreOptions = {}): KeyStore {
  const platform = options.platform ?? process.platform;
  const env = options.env ?? process.env;
  const timeoutMs = options.timeoutMs ?? DPAPI_TIMEOUT_MS;
  const spawn = options.spawn ?? defaultSpawn(env);
  const log = (options.logger ?? rootLogger).child({ module: 'keyStore' });
  let probed: boolean | null = null;
  let probedAt = 0;
  let probing: Promise<boolean> | null = null;
  // One helper at a time: the calls are rare (start, pairing) and this keeps the machine quiet.
  let queue: Promise<unknown> = Promise.resolve();

  const run = (op: Operation, purpose: string, data: Buffer): Promise<Buffer> => {
    const next = queue.then(() => runHelper(spawn, timeoutMs, op, purpose, data));
    queue = next.catch(() => undefined);
    return next;
  };

  const ensureWindows = (): void => {
    if (platform !== 'win32') throw new KeyStoreError('unavailable', 'DPAPI needs Windows');
  };

  return {
    available() {
      if (platform !== 'win32') return Promise.resolve(false);
      if (probed === true) return Promise.resolve(true);
      if (probing !== null) return probing;
      if (probed === false && Date.now() - probedAt < PROBE_RETRY_MS) return Promise.resolve(false);
      const sample = randomBytes(16);
      probing = run('T', 'identity', sample)
        .then((out) => out.toString('ascii') === 'OK')
        .catch((error: unknown) => {
          log.warn(
            { reason: error instanceof KeyStoreError ? error.reason : 'failed' },
            'DPAPI key store not available',
          );
          return false;
        })
        .then((ok) => {
          sample.fill(0);
          probed = ok;
          probedAt = Date.now();
          probing = null;
          return ok;
        });
      return probing;
    },
    async protect(purpose: KeyPurpose, plaintext: Buffer) {
      ensureWindows();
      checkPurpose(purpose);
      if (plaintext.length === 0 || plaintext.length > KEY_STORE_MAX_PLAINTEXT) {
        throw new KeyStoreError('failed', 'invalid plaintext size');
      }
      const sealed = await run('P', purpose, plaintext);
      if (sealed.length === 0) throw new KeyStoreError('failed');
      return sealed;
    },
    async unprotect(purpose: KeyPurpose, ciphertext: Buffer) {
      ensureWindows();
      checkPurpose(purpose);
      if (ciphertext.length === 0 || ciphertext.length > MAX_OUTPUT_BYTES) {
        throw new KeyStoreError('failed', 'invalid ciphertext size');
      }
      return run('U', purpose, ciphertext);
    },
  };
}
