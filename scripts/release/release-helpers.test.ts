import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { isPrunable, isPrunableFolder } from './files';
import {
  collectBareImports,
  isBareSpecifier,
  optionalReason,
  packageOfSpecifier,
  resolverSource,
} from './imports';
import { lockedPackage } from './lockfile';
import {
  findPackageDirs,
  isAllowedLicense,
  packageRootOf,
  packageRootsOfSourceMap,
  readLicenseTexts,
  readPackageInfo,
  renderNotices,
} from './notices';

let dir = '';
beforeEach(async () => {
  dir = await mkdtemp(path.join(os.tmpdir(), 'parallax-pack-'));
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

async function put(rel: string, text: string): Promise<string> {
  const file = path.join(dir, ...rel.split('/'));
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, text);
  return file;
}

describe('isPrunableFolder', () => {
  it('drops test suites, CI setup and benchmarks of a package root, nothing else', () => {
    for (const name of ['test', 'tests', 'Test', '__tests__', '.github', 'benchmark', 'benchmarks']) {
      expect(isPrunableFolder(name), name).toBe(true);
    }
    for (const name of [
      'lib',
      'dist',
      'testing',
      'test-utils',
      'fixtures',
      'examples',
      'docs',
      'src',
      'bin',
    ]) {
      expect(isPrunableFolder(name), name).toBe(false);
    }
  });
});

describe('isPrunable', () => {
  it('drops types, TypeScript sources, source maps and docs, keeps code and license texts', () => {
    for (const name of [
      'index.d.ts',
      'index.d.mts',
      'x.d.cts',
      'client.ts',
      'x.mts',
      'index.js.map',
      'README.md',
      'CHANGELOG.markdown',
    ]) {
      expect(isPrunable(name), name).toBe(true);
    }
    for (const name of [
      'index.js',
      'index.mjs',
      'x.cjs',
      'package.json',
      'LICENSE.md',
      'NOTICE.md',
      'LICENSE',
      'schema.json',
    ]) {
      expect(isPrunable(name), name).toBe(false);
    }
  });
});

describe('lockedPackage', () => {
  const LOCK = [
    '---',
    "lockfileVersion: '9.0'",
    'importers:',
    '  .:',
    '    packageManagerDependencies: {}',
    'packages:',
    "  'tool@1.0.0':",
    '    resolution: {integrity: sha512-tool==}',
    '',
    '---',
    "lockfileVersion: '9.0'",
    'importers:',
    '  .:',
    '    dependencies:',
    "      '@scope/sdk':",
    '        specifier: 0.3.322',
    'packages:',
    '',
    "  '@scope/sdk@0.3.322':",
    '    resolution: {integrity: sha512-r88ij7R3+/AbC==}',
    "    engines: {node: '>=18'}",
    '',
    '  zod@4.6.7:',
    '    resolution: {integrity: sha512-zod/1=}',
    '',
    'snapshots:',
    '',
    "  '@scope/sdk@0.3.322':",
    '    resolution: {integrity: sha512-not-here}',
    '',
  ].join('\n');

  it('reads version and integrity from the project document', () => {
    expect(lockedPackage(LOCK, '@scope/sdk')).toEqual({
      name: '@scope/sdk',
      version: '0.3.322',
      integrity: 'sha512-r88ij7R3+/AbC==',
    });
    expect(lockedPackage(LOCK.replace(/\n/gu, '\r\n'), 'zod').version).toBe('4.6.7');
  });

  it('refuses a missing package and one of the pnpm document', () => {
    expect(() => lockedPackage(LOCK, 'tool')).toThrow(/not in the packages: section/);
    expect(() => lockedPackage(LOCK, 'other')).toThrow(/not in the packages: section/);
  });

  it('refuses two locked versions', () => {
    const twice = LOCK.replace(
      '  zod@4.6.7:',
      "  '@scope/sdk@0.4.0':\n    resolution: {integrity: sha512-b==}\n\n  zod@4.6.7:",
    );
    expect(() => lockedPackage(twice, '@scope/sdk')).toThrow(/2 versions/);
  });

  it('finds the Agent SDK in the real lockfile', async () => {
    const { readFile } = await import('node:fs/promises');
    const text = await readFile(path.resolve(import.meta.dirname, '..', '..', 'pnpm-lock.yaml'), 'utf8');
    expect(lockedPackage(text, '@anthropic-ai/claude-agent-sdk').integrity).toMatch(/^sha512-/);
  });
});

describe('import guard helpers', () => {
  it('classifies specifiers', () => {
    expect(packageOfSpecifier('zod/v4/core')).toBe('zod');
    expect(packageOfSpecifier('@fastify/static')).toBe('@fastify/static');
    expect(packageOfSpecifier('@modelcontextprotocol/sdk/server/mcp.js')).toBe('@modelcontextprotocol/sdk');
    for (const builtin of ['fs', 'fs/promises', 'node:path', 'path/win32', 'node:test']) {
      expect(isBareSpecifier(builtin), builtin).toBe(false);
    }
    for (const local of ['./x.js', '../y', '/abs', 'file:///x', 'data:text/javascript,']) {
      expect(isBareSpecifier(local), local).toBe(false);
    }
    expect(isBareSpecifier('pino')).toBe(true);
    expect(optionalReason('pino-pretty')).toMatch(/dev mode/);
    expect(optionalReason('@anthropic-ai/claude-agent-sdk-win32-x64')).toMatch(/platform binaries/);
    expect(optionalReason('pino')).toBeNull();
  });

  it('collects static, re-exported and literal dynamic imports through relative files', async () => {
    await put(
      'entry.mjs',
      "import a from 'pkg-a';\nimport './local.mjs';\nexport * from 'pkg-b/sub';\nimport('node:fs');\n",
    );
    await put(
      'local.mjs',
      "const m = await import('pkg-c');\nconst name = 'pkg-d';\nawait import(name);\nexport default m;\n",
    );
    const found = await collectBareImports(['entry.mjs'], dir);
    expect([...found.keys()].sort()).toEqual(['pkg-a', 'pkg-b/sub', 'pkg-c']);
    expect(found.get('pkg-c')).toEqual(['local.mjs']);
  });

  it('builds a resolver module that reports missing packages', () => {
    const source = resolverSource(['zod', 'missing-pkg']);
    expect(source).toContain('["zod","missing-pkg"]');
    expect(source).toContain('import.meta.resolve(specifier)');
  });
});

describe('notices', () => {
  it('accepts permissive SPDX expressions only', () => {
    expect(isAllowedLicense('MIT')).toBe(true);
    expect(isAllowedLicense('(MIT OR GPL-3.0)')).toBe(true);
    expect(isAllowedLicense('MIT AND BSD-3-Clause')).toBe(true);
    expect(isAllowedLicense('MIT AND GPL-3.0')).toBe(false);
    expect(isAllowedLicense('GPL-3.0')).toBe(false);
    expect(isAllowedLicense('UNKNOWN')).toBe(false);
  });

  it('finds package roots in pnpm and flat layouts', () => {
    expect(packageRootOf('C:/r/node_modules/.pnpm/react@19.3.1/node_modules/react/cjs/x.js')).toBe(
      'C:/r/node_modules/.pnpm/react@19.3.1/node_modules/react',
    );
    expect(packageRootOf('C:\\r\\node_modules\\@radix-ui\\react-dialog\\dist\\index.mjs')).toBe(
      'C:/r/node_modules/@radix-ui/react-dialog',
    );
    expect(packageRootOf('C:/r/src/web/App.tsx')).toBeNull();
    expect(packageRootOf('C:/r/node_modules/.pnpm/x')).toBeNull();
    const roots = packageRootsOfSourceMap(
      path.join(dir, 'dist', 'web', 'assets', 'index.js.map'),
      JSON.stringify({
        sources: [
          '../../../node_modules/.pnpm/a@1/node_modules/a/index.js',
          '../../../src/web/main.tsx',
          '../../../node_modules/.pnpm/a@1/node_modules/a/b.js',
        ],
      }),
    );
    expect(roots).toEqual([path.join(dir, 'node_modules', '.pnpm', 'a@1', 'node_modules', 'a')]);
  });

  it('reads package folders, license fields and license files', async () => {
    await put('node_modules/a/package.json', JSON.stringify({ name: 'a', version: '1.0.0', license: 'MIT' }));
    await put('node_modules/a/LICENSE', 'MIT text\n');
    await put('node_modules/a/NOTICE.md', 'notice\n');
    await put('node_modules/a/license-checker.js', 'not a license');
    await put(
      'node_modules/@s/b/package.json',
      JSON.stringify({ name: '@s/b', version: '2.0.0', license: { type: 'ISC' } }),
    );
    await put(
      'node_modules/@s/b/node_modules/c/package.json',
      JSON.stringify({ name: 'c', version: '3.0.0', licenses: [{ type: 'MIT' }, { type: 'Apache-2.0' }] }),
    );
    await mkdir(path.join(dir, 'node_modules', '.bin'));
    const dirs = await findPackageDirs(path.join(dir, 'node_modules'));
    expect(dirs.map((d) => path.relative(dir, d).replace(/\\/gu, '/'))).toEqual([
      'node_modules/@s/b',
      'node_modules/@s/b/node_modules/c',
      'node_modules/a',
    ]);
    const infos = await Promise.all(dirs.map((d) => readPackageInfo(d, 'server')));
    expect(infos.map((info) => info.license)).toEqual(['ISC', 'MIT OR Apache-2.0', 'MIT']);
    expect(await readLicenseTexts(path.join(dir, 'node_modules', 'a'))).toEqual([
      { file: 'LICENSE', text: 'MIT text' },
      { file: 'NOTICE.md', text: 'notice' },
    ]);
  });

  it('renders a German overview with fenced license texts', () => {
    const text = renderNotices({
      version: '1.0.0',
      packages: [
        { name: 'b', version: '1.0.0', license: 'ISC', dir: '', parts: new Set(['web']), texts: [] },
        {
          name: 'a',
          version: '2.0.0',
          license: 'MIT',
          dir: '',
          parts: new Set(['server', 'web']),
          texts: [{ file: 'LICENSE', text: 'has ``` inside' }],
        },
      ],
      sdk: { version: '0.3.322', licenseText: '© Anthropic PBC. All rights reserved.' },
    });
    expect(text).toContain('# Third-party notices');
    expect(text).toContain('`@anthropic-ai/claude-agent-sdk` 0.3.322 ist proprietär');
    expect(text).toContain('| `a` | 2.0.0 | MIT | Server (node_modules), Web-Oberfläche (dist/web) |');
    expect(text.indexOf('## a 2.0.0')).toBeLessThan(text.indexOf('## b 1.0.0'));
    expect(text).toContain('````text\nhas ``` inside\n````');
    expect(text).toContain('Das Paket enthält keine Lizenzdatei.');
  });
});
