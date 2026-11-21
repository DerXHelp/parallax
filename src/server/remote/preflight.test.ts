import { mkdtemp, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  multiHostPreflight,
  opensslSupported,
  readMultiHostRole,
  type MultiHostPreflightDeps,
} from './preflight';

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
    probe: () => Promise.resolve('ok'),
    // The Windows texts and checks unless a test says otherwise (WP-107: Linux has its own).
    platform: 'win32',
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
    const probe = vi.fn(() => Promise.resolve('ok' as const));
    const checks = await multiHostPreflight(
      deps({
        selfTest: () => Promise.resolve('handshake'),
        keyStoreAvailable: () => Promise.resolve(false),
        probe,
      }),
    );
    expect(checks.map((check) => [check.id, check.level])).toEqual([
      ['multihost-role', 'info'],
      ['multihost-tls', 'warn'],
      ['multihost-keystore', 'warn'],
    ]);
    expect(probe).not.toHaveBeenCalled();
  });

  it('role share: every check, the firewall only as a reminder; a missing key store or TLS fails', async () => {
    const ok = await multiHostPreflight(deps({ home: await home(share) }));
    expect(ok.map((check) => [check.id, check.level])).toEqual([
      ['multihost-role', 'ok'],
      ['multihost-tls', 'ok'],
      ['multihost-keystore', 'ok'],
      ['multihost-port', 'ok'],
      ['multihost-addresses', 'ok'],
      ['multihost-firewall', 'info'],
    ]);
    const bad = await multiHostPreflight(
      deps({
        home: await home(share),
        keyStoreAvailable: () => Promise.reject(new Error('x')),
        probe: () => Promise.resolve('bind'),
        addresses: () => [],
      }),
    );
    expect(Object.fromEntries(bad.map((check) => [check.id, check.level]))).toMatchObject({
      'multihost-keystore': 'fail',
      'multihost-port': 'fail',
      'multihost-addresses': 'warn',
      'multihost-firewall': 'info',
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

describe('multiHostPreflight on Linux (WP-107, §B.14)', () => {
  const linux = (overrides: Partial<MultiHostPreflightDeps> = {}) =>
    deps({ platform: 'linux', openssl: '3.5.4', keyStoreScheme: () => 'secret_service', ...overrides });

  it('OpenSSL 3.5 or newer is required (ML-KEM, ML-DSA)', async () => {
    expect(opensslSupported('3.5.0')).toBe(true);
    expect(opensslSupported('4.0.1')).toBe(true);
    expect(opensslSupported('3.4.9')).toBe(false);
    expect(opensslSupported('')).toBe(false);
    const ok = await multiHostPreflight(linux({ home: await home(share) }));
    expect(ok.map((check) => check.id)).toEqual([
      'multihost-role',
      'multihost-tls',
      'multihost-openssl',
      'multihost-keystore',
      'multihost-port',
      'multihost-addresses',
      'multihost-firewall',
    ]);
    const old = await multiHostPreflight(linux({ home: await home(share), openssl: '3.0.13' }));
    expect(old.find((check) => check.id === 'multihost-openssl')).toMatchObject({ level: 'fail' });
  });

  it('names the key store scheme; the file is a warning; none usable fails with the ways out', async () => {
    const keyring = await multiHostPreflight(linux({ home: await home(share) }));
    expect(keyring.find((check) => check.id === 'multihost-keystore')).toMatchObject({
      level: 'ok',
      detail: 'Secret Service (keyring) available',
    });
    const file = await multiHostPreflight(linux({ home: await home(share), keyStoreScheme: () => 'file' }));
    expect(file.find((check) => check.id === 'multihost-keystore')).toMatchObject({ level: 'warn' });
    const none = await multiHostPreflight(
      linux({ home: await home(share), keyStoreAvailable: () => Promise.resolve(false) }),
    );
    const check = none.find((item) => item.id === 'multihost-keystore');
    expect(check).toMatchObject({ level: 'fail' });
    expect(check?.hint).toMatch(/systemd-creds --user.*--key-store=file/);
  });

  it('the firewall hint speaks of ufw', async () => {
    const checks = await multiHostPreflight(linux({ home: await home(share) }));
    expect(checks.find((check) => check.id === 'multihost-firewall')?.hint).toMatch(
      /sudo ufw allow from <controlling computer> to any port 4713 proto tcp/,
    );
  });
});
