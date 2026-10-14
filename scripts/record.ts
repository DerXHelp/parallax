/**
 * `pnpm record <scenario>` – SDK fixture recorder (stub from WP-00, implemented in WP-01).
 *
 * Runs scripted scenarios against the installed `claude` (Haiku, mini prompts, scratch folder)
 * and writes sanitized message streams to test/fixtures/sdk/<scenario>.jsonl.
 * Raw recordings go to .recordings/ (git-ignored). Recordings from the work machine never
 * enter the repo. Starting a live `claude` requires an explicit WP permission.
 */
const scenario = process.argv[2];

process.stderr.write(
  `record: not implemented yet (WP-01)${scenario === undefined ? '' : `, scenario "${scenario}"`}\n`,
);
process.exitCode = 1;
