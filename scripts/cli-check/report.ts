/**
 * Step 5 of `pnpm cli-check` (WP-62): the run record (`test-results/cli-check/last-run.json`, read
 * again by `--last`), the Markdown report, the console summary, the exit code and the protocol line
 * of `--accept` (`docs/cli-updates.md`). Pure, tested.
 *
 * Exit codes: 0 = green (no deviation), 1 = deviations, 2 = error/abort (pre-check, guard, budget,
 * crash).
 */
import { z } from 'zod';
import { compareObservation, compareSmoke, deviations, type Finding } from './compare';
import { observationSchema } from './observation';
import { smokeResultSchema } from './smoke';
import type { CliProfile } from '../../src/server/claude/cliProfile';

/** Budget of one check (user permission 12.11.2026: Haiku, subscription, ≤ 0.05 USD per check). */
export const CHECK_BUDGET_USD = 0.05;

export const cleanupReportSchema = z.object({
  /** Deleted paths (own data only: scratch, transcripts of own cwds, task folders of own sessions). */
  deleted: z.array(z.string()),
  /** Paths left in place on purpose, with the reason (unverified, plan file, ~/.claude.json …). */
  kept: z.array(z.object({ path: z.string(), reason: z.string() })),
  /** Errors while deleting. */
  errors: z.array(z.string()),
});
export type CleanupReport = z.infer<typeof cleanupReportSchema>;

export const runRecordSchema = z.object({
  version: z.literal(1),
  startedAt: z.string(),
  finishedAt: z.string(),
  claudePath: z.string().nullable(),
  cliVersion: z.string().nullable(),
  sdkVersion: z.string().nullable(),
  sdkClaudeCodeVersion: z.string().nullable(),
  /** Login view of `claude auth status` (never e-mail/org). */
  auth: z.object({
    method: z.string().nullable(),
    apiProvider: z.string().nullable(),
    subscriptionType: z.string().nullable(),
  }),
  observation: observationSchema.nullable(),
  probe: z
    .object({
      costUsd: z.number(),
      sessionIds: z.array(z.string()),
      apiKeySource: z.string(),
      resultSubtype: z.string(),
      messageTypes: z.record(z.string(), z.number()),
      contextDetail: z.enum(['full', 'summary']).nullable(),
      durationMs: z.number(),
    })
    .nullable(),
  smoke: smokeResultSchema.nullable(),
  cost: z.object({ probeUsd: z.number(), smokeUsd: z.number(), totalUsd: z.number(), budgetUsd: z.number() }),
  cleanup: cleanupReportSchema.nullable(),
  /** Why the run stopped (exit 2); null = ran through. */
  error: z.string().nullable(),
});
export type RunRecord = z.infer<typeof runRecordSchema>;

export interface Evaluation {
  findings: Finding[];
  exitCode: 0 | 1 | 2;
}

/** Findings and exit code of a run against a profile. */
export function evaluate(record: RunRecord, profile: CliProfile | null): Evaluation {
  if (record.error !== null) {
    const findings = record.observation === null ? [] : compareObservation(profile, record.observation);
    return { findings: [...findings, ...(record.smoke === null ? [] : compareSmoke(record.smoke))], exitCode: 2 };
  }
  if (record.observation === null) return { findings: [], exitCode: 2 };
  const findings = [...compareObservation(profile, record.observation), ...compareSmoke(record.smoke)];
  return { findings, exitCode: deviations(findings).length > 0 ? 1 : 0 };
}

export function resultLabel(evaluation: Evaluation): string {
  if (evaluation.exitCode === 2) return 'ERROR';
  const count = deviations(evaluation.findings).length;
  return count === 0 ? 'GREEN' : `DEVIATIONS (${String(count)})`;
}

const usd = (value: number): string => `${value.toFixed(4)} USD`;

function bulletList(items: readonly string[]): string[] {
  return items.length === 0 ? ['- (none)'] : items.map((item) => `- ${item}`);
}

