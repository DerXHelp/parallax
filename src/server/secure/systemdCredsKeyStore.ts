/**
 * Key store `systemd-creds --user` (docs/wp/WP-76.md §B.14, Linux without a desktop from Ubuntu 26.04 –
 * systemd ≥ 256; on 24.04 the option does not exist, WP-101 §1.8). "Protected" = the output of
 * `systemd-creds encrypt --user --name=parallax-<purpose> - -`; the credential is bound to this machine
 * and user (TPM when present). Started without a shell from the absolute `/usr/bin/systemd-creds`; the
 * plaintext travels only over stdin/stdout, never as an argument or in the environment. Neither input
 * nor output is ever logged; a failure says only its kind.
 */
import { randomBytes } from 'node:crypto';
import type { Logger } from 'pino';
import { logger as rootLogger } from '../lib/logger';
import { spawnHidden, systemTool } from '../lib/process';
import { KEY_PURPOSE_PATTERN, KEY_STORE_MAX_PLAINTEXT } from './keyStore';
import { KeyStoreError, type KeyPurpose, type KeyStore } from './ports';

/** One call of the tool with stdin; never throws (a spawn failure is `exitCode: null`). */
export interface CredsRunResult {
  exitCode: number | null;
  stdout: Buffer;
  timedOut: boolean;
}

export type CredsRunner = (
  args: readonly string[],
  input: Buffer,
  timeoutMs: number,
) => Promise<CredsRunResult>;

/** Longest a call may take (the TPM can be slow; a hanging tool must not hold the pairing). */
export const SYSTEMD_CREDS_TIMEOUT_MS = 15_000;
/** Largest output read (credentials are a few KiB). */
const MAX_OUTPUT_BYTES = 512 * 1024;
const PROBE_RETRY_MS = 60_000;

/** The credential name of a purpose (`coupling:<hostId>` → `parallax-coupling-<hostId>`). */
export function credentialName(purpose: KeyPurpose): string {
  return `parallax-${purpose.replace(':', '-')}`;
}

/** Runs `/usr/bin/systemd-creds` with `input` on stdin (default runner). */
export function runSystemdCreds(
  args: readonly string[],
  input: Buffer,
  timeoutMs: number,
): Promise<CredsRunResult> {
  return new Promise((resolve) => {
    const chunks: Buffer[] = [];
    let size = 0;
    let done = false;
    let timedOut = false;
    const finish = (exitCode: number | null): void => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      const stdout = Buffer.concat(chunks);
      for (const chunk of chunks) chunk.fill(0);
      resolve({ exitCode, stdout, timedOut });
    };
    let child: ReturnType<typeof spawnHidden>;
    try {
      child = spawnHidden(systemTool('systemd-creds'), args, {
        stdio: ['pipe', 'pipe', 'pipe'],
        // stderr is consumed by spawnHidden; nothing of it is logged (it may echo names only).
        onStderr: () => undefined,
      });
    } catch {
      resolve({ exitCode: null, stdout: Buffer.alloc(0), timedOut: false });
      return;
    }
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill('SIGKILL');
      finish(null);
    }, timeoutMs);
    timer.unref();
    child.on('error', () => {
      finish(null);
    });
    child.stdout?.on('data', (chunk: Buffer) => {
      size += chunk.length;
      if (size > MAX_OUTPUT_BYTES) {
        child.kill('SIGKILL');
        finish(null);
        return;
      }
      chunks.push(chunk);
    });
    child.on('close', (code) => {
      finish(code);
    });
    child.stdin?.on('error', () => undefined);
    child.stdin?.end(input);
  });
}

export interface SystemdCredsKeyStoreOptions {
  platform?: NodeJS.Platform;
  run?: CredsRunner;
  timeoutMs?: number;
  logger?: Logger;
}

function checkPurpose(purpose: string): void {
  if (!KEY_PURPOSE_PATTERN.test(purpose)) throw new KeyStoreError('failed', 'invalid key purpose');
}

/** `systemd-creds --user` (Linux; elsewhere `available()` is false and every call fails). */
export function createSystemdCredsKeyStore(options: SystemdCredsKeyStoreOptions = {}): KeyStore {
  const usable = (options.platform ?? process.platform) === 'linux';
  const run = options.run ?? runSystemdCreds;
  const timeoutMs = options.timeoutMs ?? SYSTEMD_CREDS_TIMEOUT_MS;
  const log = (options.logger ?? rootLogger).child({ module: 'keyStore.systemdCreds' });
  let probed: boolean | null = null;
  let probedAt = 0;

  const call = async (op: 'encrypt' | 'decrypt', purpose: KeyPurpose, data: Buffer): Promise<Buffer> => {
    if (!usable) throw new KeyStoreError('unavailable', 'systemd-creds is not available here');
    checkPurpose(purpose);
    const result = await run([op, '--user', `--name=${credentialName(purpose)}`, '-', '-'], data, timeoutMs);
    if (result.timedOut) throw new KeyStoreError('timeout');
    if (result.exitCode !== 0 || result.stdout.length === 0) {
      result.stdout.fill(0);
      throw new KeyStoreError(result.exitCode === null ? 'unavailable' : 'failed');
    }
    return result.stdout;
  };

  const guarded = async (fn: () => Promise<Buffer>): Promise<Buffer> => {
    try {
      return await fn();
    } catch (error) {
      throw error instanceof KeyStoreError ? error : new KeyStoreError('failed');
    }
  };

  return {
    scheme: 'systemd_creds',
    async available() {
      if (probed === true) return true;
      if (probed === false && Date.now() - probedAt < PROBE_RETRY_MS) return false;
      const sample = randomBytes(16);
      let ok = false;
      try {
        const sealed = await call('encrypt', 'identity', sample);
        const back = await call('decrypt', 'identity', sealed);
        ok = back.equals(sample);
        back.fill(0);
      } catch (error) {
        log.info(
          { reason: error instanceof KeyStoreError ? error.reason : 'failed' },
          'systemd-creds --user not usable',
        );
      } finally {
        sample.fill(0);
      }
      probed = ok;
      probedAt = Date.now();
      return ok;
    },
    protect: (purpose, plaintext) =>
      guarded(() => {
        if (plaintext.length === 0 || plaintext.length > KEY_STORE_MAX_PLAINTEXT) {
          throw new KeyStoreError('failed', 'invalid plaintext size');
        }
        return call('encrypt', purpose, plaintext);
      }),
    unprotect: (purpose, ciphertext) =>
      guarded(() => {
        if (ciphertext.length === 0 || ciphertext.length > MAX_OUTPUT_BYTES) {
          throw new KeyStoreError('failed', 'invalid ciphertext size');
        }
        return call('decrypt', purpose, ciphertext);
      }),
  };
}
