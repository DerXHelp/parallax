/**
 * Public-repo check (WP-84): finds private data before it reaches the public repo.
 *
 *   pnpm exec tsx --tsconfig tsconfig.tools.json scripts/public-check.ts
 *       files of the working tree (the same scan as scripts/public-check/repo.test.ts)
 *   … scripts/public-check.ts --refs origin/main..HEAD
 *       what a push publishes: commit messages, author/committer addresses, branch and tag
 *       names, paths and every blob of the range (`--refs --all`: the whole history)
 *   --repo=<dir>    scan another repository (default: the current directory)
 *   --list=<file>   local list from another file (default: <git-common-dir>/public-check.local)
 *
 * Rules: scripts/public-check/rules.ts. Output names place and rule, never the matched text.
 * Exit: 0 = clean, 1 = findings, 2 = error.
 */
import path from 'node:path';
import { z } from 'zod';
import { formatFinding, loadContext, scanFiles, scanRange } from './public-check/scan';

const RANGE_ARG = /^(?:--all|--branches|--tags|[A-Za-z0-9._/~^@{}-]+(?:\.\.\.?[A-Za-z0-9._/~^@{}-]+)?)$/u;

const argsSchema = z.object({
  repo: z.string().min(1),
  list: z.string().min(1).optional(),
  range: z.array(z.string().regex(RANGE_ARG)).nullable(),
});
type Args = z.infer<typeof argsSchema>;

function parseArgs(argv: readonly string[]): Args {
  let repo = process.cwd();
  let list: string | undefined;
  let range: string[] | null = null;
  for (const arg of argv) {
    if (range !== null) {
      range.push(arg);
    } else if (arg === '--refs') {
      range = [];
    } else if (arg.startsWith('--repo=')) {
      repo = path.resolve(arg.slice('--repo='.length));
    } else if (arg.startsWith('--list=')) {
      list = path.resolve(arg.slice('--list='.length));
    } else {
      throw new Error(`public-check: unknown argument "${arg}"`);
    }
  }
  if (range !== null && range.length === 0)
    throw new Error('public-check: --refs needs a range (e.g. origin/main..HEAD)');
  return argsSchema.parse({ repo, list, range });
}

async function main(argv: readonly string[]): Promise<number> {
  const args = parseArgs(argv);
  const context = await loadContext(args.repo, args.list === undefined ? {} : { listFile: args.list });
  if (!context.hasPrivateList) {
    process.stdout.write('public-check: no local list found – general rules only\n');
  }
  const findings =
    args.range === null
      ? await scanFiles(args.repo, context)
      : await scanRange(args.repo, args.range, context);
  for (const finding of findings) process.stdout.write(`${formatFinding(finding)}\n`);
  process.stdout.write(`public-check: ${String(findings.length)} finding(s)\n`);
  return findings.length === 0 ? 0 : 1;
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
