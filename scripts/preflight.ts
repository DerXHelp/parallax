/**
 * `pnpm preflight` – environment check (stub from WP-00, implemented in WP-11).
 *
 * Planned checks (docs/plan.md, "Paketmanager: pnpm 12"): Node version (warn < 22 or major != 26),
 * pnpm version, registry (`pnpm config get registry`), resolved `claude` path and version,
 * login status (`claude auth status`), Microsoft Edge available, all profiles.
 * Output stays English (see plan, UI language).
 */
const major = Number.parseInt(process.versions.node.split('.')[0] ?? '0', 10);

process.stdout.write(`parallax preflight (stub)\n`);
process.stdout.write(
  `  node ${process.versions.node}${major === 26 ? '' : '  [warn: Node 26 is the standard]'}\n`,
);
process.stdout.write(`  further checks follow in WP-11\n`);

if (major < 22) {
  process.exitCode = 1;
}