function findingLines(finding: Finding): string[] {
  const lines = [`### ${finding.title}`, '', `Affected: ${finding.hint}`];
  if (finding.area === 'smoke' && finding.added.length > 0) {
    lines.push('', ...finding.added.map((line) => `- ${line}`));
  }
  lines.push('');
  return lines;
}

function inline(values: readonly string[] | null): string {
  if (values === null) return '(not reported)';
  return values.length === 0 ? '(none)' : values.map((value) => `\`${value}\``).join(', ');
}

/** The Markdown report (English, like the console output and `pnpm preflight`). */
export function formatReport(input: {
  record: RunRecord;
  profile: CliProfile | null;
  profilePath: string;
  evaluation: Evaluation;
  mode: 'live' | 'last';
}): string {
  const { record, profile, evaluation } = input;
  const found = evaluation.findings;
  const lines: string[] = [
    `# claude CLI check – ${record.finishedAt}`,
    '',
    `- **Result: ${resultLabel(evaluation)}** (exit ${String(evaluation.exitCode)})${input.mode === 'last' ? ' – compared again from the last run (`--last`, no live call)' : ''}`,
    `- claude: ${record.cliVersion ?? '?'} (profile: ${profile?.cliVersion ?? 'none'}), ${record.claudePath ?? '?'}`,
    `- Agent SDK: ${record.sdkVersion ?? '?'} (expects claude >= ${record.sdkClaudeCodeVersion ?? '?'})`,
    `- Login: ${record.auth.method ?? '?'} / ${record.auth.apiProvider ?? '?'} / ${record.auth.subscriptionType ?? '?'}, apiKeySource ${record.probe?.apiKeySource ?? '?'}`,
    `- Cost: probe ${usd(record.cost.probeUsd)} + smoke ${usd(record.cost.smokeUsd)} = ${usd(record.cost.totalUsd)} (budget ${usd(record.cost.budgetUsd)})`,
  ];
  const smoke = record.smoke;
  if (smoke !== null) {
    lines.push(
      `- Live smoke: ${smoke.ran ? `${String(smoke.passed)} passed, ${String(smoke.failed)} failed, ${String(smoke.skipped)} skipped, exit ${String(smoke.exitCode)}` : 'not run'}`,
    );
  }
  lines.push(`- Profile: \`${input.profilePath}\`${profile === null ? ' (missing or unreadable)' : ` (checked ${profile.checkedAt})`}`);
  if (record.error !== null) lines.push('', `**Stopped:** ${record.error}`);

  lines.push('', `## Deviations (${String(deviations(found).length)})`, '');
  const devs = deviations(found);
  if (devs.length === 0) lines.push('None.', '');
  for (const finding of devs) lines.push(...findingLines(finding));

  const notes = found.filter((finding) => finding.level === 'note');
  lines.push(`## Notes (not counted, ${String(notes.length)})`, '');
  if (notes.length === 0) lines.push('None.', '');
  for (const finding of notes) lines.push(`- ${finding.title} – ${finding.hint}`);
  if (notes.length > 0) lines.push('');

  const obs = record.observation;
  if (obs !== null) {
    lines.push(
      '## Observation (probe)',
      '',
      `- model ${obs.model}, permissionMode ${obs.permissionMode}, output style ${obs.outputStyle}`,
      `- tools (${String(obs.tools.length)}): ${inline(obs.tools)}`,
      `- deferred tools: ${inline(obs.deferredTools)}`,
      `- capabilities (${String(obs.capabilities.length)}): ${inline(obs.capabilities)}`,
      `- init keys (${String(obs.initKeys.length)}): ${inline(obs.initKeys)}`,
      `- initializationResult keys (${String(obs.initializationKeys.length)}): ${inline(obs.initializationKeys)}`,
      `- models (${String(obs.models.length)}): ${inline(obs.models)}`,
      `- context categories: ${inline(obs.contextCategories)}`,
      `- slash commands: ${String(obs.slashCommands.length)}, agents: ${inline(obs.agents)}, skills: ${String(obs.skills.length)}`,
    );
    if (record.probe !== null) {
      const types = Object.entries(record.probe.messageTypes)
        .sort(([a], [b]) => (a < b ? -1 : 1))
        .map(([type, count]) => `${type}×${String(count)}`);
      lines.push(
        `- probe messages: ${types.join(', ') || '(none)'}; result ${record.probe.resultSubtype}; ${String(record.probe.durationMs)} ms`,
      );
    }
    lines.push('');
  }
  if (smoke?.ran === true) {
    const unknown = smoke.unknownCounts === null ? '(not reported)' : JSON.stringify(smoke.unknownCounts);
    lines.push(
      '## Live smoke',
      '',
      `- unknownCounts: ${unknown}`,
      `- validation drops: ${smoke.validationDrops === null ? '(not reported)' : String(smoke.validationDrops)}`,
      `- cost: ${smoke.costUsd === null ? '(unknown)' : usd(smoke.costUsd)}`,
      ...smoke.failures.map((failure) => `- failed: ${failure.title}: ${failure.message}`),
      '',
    );
  }
  const cleanup = record.cleanup;
  lines.push('## Cleanup', '');
  if (cleanup === null) {
    lines.push('Not run.', '');
  } else {
    lines.push('Deleted:', ...bulletList(cleanup.deleted), '', 'Left in place:');
    lines.push(...bulletList(cleanup.kept.map((item) => `${item.path} – ${item.reason}`)));
    if (cleanup.errors.length > 0) lines.push('', 'Errors:', ...bulletList(cleanup.errors));
    lines.push('');
  }
  return `${lines.join('\n')}\n`;
}

