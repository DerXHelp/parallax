/**
 * `CHANGELOG.md` tool (WP-85, docs/wp/WP-83.md §4.5). No dependencies besides the parser.
 *
 *   pnpm exec tsx --tsconfig tsconfig.tools.json scripts/release-notes.ts --check
 *       format check (also part of `pnpm test`: scripts/release/changelog.test.ts)
 *   … --extract <version|unreleased>
 *       prints the section as Markdown (release page, latest.json)
 *   … --check-tag <tag>
 *       CI: tag = "v" + package.json version, and that version has a non-empty section
 *
 * Exit: 0 = ok, 1 = format problem / missing section, 2 = usage error.
 */
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';
import { checkTag, findSection, parseChangelog, releaseSection } from './release/changelog';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

const argsSchema = z.discriminatedUnion('mode', [
  z.object({ mode: z.literal('check') }),
  z.object({ mode: z.literal('extract'), version: z.string().min(1) }),
  z.object({ mode: z.literal('check-tag'), tag: z.string().regex(/^v\d+\.\d+\.\d+(?:-rc\.\d+)?$/u) }),
]);

function parseArgs(argv: readonly string[]): z.infer<typeof argsSchema> {
  const [flag, value] = argv;
  if (flag === '--check' && argv.length === 1) return argsSchema.parse({ mode: 'check' });
  if (flag === '--extract' && argv.length === 2) return argsSchema.parse({ mode: 'extract', version: value });
  if (flag === '--check-tag' && argv.length === 2) return argsSchema.parse({ mode: 'check-tag', tag: value });
  throw new Error('usage: release-notes.ts --check | --extract <version|unreleased> | --check-tag <vX.Y.Z>');
}

async function main(argv: readonly string[]): Promise<number> {
  const args = parseArgs(argv);
  const changelog = parseChangelog(await readFile(path.join(repoRoot, 'CHANGELOG.md'), 'utf8'));
  if (changelog.errors.length > 0) {
    for (const error of changelog.errors) process.stderr.write(`CHANGELOG.md ${error}\n`);
    return 1;
  }
  if (args.mode === 'check') {
    process.stdout.write(`CHANGELOG.md ok (${String(changelog.sections.length)} section(s))\n`);
    return 0;
  }
  if (args.mode === 'extract') {
    const section =
      args.version === 'unreleased' ? findSection(changelog, null) : releaseSection(changelog, args.version);
    if (section === undefined || section.body.length === 0) {
      process.stderr.write(`CHANGELOG.md has no non-empty section for ${args.version}\n`);
      return 1;
    }
    process.stdout.write(`${section.body}\n`);
    return 0;
  }
  const pkg = z
    .object({ version: z.string() })
    .parse(JSON.parse(await readFile(path.join(repoRoot, 'package.json'), 'utf8')));
  const problems = checkTag(changelog, args.tag, pkg.version);
  for (const problem of problems) process.stderr.write(`${problem}\n`);
  return problems.length === 0 ? 0 : 1;
}

main(process.argv.slice(2)).then(
  (code) => {
    process.exitCode = code;
  },
  (error: unknown) => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 2;
  },
);
