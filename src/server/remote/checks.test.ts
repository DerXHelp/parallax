import { createServer, type AddressInfo } from 'node:net';
import { describe, expect, it } from 'vitest';
import { REMOTE_ACCESS_CHECK_IDS } from '@shared/model';
import type { RunFileFn, RunFileResult } from '../lib/process';
import { generateIdentity } from '../secure/identity';
import { createMemoryKeyStore } from '../secure/memoryKeyStore';
import { KeyStoreError } from '../secure/ports';
import { TEST_HOST } from '../secure/testKit';
import { probePort, runRemoteChecks, type RemoteCheckDeps } from './checks';
import { FIREWALL_PROGRAM_ENV, FIREWALL_SCRIPT, checkFirewall, firewallArgs } from './firewall';

function result(stdout: string, exitCode = 0, timedOut = false): RunFileResult {
  return { exitCode, signal: null, stdout, stderr: '', timedOut };
}

describe('firewall check (read only)', () => {
  it('the constant script only reads (Get-* cmdlets), the program travels in the environment', () => {
    const cmdlets = [...FIREWALL_SCRIPT.matchAll(/\b([A-Z][a-z]+-[A-Z][A-Za-z]+)\b/gu)].map(
      (match) => match[1],
    );
    expect(new Set(cmdlets)).toEqual(
      new Set(['Get-NetFirewallApplicationFilter', 'Get-NetFirewallRule', 'Where-Object']),
    );
    expect(FIREWALL_SCRIPT).not.toMatch(/\b(?:Set|New|Remove|Enable|Disable|Add|Copy|Rename)-NetFirewall/iu);
    expect(FIREWALL_SCRIPT).not.toMatch(/netsh/iu);
    const args = firewallArgs();
    expect(args.slice(0, 4)).toEqual(['-NoLogo', '-NoProfile', '-NonInteractive', '-EncodedCommand']);
    expect(Buffer.from(args[4] ?? '', 'base64').toString('utf16le')).toBe(FIREWALL_SCRIPT);
  });

  it('maps the counts; failures are `unknown`, never an exception', async () => {
    const calls: { file: string; env: Record<string, string> | undefined }[] = [];
    const run =
      (answer: RunFileResult | Error): RunFileFn =>
      (file, _args, options) => {
        calls.push({ file, env: options.env });
        return answer instanceof Error ? Promise.reject(answer) : Promise.resolve(answer);
      };
    const base = {
      platform: 'win32' as const,
      program: 'C:\\Program Files\\nodejs\\node.exe',
      env: { SystemRoot: 'C:\\Windows' },
    };
    expect(await checkFirewall({ ...base, run: run(result('1 0')) })).toEqual({ kind: 'allowed' });
    expect(await checkFirewall({ ...base, run: run(result('2 1')) })).toEqual({ kind: 'blocked' });
    expect(await checkFirewall({ ...base, run: run(result('0 0')) })).toEqual({ kind: 'no_rule' });
    expect(await checkFirewall({ ...base, run: run(result('', 2)) })).toEqual({ kind: 'unknown' });
    expect(await checkFirewall({ ...base, run: run(result('1 0', 0, true)) })).toEqual({ kind: 'unknown' });
    expect(await checkFirewall({ ...base, run: run(result('garbage')) })).toEqual({ kind: 'unknown' });
    expect(await checkFirewall({ ...base, run: run(new Error('spawn failed')) })).toEqual({
      kind: 'unknown',
    });
    expect(await checkFirewall({ platform: 'linux', run: run(result('1 0')) })).toEqual({ kind: 'unknown' });
    expect(calls[0]?.file.toLowerCase()).toBe(
      'c:\\windows\\system32\\windowspowershell\\v1.0\\powershell.exe',
    );
    expect(calls[0]?.env?.[FIREWALL_PROGRAM_ENV]).toBe(base.program);
  });
});

