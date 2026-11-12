/**
 * Fixed test data of the cli-check tests (WP-62): an observation shaped like CLI 2.1.322 (auth-probe
 * recording of 11.11.2026, trimmed), the matching profile, a green smoke and a run record. Only used
 * by `*.test.ts` – never by the check itself.
 */
import type { CliProfile } from '../../src/server/claude/cliProfile';
import type { Observation } from './observation';
import type { RunRecord } from './report';
import type { SmokeResult } from './smoke';

export function sampleObservation(p: Partial<Observation> = {}): Observation {
  return {
    cliVersion: '2.1.322',
    sdkVersion: '0.3.322',
    model: 'claude-haiku-5-5',
    permissionMode: 'default',
    outputStyle: 'default',
    initKeys: ['agents', 'apiKeySource', 'capabilities', 'claude_code_version', 'cwd', 'model', 'tools'],
    tools: ['AskUserQuestion', 'Bash', 'Edit', 'ExitPlanMode', 'PowerShell', 'Read', 'Task', 'ToolSearch', 'Write'],
    deferredTools: ['Monitor', 'NotebookEdit'],
    capabilities: ['interrupt_receipt_v1', 'msg_lifecycle_v1'],
    initializationKeys: ['account', 'commands', 'models', 'pid'],
    models: ['default', 'haiku', 'opus', 'sonnet'],
    contextCategories: ['free_space', 'messages', 'system_prompt', 'system_tools'],
    slashCommands: ['clear', 'compact', 'context'],
    agents: ['Explore', 'general-purpose'],
    skills: ['simplify'],
    remoteControl: true,
    ...p,
  };
}

export function sampleProfile(p: Partial<CliProfile> = {}): CliProfile {
  return { schemaVersion: 1, checkedAt: '2026-11-12T15:00:00.000Z', ...sampleObservation(), ...p };
}

export function sampleSmoke(p: Partial<SmokeResult> = {}): SmokeResult {
  return {
    ran: true,
    exitCode: 0,
    passed: 6,
    failed: 0,
    skipped: 0,
    flaky: 0,
    failures: [],
    unknownCounts: {},
    validationDrops: 0,
    costUsd: 0.0055,
    root: 'C:\\Users\\user\\AppData\\Local\\Temp\\parallax-live-e2e-abc123',
    note: null,
    ...p,
  };
}

export function sampleRecord(p: Partial<RunRecord> = {}): RunRecord {
  return {
    version: 1,
    startedAt: '2026-11-12T15:00:00.000Z',
    finishedAt: '2026-11-12T15:02:00.000Z',
    claudePath: 'C:\\Users\\user\\.local\\bin\\claude.exe',
    cliVersion: '2.1.322',
    sdkVersion: '0.3.322',
    sdkClaudeCodeVersion: '2.1.322',
    auth: { method: 'claude.ai', apiProvider: 'firstParty', subscriptionType: 'max' },
    observation: sampleObservation(),
    probe: {
      costUsd: 0.003,
      sessionIds: ['11111111-2222-3333-4444-555555555555'],
      apiKeySource: 'none',
      resultSubtype: 'success',
      messageTypes: { 'system/init': 1, assistant: 1, result: 1 },
      contextDetail: 'full',
      durationMs: 9000,
      remoteControl: { available: true, detail: null, connectedMs: 420, disabled: true },
    },
    smoke: sampleSmoke(),
    cost: { probeUsd: 0.003, smokeUsd: 0.0055, totalUsd: 0.0085, budgetUsd: 0.05 },
    cleanup: { deleted: [], kept: [], errors: [] },
    error: null,
    ...p,
  };
}
