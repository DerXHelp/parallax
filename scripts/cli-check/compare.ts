/**
 * Step 4 of `pnpm cli-check` (WP-62): the structured comparison of a new observation (probe) and the
 * live smoke with the CLI profile in the repo. Pure, tested with fixed profiles.
 *
 * `deviation` findings make the check red (exit 1) – each names the place in Parallax a change may
 * affect; `note` findings are listed but do not count (version change itself, things that depend on
 * the account rather than on Parallax: model id, slash commands, agents, skills).
 */
import type { CliProfile } from '../../src/server/claude/cliProfile';
import type { Observation } from './observation';
import type { SmokeResult } from './smoke';

export type FindingLevel = 'deviation' | 'note';

export interface Finding {
  /** Stable id of the compared area (`tools`, `initKeys`, … `smoke`). */
  area: string;
  level: FindingLevel;
  /** English one-liner for the report and the console. */
  title: string;
  added: string[];
  removed: string[];
  /** Where in Parallax the change may matter (English, with paths). */
  hint: string;
}

/** Tools the task bar waits for (ADR-156): their appearance is always called out. */
export const TODO_TOOLS: readonly string[] = ['TaskCreate', 'TodoWrite'];

/** Tools whose disappearance breaks a Parallax flow directly. */
export const CORE_TOOLS: readonly string[] = [
  'Agent',
  'AskUserQuestion',
  'Bash',
  'Edit',
  'EnterPlanMode',
  'ExitPlanMode',
  'PowerShell',
  'Read',
  'Task',
  'Write',
];

interface ListArea {
  area: keyof Observation & keyof CliProfile;
  label: string;
  level: FindingLevel;
  hint: string;
}

const LIST_AREAS: readonly ListArea[] = [
  {
    area: 'tools',
    label: 'tools (system/init.tools, deferred included, without mcp__*)',
    level: 'deviation',
    hint:
      'Tool cards and renderers (web/features/transcript), permission requests ' +
      '(backend/permissionRequest.ts, web/features/decisions), the live normalizer ' +
      '(server/sessions/normalizer/live.ts); docs/sdk-findings.md "Beobachtete Message-Typen".',
  },
  {
    area: 'deferredTools',
    label: 'deferred built-in tools (getContextUsage("full").deferredBuiltinTools)',
    level: 'deviation',
    hint:
      'Deferred tools reach the model only via ToolSearch: check flows that expect a tool in the ' +
      'prompt (plan mode, AskUserQuestion, task bar – ADR-156) with a live session.',
  },
  {
    area: 'initKeys',
    label: 'system/init keys',
    level: 'deviation',
    hint:
      'Init parsing is tolerant (server/sessions/normalizer/sdk-schemas.ts, normalizer/live.ts): ' +
      'decide whether a new key is worth showing; note it in docs/sdk-findings.md.',
  },
  {
    area: 'capabilities',
    label: 'capabilities (system/init.capabilities)',
    level: 'deviation',
    hint:
      'Interrupt/queue/lifecycle behaviour (backend/sdkBackend.ts, server/sessions queue and stop) – ' +
      'docs/sdk-findings.md Punkt 9/10; a removed capability may break Stop or "send now".',
  },
  {
    area: 'initializationKeys',
    label: 'initializationResult() keys',
    level: 'deviation',
    hint:
      'Readiness and process facts (backend/sdkBackend.ts: pid, models, commands, ' +
      'current_permission_mode); untyped fields are read tolerantly.',
  },
  {
    area: 'models',
    label: 'models (supportedModels().value)',
    level: 'deviation',
    hint:
      'Model picker and catalog (server/sessions/catalogStore.ts, sessions/commands.ts), FakeBackend ' +
      'FAKE_MODELS (backend/fake/defaults.ts); a new alias may need a label.',
  },
  {
    area: 'contextCategories',
    label: 'context categories (getContextUsage().categories[].id)',
    level: 'deviation',
    hint:
      'Context gauge (server/sessions/normalizer/context.ts) and the FakeBackend answer ' +
      '(backend/fake/defaults.ts); unknown ids are treated as absent by the SDK contract.',
  },
  {
    area: 'slashCommands',
    label: 'slash commands (system/init.slash_commands, settings isolated)',
    level: 'note',
    hint: 'Slash-command menu of the composer (web/features/composer) – built-in commands of the CLI.',
  },
  {
    area: 'agents',
    label: 'agents (system/init.agents)',
    level: 'note',
    hint: 'Subagent display (Agent tool, task panel web/features/tasks).',
  },
  {
    area: 'skills',
    label: 'skills (system/init.skills)',
    level: 'note',
    hint: 'Bundled skills of the CLI; nothing in Parallax depends on them.',
  },
];

