import { describe, expect, it } from 'vitest';
import { compareObservation, compareSmoke, deviations } from './compare';
import { sampleObservation, sampleProfile, sampleSmoke } from './samples';

describe('compareObservation (WP-62)', () => {
  it('the same observation is green', () => {
    expect(compareObservation(sampleProfile(), sampleObservation())).toEqual([]);
  });

  it('without a profile: one deviation that asks for the first --accept', () => {
    const findings = compareObservation(null, sampleObservation());
    expect(findings).toHaveLength(1);
    expect(findings[0]).toMatchObject({ area: 'profile', level: 'deviation' });
  });

  it('manipulated profile (TodoWrite "present", older version): deviations, the version only as a note', () => {
    const profile = sampleProfile({
      cliVersion: '2.1.300',
      tools: [...sampleProfile().tools, 'TodoWrite'].sort(),
    });
    const findings = compareObservation(profile, sampleObservation());
    expect(findings.find((finding) => finding.area === 'cliVersion')).toMatchObject({
      level: 'note',
      title: 'claude version: 2.1.300 → 2.1.322',
    });
    expect(findings.find((finding) => finding.area === 'tools')).toMatchObject({
      level: 'deviation',
      removed: ['TodoWrite'],
      added: [],
    });
    const todo = findings.find((finding) => finding.area === 'todoTools');
    expect(todo).toMatchObject({ level: 'deviation', title: 'task tools no longer offered: TodoWrite' });
    expect(todo?.hint).toContain('ADR-156');
    expect(deviations(findings).map((finding) => finding.area)).toEqual(['tools', 'todoTools']);
  });

  it('TaskCreate offered by a new CLI: tools + the ADR-156 call-out', () => {
    const observation = sampleObservation({ tools: [...sampleObservation().tools, 'TaskCreate'].sort() });
    const findings = compareObservation(sampleProfile(), observation);
    expect(findings.find((finding) => finding.area === 'todoTools')?.title).toBe(
      'task tools offered again: TaskCreate',
    );
    expect(findings.find((finding) => finding.area === 'tools')?.added).toEqual(['TaskCreate']);
  });

  it('missing core tools, new init keys, capabilities, models, context categories, default mode', () => {
    const observation = sampleObservation({
      tools: sampleObservation().tools.filter((tool) => tool !== 'AskUserQuestion'),
      initKeys: [...sampleObservation().initKeys, 'brand_new_key'].sort(),
      capabilities: ['msg_lifecycle_v1'],
      models: [...sampleObservation().models, 'claude-haiku-5-6'].sort(),
      contextCategories: [...sampleObservation().contextCategories, 'skills'].sort(),
      permissionMode: 'auto',
    });
    const areas = deviations(compareObservation(sampleProfile(), observation)).map((finding) => finding.area);
    expect(areas).toEqual([
      'permissionMode',
      'tools',
      'initKeys',
      'capabilities',
      'models',
      'contextCategories',
      'coreTools',
    ]);
    const core = compareObservation(sampleProfile(), observation).find((finding) => finding.area === 'coreTools');
    expect(core?.removed).toEqual(['AskUserQuestion']);
  });

  it('account-dependent lists and the model id are notes only', () => {
    const observation = sampleObservation({
      slashCommands: ['clear'],
      agents: ['Explore'],
      skills: [],
      model: 'claude-haiku-5-6',
      sdkVersion: '0.3.330',
    });
    const findings = compareObservation(sampleProfile(), observation);
    expect(deviations(findings)).toEqual([]);
    expect(findings.map((finding) => finding.area).sort()).toEqual(['agents', 'model', 'sdkVersion', 'skills', 'slashCommands']);
  });

  it('deferred tools: a change is a deviation; first report after null is a note', () => {
    const changed = compareObservation(sampleProfile(), sampleObservation({ deferredTools: ['Monitor'] }));
    expect(changed[0]).toMatchObject({ area: 'deferredTools', level: 'deviation', removed: ['NotebookEdit'] });
    const first = compareObservation(sampleProfile({ deferredTools: null }), sampleObservation());
    expect(first[0]).toMatchObject({ area: 'deferredTools', level: 'note' });
    expect(compareObservation(sampleProfile(), sampleObservation({ deferredTools: null }))).toEqual([]);
  });
});

describe('compareSmoke (WP-62)', () => {
  it('a clean smoke is green', () => {
    expect(compareSmoke(sampleSmoke())).toEqual([]);
  });

  it('a missing smoke is a deviation', () => {
    expect(compareSmoke(null)[0]).toMatchObject({ area: 'smoke', level: 'deviation' });
    expect(compareSmoke(sampleSmoke({ ran: false }))[0]?.title).toBe('live smoke not run');
  });

  it('failures, unknown message types and validation drops are deviations', () => {
    const findings = compareSmoke(
      sampleSmoke({
        exitCode: 1,
        passed: 4,
        failed: 1,
        skipped: 1,
        failures: [{ title: 'live.spec.ts › Stop interrupts a running tool', message: 'Timed out' }],
        unknownCounts: { 'system/brand_new': 2, 'permissionMode:auto': 0 },
        validationDrops: 3,
      }),
    );
    expect(findings.map((finding) => [finding.area, finding.level])).toEqual([
      ['smoke', 'deviation'],
      ['unknownCounts', 'deviation'],
      ['validationDrops', 'deviation'],
    ]);
    expect(findings[0]?.title).toBe('live smoke: 1 failed, 1 skipped, exit 1');
    expect(findings[0]?.added).toEqual(['live.spec.ts › Stop interrupts a running tool: Timed out']);
    expect(findings[1]?.added).toEqual(['system/brand_new']);
  });

  it('unreported counts (last test skipped) are a note next to the failure', () => {
    const findings = compareSmoke(sampleSmoke({ exitCode: 1, failed: 1, unknownCounts: null, validationDrops: null }));
    expect(findings.map((finding) => [finding.area, finding.level])).toEqual([
      ['smoke', 'deviation'],
      ['smokeData', 'note'],
    ]);
  });
});
