import type { ChildProcess } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { describe, expect, it } from 'vitest';
import { DPAPI_ARGS, DPAPI_SCRIPT, createDpapiKeyStore } from './keyStore';
import { createMemoryKeyStore } from './memoryKeyStore';
import { KeyStoreError } from './ports';

/** A fake helper process: records stdin, answers with `stdout` and `code` (or never). */
function fakeChild(answer: { stdout?: string; code?: number | null; hang?: boolean }) {
  const stdin = new PassThrough();
  const stdout = new PassThrough();
  const stderr = new PassThrough();
  const input: Buffer[] = [];
  const raw: Buffer[] = [];
  // Copied: the store zeroes its input buffer after the helper finished.
  stdin.on('data', (chunk: Buffer) => {
    raw.push(chunk);
    input.push(Buffer.from(chunk));
  });
  const child = Object.assign(new EventEmitter(), {
    stdin,
    stdout,
    stderr,
    pid: undefined,
    kill: () => true,
  });
  stdin.on('finish', () => {
    if (answer.hang === true) return;
    if (answer.stdout !== undefined) stdout.end(answer.stdout);
    else stdout.end();
    setImmediate(() => child.emit('close', answer.code ?? 0, null));
  });
  return { child: child as unknown as ChildProcess, input, raw };
}

async function failure(promise: Promise<unknown>): Promise<KeyStoreError> {
  try {
    await promise;
  } catch (error) {
    if (error instanceof KeyStoreError) return error;
    throw error;
  }
  throw new Error('expected a KeyStoreError');
}