function difference(a: readonly string[], b: readonly string[]): string[] {
  const other = new Set(b);
  return a.filter((value) => !other.has(value));
}

function listFinding(spec: ListArea, before: readonly string[], after: readonly string[]): Finding | null {
  const added = difference(after, before);
  const removed = difference(before, after);
  if (added.length === 0 && removed.length === 0) return null;
  const parts = [
    added.length === 0 ? null : `added ${added.join(', ')}`,
    removed.length === 0 ? null : `removed ${removed.join(', ')}`,
  ].filter((part) => part !== null);
  return { area: spec.area, level: spec.level, title: `${spec.label}: ${parts.join('; ')}`, added, removed, hint: spec.hint };
}

function scalarFinding(
  area: string,
  label: string,
  before: string,
  after: string,
  level: FindingLevel,
  hint: string,
): Finding | null {
  if (before === after) return null;
  return { area, level, title: `${label}: ${before || '(empty)'} → ${after || '(empty)'}`, added: [after], removed: [before], hint };
}

const REMOTE_CONTROL_HINT =
  'Remote Control (WP-64) uses internal SDK parts: Query.enableRemoteControl, getSettings() and ' +
  'system/bridge_state (backend/remoteControl.ts, backend/sdkBackend.ts, sessions/normalizer/bridge.ts, ' +
  'sessions/remoteControl.ts); check the report detail and docs/sdk-upgrade.md.';

const availability = (value: boolean): string => (value ? 'available' : 'not available');

/**
 * A yes/no capability of the probe against the profile – a change between true and false is a
 * deviation; a first check (profile null) or a run that did not check (observation null) a note.
 */
function availabilityFinding(
  area: string,
  label: string,
  hint: string,
  before: boolean | null,
  after: boolean | null,
): Finding | null {
  if (before === after) return null;
  if (before === null || after === null) {
    return {
      area,
      level: 'note',
      title:
        after === null ? `${label}: not checked in this run` : `${label}: checked for the first time – ${availability(after)}`,
      added: after === null ? [] : [availability(after)],
      removed: [],
      hint,
    };
  }
  return {
    area,
    level: 'deviation',
    title: `${label}: ${availability(before)} → ${availability(after)}`,
    added: [availability(after)],
    removed: [availability(before)],
    hint,
  };
}

/** WP-64: Remote Control of the probe against the profile. */
export function remoteControlFinding(before: boolean | null, after: boolean | null): Finding | null {
  return availabilityFinding(
    'remoteControl',
    'remote control (enableRemoteControl + bridge_state connected)',
    REMOTE_CONTROL_HINT,
    before,
    after,
  );
}

/** WP-65: the overview step (overview.ts) – where a change matters in Parallax. */
const OVERVIEW_AREAS: readonly { area: 'sessionTitle' | 'usageQuery' | 'backgroundTasks'; label: string; hint: string }[] = [
  {
    area: 'sessionTitle',
    label: 'session title (Query.generateSessionTitle)',
    hint:
      'Auto title and „Titel neu erzeugen“ (WP-65) use the internal generateSessionTitle: ' +
      'backend/sdkBackend.ts generateTitle, backend/overview.ts titleOf, sessions/titles.ts; without it ' +
      'the old title-from-prompt fallback stays.',
  },
  {
    area: 'usageQuery',
    label: 'usage query (rate_limits with utilization/resets_at)',
    hint:
      'The limit bar without a rate-limit event (WP-65) reads the experimental usage query: ' +
      'backend/sdkBackend.ts readUsage, backend/overview.ts usageLimitsOf, sessions/usagePoll.ts.',
  },
  {
    area: 'backgroundTasks',
    label: 'Query.backgroundTasks',
    hint:
      '„In den Hintergrund“ / Ctrl+B (WP-65): backend/sdkBackend.ts backgroundTasks, ' +
      'sessions/commands.ts session.backgroundTasks; hide the buttons if it is gone.',
  },
];

