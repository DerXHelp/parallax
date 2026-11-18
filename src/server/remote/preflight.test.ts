import { mkdtemp, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { multiHostPreflight, readMultiHostRole, type MultiHostPreflightDeps } from './preflight';

const dirs: string[] = [];

async function home(content?: string): Promise<string> {
  const dir = await mkdtemp(path.join(tmpdir(), 'parallax-test-preflight-'));
  dirs.push(dir);
  if (content !== undefined) await writeFile(path.join(dir, 'multi-host.json'), content);
  return dir;
}

afterEach(async () => {
  for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true });
});

const share = JSON.stringify({
  schemaVersion: 1,
  config: { role: 'share', port: 4713, bindAddress: '0.0.0.0' },
});

function deps(overrides: Partial<MultiHostPreflightDeps> = {}): MultiHostPreflightDeps {
  return {
    home: null,
    selfTest: () => Promise.resolve(null),
    keyStoreAvailable: () => Promise.resolve(true),
    addresses: () => ['192.0.2.20'],
    firewall: () => Promise.resolve({ kind: 'allowed' }),
    probe: () => Promise.resolve('ok'),
    ...overrides,
  };
}

describe('readMultiHostRole', () => {
  it('reads the role and never touches an unusable file', async () => {
    expect(await readMultiHostRole(await home())).toEqual({ kind: 'missing' });
    expect(await readMultiHostRole(await home(share))).toMatchObject({
      kind: 'file',
      config: { role: 'share' },
    });
    const broken = await home('{nope');
    expect(await readMultiHostRole(broken)).toEqual({ kind: 'unusable', reason: 'json' });
    expect(await readdir(broken)).toEqual(['multi-host.json']);
    expect(await readMultiHostRole(await home('{"schemaVersion":9}'))).toEqual({
      kind: 'unusable',
      reason: 'newer',
    });
    expect(await readMultiHostRole(await home('{"schemaVersion":1,"config":{"role":"x"}}'))).toEqual({
      kind: 'unusable',
      reason: 'schema',
    });
  });
});

describe('multiHostPreflight', () => {
  it('role off: TLS and key store only, problems are warnings', async () => {
    const firewall = vi.fn(() => Promise.resolve({ kind: 'allowed' as const }));
    const checks = await multiHostPreflight(
      deps({
        selfTest: () => Promise.resolve('handshake'),
        keyStoreAvailable: () => Promise.resolve(false),
        firewall,
      }),
    );
    expect(checks.map((check) => [check.id, check.level])).toEqual([
      ['multihost-role', 'info'],
      ['multihost-tls', 'warn'],
      ['multihost-keystore', 'warn'],
    ]);
    expect(firewall).not.toHaveBeenCalled();
  });

  it('role share: every check; a missing key store or TLS fails', async () => {
    const ok = await multiHostPreflight(deps({ home: await home(share) }));
    expect(ok.map((check) => [check.id, check.level])).toEqual([
      ['multihost-role', 'ok'],
      ['multihost-tls', 'ok'],
      ['multihost-keystore', 'ok'],
      ['multihost-port', 'ok'],
      ['multihost-addresses', 'ok'],
      ['multihost-firewall', 'ok'],
    ]);
    const bad = await multiHostPreflight(
      deps({
        home: await home(share),
        keyStoreAvailable: () => Promise.reject(new Error('x')),
        probe: () => Promise.resolve('bind'),
        addresses: () => [],
        firewall: () => Promise.resolve({ kind: 'no_rule' }),
      }),
    );
    expect(Object.fromEntries(bad.map((check) => [check.id, check.level]))).toMatchObject({
      'multihost-keystore': 'fail',
      'multihost-port': 'fail',
      'multihost-addresses': 'warn',
      'multihost-firewall': 'warn',
    });
  });

  it('a port in use is only a warning (this Parallax may be sharing right now)', async () => {
    const checks = await multiHostPreflight(
      deps({ home: await home(share), probe: () => Promise.resolve('port_in_use') }),
    );
    expect(checks.find((check) => check.id === 'multihost-port')).toMatchObject({ level: 'warn' });
  });

  it('an unusable file is a warning and counts as off', async () => {
    const checks = await multiHostPreflight(deps({ home: await home('{"schemaVersion":9}') }));
    expect(checks[0]).toMatchObject({ id: 'multihost-role', level: 'warn' });
    expect(checks).toHaveLength(3);
  });
});