function deps(overrides: Partial<RemoteCheckDeps> = {}): RemoteCheckDeps {
  return {
    bindAddress: TEST_HOST,
    port: 0,
    ownListener: false,
    keyStore: createMemoryKeyStore(),
    identity: () => Promise.resolve(generateIdentity('identity')),
    selfTest: () => Promise.resolve(null),
    addresses: () => ['10.0.0.5'],
    firewall: () => Promise.resolve({ kind: 'allowed' }),
    probe: () => Promise.resolve('ok'),
    ...overrides,
  };
}

describe('checks when sharing is switched on (§4.2, §B.11)', () => {
  it('all fine → every check ok, in the order of REMOTE_ACCESS_CHECK_IDS, with the identity', async () => {
    const outcome = await runRemoteChecks(deps());
    expect(outcome.checks.map((check) => check.id)).toEqual([...REMOTE_ACCESS_CHECK_IDS]);
    expect(outcome.checks.every((check) => check.status === 'ok')).toBe(true);
    expect(outcome.identity?.purpose).toBe('identity');
    expect(outcome.error).toBeNull();
  });

  it('missing key store → keystore/keys error and REMOTE_KEYSTORE_UNAVAILABLE (no key is created)', async () => {
    let created = 0;
    const outcome = await runRemoteChecks(
      deps({
        keyStore: createMemoryKeyStore({ available: false }),
        identity: () => {
          created += 1;
          return Promise.resolve(generateIdentity('identity'));
        },
      }),
    );
    expect(created).toBe(0);
    expect(outcome.error?.code).toBe('REMOTE_KEYSTORE_UNAVAILABLE');
    expect(outcome.checks.find((check) => check.id === 'keystore')?.status).toBe('error');
    expect(outcome.checks.find((check) => check.id === 'keys')).toMatchObject({
      status: 'error',
      params: { reason: 'keystore' },
    });
  });

  it('a failing self-test → tls error and REMOTE_ACCESS_FAILED tls_unsupported', async () => {
    const outcome = await runRemoteChecks(deps({ selfTest: () => Promise.resolve('handshake') }));
    expect(outcome.error).toMatchObject({
      code: 'REMOTE_ACCESS_FAILED',
      params: { reason: 'tls_unsupported' },
    });
    expect(outcome.checks.find((check) => check.id === 'tls')).toMatchObject({
      status: 'error',
      params: { step: 'handshake' },
    });
  });

  it('port in use, key store failure while loading, no addresses, no firewall rule', async () => {
    const outcome = await runRemoteChecks(
      deps({
        probe: () => Promise.resolve('port_in_use'),
        identity: () => Promise.reject(new KeyStoreError('timeout')),
        addresses: () => [],
        firewall: () => Promise.resolve({ kind: 'no_rule' }),
      }),
    );
    const byId = Object.fromEntries(outcome.checks.map((check) => [check.id, check]));
    expect(byId.port).toMatchObject({ status: 'error', params: { reason: 'port_in_use' } });
    expect(byId.keys).toMatchObject({ status: 'error', params: { reason: 'keystore' } });
    expect(byId.addresses).toMatchObject({ status: 'warning', params: { count: 0 } });
    expect(byId.firewall).toMatchObject({ status: 'warning', params: { reason: 'no_rule' } });
    expect(outcome.error?.code).toBe('REMOTE_KEYSTORE_UNAVAILABLE');
  });

  it('the own running listener counts as a free port (no probe)', async () => {
    let probed = 0;
    const outcome = await runRemoteChecks(
      deps({
        ownListener: true,
        probe: () => {
          probed += 1;
          return Promise.resolve('port_in_use');
        },
      }),
    );
    expect(probed).toBe(0);
    expect(outcome.checks[0]?.status).toBe('ok');
  });

  it('probePort sees a taken port on 127.0.0.1', async () => {
    const server = createServer();
    await new Promise<void>((resolve) => server.listen({ host: TEST_HOST, port: 0 }, resolve));
    const { port } = server.address() as AddressInfo;
    try {
      expect(await probePort(TEST_HOST, port)).toBe('port_in_use');
    } finally {
      await new Promise<void>((resolve) =>
        server.close(() => {
          resolve();
        }),
      );
    }
    expect(await probePort(TEST_HOST, port)).toBe('ok');
  });
});
