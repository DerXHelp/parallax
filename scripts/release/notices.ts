/**
 * `THIRD_PARTY_NOTICES.md` of a release package (WP-85, docs/wp/WP-83.md §5.1): name, version,
 * license and the license/NOTICE files of every third-party package in the package – the server
 * runtime (`node_modules`) and what Vite bundled into `dist/web` (found via the source maps; CSS and
 * fonts via WEB_ASSET_PACKAGES). Only permissive licenses pass; anything else stops the release.
 */
import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { z } from 'zod';

export type PackagePart = 'server' | 'web';

/** Bundled into dist/web, but not visible in the JS source maps (CSS imports and font files). */
export const WEB_ASSET_PACKAGES: readonly string[] = [
  '@fontsource-variable/inter',
  '@fontsource-variable/jetbrains-mono',
  'tailwindcss',
  'tw-animate-css',
];

/** SPDX ids that may be shipped (permissive; OFL for the fonts). */
export const ALLOWED_LICENSES: ReadonlySet<string> = new Set([
  '0BSD',
  'Apache-2.0',
  'BlueOak-1.0.0',
  'BSD-2-Clause',
  'BSD-3-Clause',
  'CC0-1.0',
  'ISC',
  'MIT',
  'OFL-1.1',
  'Python-2.0',
  'Unlicense',
]);

const LICENSE_FILE = /^(?:licen[cs]e|copying|notice)(?:[-._][\w.-]*)?$/iu;
/** `license-checker.js` or `license.d.ts` are code, not texts. */
const CODE_FILE = /\.(?:[cm]?[jt]s|json|map)$/iu;

const packageJsonSchema = z.looseObject({
  name: z.string().min(1),
  version: z.string().min(1),
  license: z.union([z.string(), z.looseObject({ type: z.string() })]).optional(),
  licenses: z.array(z.looseObject({ type: z.string() })).optional(),
});

/** LICENSE, LICENSE.md, LICENSE-MIT.txt, COPYING, NOTICE … - not `license-checker.js`. */
export function isLicenseFileName(name: string): boolean {
  return LICENSE_FILE.test(name) && !CODE_FILE.test(name);
}

export interface PackageInfo {
  name: string;
  version: string;
  license: string;
  dir: string;
  parts: Set<PackagePart>;
}

export interface LicenseText {
  file: string;
  text: string;
}

/** `(MIT OR Apache-2.0)`: one allowed alternative is enough; `A AND B`: both must be allowed. */
export function isAllowedLicense(expression: string): boolean {
  const alternatives = expression.replace(/[()]/gu, ' ').split(/\s+OR\s+/u);
  return alternatives.some((alternative) =>
    alternative
      .split(/\s+AND\s+/u)
      .map((id) => id.trim())
      .every((id) => ALLOWED_LICENSES.has(id)),
  );
}

export async function readPackageInfo(dir: string, part: PackagePart): Promise<PackageInfo> {
  const json = packageJsonSchema.parse(JSON.parse(await readFile(path.join(dir, 'package.json'), 'utf8')));
  const license =
    typeof json.license === 'string'
      ? json.license
      : (json.license?.type ?? json.licenses?.map((item) => item.type).join(' OR ') ?? 'UNKNOWN');
  return { name: json.name, version: json.version, license, dir, parts: new Set([part]) };
}

