/**
 * Test support (WP-86, only imported by tests): a small synthetic release package, signed with a
 * key made for the test – no release-pack, no network (docs/wp/WP-83.md §12).
 */
import { createHash, generateKeyPairSync, sign, type KeyObject } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { hashFiles, walkPackage } from '../launcher/packageFiles';
import {
  AGENT_SDK_PACKAGE,
  RELEASE_FILE,
  RELEASE_SCHEMA_VERSION,
  RELEASE_SIGNATURE_FILE,
  type ReleaseInfo,
} from '../launcher/release';
import type { SdkRequest } from './install';

export interface TestKey {
  privateKey: KeyObject;
  /** JWK `x` (the form of `RELEASE_PUBLIC_KEYS`). */
  x: string;
}

export function makeTestKey(): TestKey {
  const { privateKey, publicKey } = generateKeyPairSync('ed25519');
  const jwk = publicKey.export({ format: 'jwk' });
  if (typeof jwk.x !== 'string') throw new Error('no x in the test key');
  return { privateKey, x: jwk.x };
}

export const TEST_SDK: ReleaseInfo['sdk'] = {
  name: AGENT_SDK_PACKAGE,
  version: '0.3.322',
  integrity: `sha512-${createHash('sha512').update('test sdk').digest('base64')}`,
};

export interface TestPackageOptions {
  version: string;
  key: TestKey;
  minNode?: string;
  /** Extra or replaced files (`/`-separated path → content). */
  files?: Record<string, string>;
}

export function testBuildId(version: string): string {
  return `${version}+test`;
}

/** Writes an unpacked, signed package into `dir` (created) and returns its release.json. */
export async function makeTestPackage(dir: string, options: TestPackageOptions): Promise<ReleaseInfo> {
  const files: Record<string, string> = {
    'dist/launcher.js': `// Parallax launcher, build ${testBuildId(options.version)}\n`,
    'dist/install.js': '// installer\n',
    'install.cmd': '@echo off\r\n',
    'parallax.ico': `icon ${options.version}`,
    'node_modules/zod/index.js': 'export {};\n',
    ...options.files,
  };
  for (const [rel, content] of Object.entries(files)) {
    const target = path.join(dir, ...rel.split('/'));
    await mkdir(path.dirname(target), { recursive: true });
    await writeFile(target, content);
  }
  const walk = await walkPackage(dir);
  const release: ReleaseInfo = {
    schemaVersion: RELEASE_SCHEMA_VERSION,
    name: 'parallax',
    version: options.version,
    commit: 'a'.repeat(40),
    buildId: testBuildId(options.version),
    minNode: options.minNode ?? '24.5.0',
    createdAt: '2026-11-17T09:00:00.000Z',
    schemas: { 'settings.json': 'b'.repeat(64) },
    sdk: TEST_SDK,
    files: await hashFiles(dir, walk.files),
  };
  const bytes = Buffer.from(`${JSON.stringify(release, null, 2)}\n`, 'utf8');
  await writeFile(path.join(dir, RELEASE_FILE), bytes);
  await writeFile(
    path.join(dir, RELEASE_SIGNATURE_FILE),
    `${sign(null, bytes, options.key.privateKey).toString('base64')}\n`,
  );
  return release;
}

/** A `provideSdk` that writes the SDK's package.json into the target (and records each request). */
export function fakeProvideSdk(requests: SdkRequest[]): (request: SdkRequest) => Promise<string> {
  return async (request) => {
    requests.push(request);
    await mkdir(request.target, { recursive: true });
    await writeFile(
      path.join(request.target, 'package.json'),
      JSON.stringify({ name: request.spec.name, version: request.spec.version }),
    );
    return 'test';
  };
}