/** Short console summary (English). */
export function formatSummary(evaluation: Evaluation, record: RunRecord, reportPath: string): string {
  const lines = [
    `cli-check: ${resultLabel(evaluation)} – claude ${record.cliVersion ?? '?'}, cost ${usd(record.cost.totalUsd)} of ${usd(record.cost.budgetUsd)}`,
  ];
  if (record.error !== null) lines.push(`  stopped: ${record.error}`);
  for (const finding of deviations(evaluation.findings)) lines.push(`  DEVIATION ${finding.title}`);
  for (const finding of evaluation.findings.filter((item) => item.level === 'note')) {
    lines.push(`  note      ${finding.title}`);
  }
  lines.push(`  report: ${reportPath}`);
  return `${lines.join('\n')}\n`;
}

export const PROTOCOL_HEADER = [
  '# `claude`-Updates – Protokoll',
  '',
  'Eine Zeile je `pnpm cli-check --accept` (WP-62; Ablauf: Skill `/claude-update`, `docs/sdk-upgrade.md`',
  '„Stufe 1: Kurz-Check“). Die Zeilen schreibt das Skript, das Profil steht in',
  '`src/server/claude/cli-profile.json`.',
  '',
  '| Datum | `claude` alt → neu | SDK | Ergebnis | Kosten (USD) |',
  '|---|---|---|---|---|',
  '',
].join('\n');

/** One protocol row (German, like the rest of docs/). */
export function protocolRow(input: {
  date: Date;
  previous: string | null;
  record: RunRecord;
  evaluation: Evaluation;
}): string {
  const count = deviations(input.evaluation.findings).length;
  const result = count === 0 ? 'grün' : `${String(count)} Abweichung${count === 1 ? '' : 'en'}, akzeptiert`;
  const cost = input.record.cost.totalUsd.toFixed(4).replace('.', ',');
  const date = input.date.toISOString().slice(0, 10);
  return `| ${date} | ${input.previous ?? '–'} → ${input.record.cliVersion ?? '?'} | ${input.record.sdkVersion ?? '?'} | ${result} | ${cost} |\n`;
}

/** The protocol file with one more row (header added when the file is new or empty). */
export function appendProtocol(existing: string | null, row: string): string {
  const base = existing === null || existing.trim() === '' ? PROTOCOL_HEADER : existing;
  return `${base.endsWith('\n') ? base : `${base}\n`}${row}`;
}