/** Package folders below `nodeModules` (also nested `node_modules`), skipping dot entries like `.bin`. */
export async function findPackageDirs(nodeModules: string): Promise<string[]> {
  const dirs: string[] = [];
  const visit = async (folder: string): Promise<void> => {
    let entries;
    try {
      entries = await readdir(folder, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (!entry.isDirectory() || entry.name.startsWith('.')) continue;
      const full = path.join(folder, entry.name);
      if (entry.name.startsWith('@')) {
        for (const scoped of await readdir(full, { withFileTypes: true })) {
          if (scoped.isDirectory()) {
            dirs.push(path.join(full, scoped.name));
            await visit(path.join(full, scoped.name, 'node_modules'));
          }
        }
      } else {
        dirs.push(full);
        await visit(path.join(full, 'node_modules'));
      }
    }
  };
  await visit(nodeModules);
  return dirs.sort();
}

/** Package root of a file inside a `node_modules` folder (`…/node_modules/@s/n/x.js` → `…/node_modules/@s/n`). */
export function packageRootOf(file: string): string | null {
  const normalized = file.replace(/\\/gu, '/');
  const marker = '/node_modules/';
  // The LAST node_modules segment wins (`.pnpm/x@1/node_modules/x/...`).
  const last = normalized.lastIndexOf(marker);
  if (last === -1) return null;
  const rest = normalized.slice(last + marker.length).split('/');
  const count = rest[0]?.startsWith('@') === true ? 2 : 1;
  const name = rest.slice(0, count);
  if (name.length < count || name.some((part) => part === '' || part.startsWith('.'))) return null;
  return `${normalized.slice(0, last)}${marker}${name.join('/')}`;
}

const sourceMapSchema = z.looseObject({ sources: z.array(z.string()) });

/** Package roots referenced by the `sources` of a source map at `mapFile`. */
export function packageRootsOfSourceMap(mapFile: string, text: string): string[] {
  const map = sourceMapSchema.parse(JSON.parse(text));
  const roots = new Set<string>();
  for (const source of map.sources) {
    const root = packageRootOf(path.resolve(path.dirname(mapFile), source));
    if (root !== null) roots.add(path.normalize(root));
  }
  return [...roots].sort();
}

export async function readLicenseTexts(dir: string): Promise<LicenseText[]> {
  const names = (await readdir(dir, { withFileTypes: true }))
    .filter((entry) => entry.isFile() && isLicenseFileName(entry.name))
    .map((entry) => entry.name)
    .sort();
  const texts: LicenseText[] = [];
  for (const file of names) texts.push({ file, text: (await readFile(path.join(dir, file), 'utf8')).trim() });
  return texts;
}

function fence(text: string): string {
  const longest = Math.max(2, ...[...text.matchAll(/`+/gu)].map((match) => match[0].length));
  const marks = '`'.repeat(longest + 1);
  return `${marks}text\n${text}\n${marks}`;
}

const PART_LABEL: Record<PackagePart, string> = {
  server: 'Server (node_modules)',
  web: 'Web-Oberfläche (dist/web)',
};

export interface NoticesInput {
  version: string;
  packages: readonly (PackageInfo & { texts: readonly LicenseText[] })[];
  sdk: { version: string; licenseText: string | null };
}

export function renderNotices(input: NoticesInput): string {
  const packages = [...input.packages].sort((a, b) =>
    a.name === b.name ? (a.version < b.version ? -1 : 1) : a.name < b.name ? -1 : 1,
  );
  const lines = [
    '# Third-party notices',
    '',
    `Parallax ${input.version} enthält die folgenden Komponenten Dritter. Parallax selbst steht unter der`,
    'MIT-Lizenz (`LICENSE`).',
    '',
    '## Nicht enthalten: Claude Agent SDK',
    '',
    `\`@anthropic-ai/claude-agent-sdk\` ${input.sdk.version} ist proprietär und liegt dem Paket nicht bei. Die`,
    'Installation lädt es aus der npm-Registry und prüft es gegen die `integrity` aus `release.json`. Für seine',
    'Nutzung gelten die Bedingungen von Anthropic:',
    '',
    ...(input.sdk.licenseText === null ? ['(LICENSE.md des Pakets)'] : [fence(input.sdk.licenseText)]),
    '',
    '## Übersicht',
    '',
    '| Paket | Version | Lizenz | Teil |',
    '|---|---|---|---|',
    ...packages.map(
      (item) =>
        `| \`${item.name}\` | ${item.version} | ${item.license} | ${[...item.parts]
          .sort()
          .map((part) => PART_LABEL[part])
          .join(', ')} |`,
    ),
    '',
  ];
  for (const item of packages) {
    lines.push(`## ${item.name} ${item.version}`, '', `Lizenz: ${item.license}`, '');
    if (item.texts.length === 0) lines.push('Das Paket enthält keine Lizenzdatei.', '');
    for (const text of item.texts) lines.push(`\`${text.file}\`:`, '', fence(text.text), '');
  }
  return `${lines.join('\n').trimEnd()}\n`;
}