/** WP-65: the overview capabilities of the probe against the profile. */
export function overviewFindings(profile: CliProfile, observation: Observation): Finding[] {
  return OVERVIEW_AREAS.flatMap((spec) => {
    const finding = availabilityFinding(spec.area, spec.label, spec.hint, profile[spec.area], observation[spec.area]);
    return finding === null ? [] : [finding];
  });
}

/** Profile vs. observation (probe). Without a profile one deviation asks for the first `--accept`. */
export function compareObservation(profile: CliProfile | null, observation: Observation): Finding[] {
  if (profile === null) {
    return [
      {
        area: 'profile',
        level: 'deviation',
        title: 'no CLI profile yet (or it is unreadable)',
        added: [],
        removed: [],
        hint: 'Check the observation below and write the first profile with `pnpm cli-check --last --accept`.',
      },
    ];
  }
  const findings: Finding[] = [];
  const push = (finding: Finding | null): void => {
    if (finding !== null) findings.push(finding);
  };

  push(
    scalarFinding('cliVersion', 'claude version', profile.cliVersion, observation.cliVersion, 'note', 'Expected after an update.'),
  );
  push(
    scalarFinding(
      'sdkVersion',
      'Agent SDK version',
      profile.sdkVersion,
      observation.sdkVersion,
      'note',
      'An SDK upgrade is "Stufe 2" (docs/sdk-upgrade.md).',
    ),
  );
  push(
    scalarFinding(
      'permissionMode',
      'default permission mode (no mode in the options)',
      profile.permissionMode,
      observation.permissionMode,
      'deviation',
      'The CLI default decides when Parallax sends no mode (ADR-080, WP22-04): new-session defaults, ' +
        'the mode badge, e2e/live chooses "Manual" before the first prompt.',
    ),
  );
  push(
    scalarFinding(
      'model',
      'probe model (system/init.model)',
      profile.model,
      observation.model,
      'note',
      'New Haiku id: cost estimates and the Haiku guard of e2e/live (`/haiku/i`).',
    ),
  );
  push(
    scalarFinding(
      'outputStyle',
      'output style (system/init.output_style)',
      profile.outputStyle,
      observation.outputStyle,
      'note',
      'Parallax does not use output styles.',
    ),
  );

  for (const spec of LIST_AREAS) {
    const before = profile[spec.area];
    const after = observation[spec.area];
    if (Array.isArray(before) && Array.isArray(after)) push(listFinding(spec, before, after));
    else if (before === null && Array.isArray(after) && spec.area === 'deferredTools')
      findings.push({
        area: spec.area,
        level: 'note',
        title: `${spec.label}: now reported (${after.length})`,
        added: after,
        removed: [],
        hint: spec.hint,
      });
  }

  push(remoteControlFinding(profile.remoteControl, observation.remoteControl));
  findings.push(...overviewFindings(profile, observation));

  // ADR-156: TodoWrite/TaskCreate are the reason the task bar stays empty – call them out.
  const todoAdded = TODO_TOOLS.filter((tool) => observation.tools.includes(tool) && !profile.tools.includes(tool));
  const todoRemoved = TODO_TOOLS.filter((tool) => profile.tools.includes(tool) && !observation.tools.includes(tool));
  if (todoAdded.length > 0 || todoRemoved.length > 0) {
    findings.push({
      area: 'todoTools',
      level: 'deviation',
      title:
        todoAdded.length > 0
          ? `task tools offered again: ${todoAdded.join(', ')}`
          : `task tools no longer offered: ${todoRemoved.join(', ')}`,
      added: todoAdded,
      removed: todoRemoved,
      hint:
        'ADR-156: reconsider `todoFeatureEnabled` (backend/sdkOptions.ts) and check the task bar live ' +
        '(web/features/tasks, WP-61 B7/B25).',
    });
  }
  const coreRemoved = CORE_TOOLS.filter((tool) => profile.tools.includes(tool) && !observation.tools.includes(tool));
  if (coreRemoved.length > 0) {
    findings.push({
      area: 'coreTools',
      level: 'deviation',
      title: `core tools missing: ${coreRemoved.join(', ')}`,
      added: [],
      removed: coreRemoved,
      hint:
        'Decision cards (AskUserQuestion, ExitPlanMode → web/features/decisions), permission flow, ' +
        'plan mode and subagents depend on them – check before accepting.',
    });
  }
  return findings;
}