describe('DPAPI key store – constant script (§B.5, §B.12 "Schlüsselspeicher")', () => {
  it('passes data never in arguments: the arguments are constant', () => {
    expect(DPAPI_ARGS.slice(0, 4)).toEqual(['-NoLogo', '-NoProfile', '-NonInteractive', '-EncodedCommand']);
    expect(Buffer.from(DPAPI_ARGS[4] ?? '', 'base64').toString('utf16le')).toBe(DPAPI_SCRIPT);
  });

  it('uses no cmdlet with data – the only cmdlet is Add-Type with a literal assembly', () => {
    const cmdlets = DPAPI_SCRIPT.match(/\b[A-Z][a-z]+-[A-Z][A-Za-z]+\b/gu) ?? [];
    expect(new Set(cmdlets)).toEqual(new Set(['Add-Type']));
    expect(DPAPI_SCRIPT).toMatch(/^\s*Add-Type -AssemblyName System\.Security$/mu);
    // No pipeline, no Write-*/Out-* host output, no string expansion of variables into commands.
    expect(DPAPI_SCRIPT).not.toMatch(/\|/u);
    expect(DPAPI_SCRIPT).not.toMatch(/\bWrite-|\bOut-|\bInvoke-|iex\b/iu);
    // Secrets only through .NET: stdin, base64, ProtectedData, stdout.
    expect(DPAPI_SCRIPT).toContain('[Console]::In.ReadToEnd()');
    expect(DPAPI_SCRIPT).toContain('[Console]::Out.Write(');
    expect(DPAPI_SCRIPT).toContain("'parallax-keystore-v1:' + $purpose");
    expect(DPAPI_SCRIPT).toContain('DataProtectionScope]::CurrentUser');
  });

  it('sends op, purpose and data only over stdin and decodes stdout', async () => {
    const fake = fakeChild({ stdout: Buffer.from('sealed').toString('base64') });
    const store = createDpapiKeyStore({ platform: 'win32', spawn: () => fake.child });
    const sealed = await store.protect('auth:peer', Buffer.from('secret-bytes'));
    expect(sealed.toString()).toBe('sealed');
    const lines = Buffer.concat(fake.input).toString('ascii').split('\n');
    expect(lines[0]).toBe('P');
    expect(Buffer.from(lines[1] ?? '', 'base64').toString()).toBe('auth:peer');
    expect(Buffer.from(lines[2] ?? '', 'base64').toString()).toBe('secret-bytes');
    // The input buffer (base64 of the secret) is overwritten after use.
    expect(fake.raw.every((chunk) => chunk.every((byte) => byte === 0))).toBe(true);
  });

  it.each([
    ['a non-zero exit', { code: 1 }, 'failed'],
    ['empty output', { stdout: '' }, 'failed'],
    ['garbage output', { stdout: 'not base64 !' }, 'failed'],
  ])('maps %s to KeyStoreError', async (_label, answer, reason) => {
    const store = createDpapiKeyStore({ platform: 'win32', spawn: () => fakeChild(answer).child });
    const error = await failure(store.unprotect('identity', Buffer.from('x')));
    expect(error.reason).toBe(reason);
    expect(error.message).not.toContain('x');
  });

  it('times out (the helper is killed) with KeyStoreError timeout', async () => {
    const store = createDpapiKeyStore({
      platform: 'win32',
      timeoutMs: 50,
      spawn: () => fakeChild({ hang: true }).child,
    });
    expect((await failure(store.protect('identity', Buffer.from('k')))).reason).toBe('timeout');
  });

  it('refuses invalid purposes and sizes before starting anything', async () => {
    let started = 0;
    const store = createDpapiKeyStore({
      platform: 'win32',
      spawn: () => {
        started += 1;
        return fakeChild({ stdout: 'AA==' }).child;
      },
    });
    expect((await failure(store.protect('coupling:Bad Id', Buffer.from('k')))).reason).toBe('failed');
    expect((await failure(store.protect('identity', Buffer.alloc(0)))).reason).toBe('failed');
    expect(started).toBe(0);
  });

  it('is unavailable outside Windows (never a clear-text fallback)', async () => {
    const store = createDpapiKeyStore({ platform: 'linux' });
    expect(await store.available()).toBe(false);
    expect((await failure(store.protect('identity', Buffer.from('k')))).reason).toBe('unavailable');
  });

  it('a failed probe means not available', async () => {
    const store = createDpapiKeyStore({ platform: 'win32', spawn: () => fakeChild({ code: 1 }).child });
    expect(await store.available()).toBe(false);
  });

  it.runIf(process.platform === 'win32')(
    'real DPAPI: round trip, purpose binding and tamper detection (no file involved)',
    async () => {
      const store = createDpapiKeyStore();
      expect(await store.available()).toBe(true);
      const secret = Buffer.from('parallax test secret 0123456789');
      const sealed = await store.protect('auth:peer', secret);
      expect(sealed.includes(secret)).toBe(false);
      expect((await store.unprotect('auth:peer', sealed)).equals(secret)).toBe(true);
      expect((await failure(store.unprotect('identity', sealed))).reason).toBe('failed');
      const tampered = Buffer.from(sealed);
      tampered[tampered.length - 3] = (tampered[tampered.length - 3] ?? 0) ^ 0x01;
      expect((await failure(store.unprotect('auth:peer', tampered))).reason).toBe('failed');
    },
    60_000,
  );
});

describe('memory key store (tests)', () => {
  it('round-trips per purpose, fails for foreign or tampered handles and holds no plaintext in the handle', async () => {
    const store = createMemoryKeyStore();
    const secret = Buffer.from('another secret');
    const sealed = await store.protect('identity', secret);
    expect(sealed.includes(secret)).toBe(false);
    expect((await store.unprotect('identity', sealed)).equals(secret)).toBe(true);
    expect((await failure(store.unprotect('coupling:x', sealed))).reason).toBe('failed');
    const tampered = Buffer.from(sealed);
    tampered[5] = (tampered[5] ?? 0) ^ 1;
    expect((await failure(store.unprotect('identity', tampered))).reason).toBe('failed');
    expect((await failure(createMemoryKeyStore().unprotect('identity', sealed))).reason).toBe('failed');
  });

  it('can be unavailable or fail once', async () => {
    const store = createMemoryKeyStore({ available: false });
    expect(await store.available()).toBe(false);
    expect((await failure(store.protect('identity', Buffer.from('k')))).reason).toBe('unavailable');
    store.setAvailable(true);
    store.failNext('timeout');
    expect((await failure(store.protect('identity', Buffer.from('k')))).reason).toBe('timeout');
    expect(await store.protect('identity', Buffer.from('k'))).toBeInstanceOf(Buffer);
  });
});
