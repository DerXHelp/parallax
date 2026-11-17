/**
 * Import guard of `release-pack` (WP-85, docs/wp/WP-83.md §5.2): every bare import of the bundles and
 * of the Agent SDK must resolve in the staged `node_modules`, so a missing package stops the release
 * and not the server on the user's machine. esbuild only parses here (bundle without writing,
 * packages external): its metafile lists static imports and `import('…')` with a fixed text.
 */
import { isBuiltin } from 'node:module';
import { build } from 'esbuild';

/** Imported through a variable (esbuild cannot see it): checked like a static import. */
export const DYNAMIC_IMPORTS: readonly string[] = [
  // src/server/lib/logger.ts loads the log rotation with `import(specifier)`.
  'pino-roll',
];

/** Never in a package, by design. */
export const OPTIONAL_IMPORTS: readonly { pattern: RegExp; reason: string }[] = [
  { pattern: /^pino-pretty$/u, reason: 'dev mode only (logger.ts, `--dev`)' },
  {
    pattern: /^@anthropic-ai\/claude-agent-sdk-/u,
    reason: 'platform binaries of the Agent SDK (never installed, Parallax uses the installed claude)',
  },
];

/** `@scope/name/sub` → `@scope/name`, `name/sub` → `name`. */
export function packageOfSpecifier(specifier: string): string {
  const parts = specifier.split('/');
  return specifier.startsWith('@') ? parts.slice(0, 2).join('/') : (parts[0] ?? specifier);
}

/** A bare package import (not relative, absolute, a URL or a Node builtin). */
export function isBareSpecifier(specifier: string): boolean {
  if (specifier === '' || specifier.startsWith('.') || specifier.startsWith('/')) return false;
  if (/^[A-Za-z][A-Za-z0-9+.-]*:/u.test(specifier)) return false; // node:, file:, data:, C:
  return !isBuiltin(specifier);
}

export function optionalReason(specifier: string): string | null {
  return OPTIONAL_IMPORTS.find((entry) => entry.pattern.test(specifier))?.reason ?? null;
}

/** Bare specifier → importing files (relative to `cwd`), from parsing `entryFiles` and what they import. */
export async function collectBareImports(
  entryFiles: readonly string[],
  cwd: string,
): Promise<Map<string, string[]>> {
  const result = await build({
    absWorkingDir: cwd,
    entryPoints: [...entryFiles],
    bundle: true,
    write: false,
    outdir: 'release-import-scan',
    platform: 'node',
    format: 'esm',
    packages: 'external',
    metafile: true,
    logLevel: 'silent',
  });
  const found = new Map<string, string[]>();
  for (const [file, input] of Object.entries(result.metafile.inputs)) {
    for (const item of input.imports) {
      if (item.external !== true || !isBareSpecifier(item.path)) continue;
      const list = found.get(item.path) ?? [];
      if (!list.includes(file)) list.push(file);
      found.set(item.path, list);
    }
  }
  return found;
}

/** Source of a throwaway module that resolves `specifiers` from its own folder and prints the failures. */
export function resolverSource(specifiers: readonly string[]): string {
  return [
    `const specifiers = ${JSON.stringify(specifiers)};`,
    'const missing = [];',
    'for (const specifier of specifiers) {',
    '  try {',
    '    import.meta.resolve(specifier);',
    '  } catch (error) {',
    "    missing.push([specifier, error && typeof error === 'object' && 'code' in error ? String(error.code) : String(error)]);",
    '  }',
    '}',
    'process.stdout.write(JSON.stringify(missing));',
    '',
  ].join('\n');
}