/** Findings of the live smoke: failures, unknown message types, validation drops. */
export function compareSmoke(smoke: SmokeResult | null): Finding[] {
  if (smoke?.ran !== true) {
    return [
      {
        area: 'smoke',
        level: 'deviation',
        title: 'live smoke not run',
        added: [],
        removed: [],
        hint: 'Run the full check (without --last) or `$env:PARALLAX_LIVE=\'1\'; pnpm e2e e2e/live`.',
      },
    ];
  }
  const findings: Finding[] = [];
  const failed = smoke.failed + smoke.flaky;
  if (failed > 0 || smoke.exitCode !== 0 || smoke.note !== null || smoke.passed === 0) {
    const reasons = [
      failed > 0 ? `${String(failed)} failed` : null,
      smoke.skipped > 0 ? `${String(smoke.skipped)} skipped` : null,
      smoke.exitCode !== 0 ? `exit ${String(smoke.exitCode)}` : null,
      smoke.note,
      smoke.passed === 0 && failed === 0 ? 'no test passed' : null,
    ].filter((reason) => reason !== null);
    findings.push({
      area: 'smoke',
      level: 'deviation',
      title: `live smoke: ${reasons.join(', ')}`,
      added: smoke.failures.map((failure) => `${failure.title}: ${failure.message}`),
      removed: [],
      hint:
        'Read test-results/ (server-live.log, traces of the failing flow): permission card, ' +
        'AskUserQuestion, Stop, reload, version display (e2e/live/live.spec.ts).',
    });
  }
  const unknown = Object.entries(smoke.unknownCounts ?? {}).filter(([, count]) => count > 0);
  if (unknown.length > 0) {
    findings.push({
      area: 'unknownCounts',
      level: 'deviation',
      title: `unknown message types in the live smoke: ${unknown.map(([key, count]) => `${key}=${String(count)}`).join(', ')}`,
      added: unknown.map(([key]) => key),
      removed: [],
      hint:
        'Normalizer gap (server/sessions/normalizer, docs/sdk-upgrade.md step 6): map or ignore the ' +
        'new type deliberately; note it in docs/sdk-findings.md.',
    });
  }
  if (smoke.validationDrops !== null && smoke.validationDrops > 0) {
    findings.push({
      area: 'validationDrops',
      level: 'deviation',
      title: `validation drops in the server log: ${String(smoke.validationDrops)}`,
      added: [],
      removed: [],
      hint:
        'Real SDK data no longer matches the contract ("invalid outgoing value dropped", ' +
        'test-results/server-live.log): normalizer or a contract change (coordinator).',
    });
  }
  if (smoke.unknownCounts === null || smoke.validationDrops === null) {
    findings.push({
      area: 'smokeData',
      level: 'note',
      title: 'live smoke did not report unknownCounts/validation drops (last test not run)',
      added: [],
      removed: [],
      hint: 'See the smoke failures above.',
    });
  }
  return findings;
}

export function deviations(findings: readonly Finding[]): Finding[] {
  return findings.filter((finding) => finding.level === 'deviation');
}
