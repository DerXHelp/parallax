import { describe, expect, it } from 'vitest';
import {
  PROTOCOL_HEADER,
  appendProtocol,
  evaluate,
  formatReport,
  formatSummary,
  protocolRow,
  resultLabel,
  runRecordSchema,
} from './report';
import { sampleObservation, sampleProfile, sampleRecord, sampleSmoke } from './samples';

describe('evaluate (WP-62 exit codes)', () => {
  it('0 = green, 1 = deviations, 2 = error', () => {
    expect(evaluate(sampleRecord(), sampleProfile()).exitCode).toBe(0);
    const manipulated = sampleProfile({ cliVersion: '2.1.300', tools: [...sampleProfile().tools, 'TodoWrite'].sort() });
    const red = evaluate(sampleRecord(), manipulated);
    expect(red.exitCode).toBe(1);
    expect(resultLabel(red)).toBe('DEVIATIONS (2)');
    expect(evaluate(sampleRecord({ error: 'pre-check failed' }), sampleProfile()).exitCode).toBe(2);
    expect(evaluate(sampleRecord({ observation: null }), sampleProfile()).exitCode).toBe(2);
    expect(evaluate(sampleRecord({ smoke: sampleSmoke({ failed: 1, exitCode: 1 }) }), sampleProfile()).exitCode).toBe(1);
  });

  it('the run record round-trips through its schema (last-run.json)', () => {
    const record = sampleRecord();
    expect(runRecordSchema.parse(JSON.parse(JSON.stringify(record)))).toEqual(record);
  });
});

describe('formatReport / formatSummary', () => {
  it('lists result, versions, cost, deviations with the affected place, observation and cleanup', () => {
    const profile = sampleProfile({ cliVersion: '2.1.300', tools: [...sampleProfile().tools, 'TodoWrite'].sort() });
    const record = sampleRecord({
      cleanup: {
        deleted: ['C:\\Temp\\parallax-cli-check-x'],
        kept: [{ path: 'C:\\Users\\user\\.claude.json', reason: '1 project entry (only reported)' }],
        errors: [],
      },
    });
    const evaluation = evaluate(record, profile);
    const text = formatReport({ record, profile, profilePath: 'cli-profile.json', evaluation, mode: 'live' });
    expect(text).toContain('**Result: DEVIATIONS (2)** (exit 1)');
    expect(text).toContain('claude: 2.1.322 (profile: 2.1.300)');
    expect(text).toContain('Cost: probe 0.0030 USD + smoke 0.0055 USD = 0.0085 USD (budget 0.0500 USD)');
    expect(text).toContain('### task tools no longer offered: TodoWrite');
    expect(text).toContain('Affected: ADR-156');
    expect(text).toContain('- claude version: 2.1.300 → 2.1.322');
    expect(text).toContain('- deferred tools: `Monitor`, `NotebookEdit`');
    expect(text).toContain('- C:\\Temp\\parallax-cli-check-x');
    expect(text).toContain('C:\\Users\\user\\.claude.json – 1 project entry (only reported)');
    expect(text).not.toMatch(/@|example\.com/);

    const summary = formatSummary(evaluation, record, 'test-results/cli-check/x.md');
    expect(summary.split('\n')[0]).toBe('cli-check: DEVIATIONS (2) – claude 2.1.322, cost 0.0085 USD of 0.0500 USD');
    expect(summary).toContain('  DEVIATION task tools no longer offered: TodoWrite');
    expect(summary).toContain('  report: test-results/cli-check/x.md');
  });

  it('a green run and a stopped run', () => {
    const green = formatReport({
      record: sampleRecord(),
      profile: sampleProfile(),
      profilePath: 'p.json',
      evaluation: evaluate(sampleRecord(), sampleProfile()),
      mode: 'last',
    });
    expect(green).toContain('**Result: GREEN** (exit 0) – compared again from the last run');
    expect(green).toContain('## Deviations (0)\n\nNone.');
    const stopped = sampleRecord({ error: 'probe stopped (auth): assistant.error = billing_error', observation: null, probe: null, smoke: null });
    const text = formatReport({
      record: stopped,
      profile: sampleProfile(),
      profilePath: 'p.json',
      evaluation: evaluate(stopped, sampleProfile()),
      mode: 'live',
    });
    expect(text).toContain('**Result: ERROR** (exit 2)');
    expect(text).toContain('**Stopped:** probe stopped (auth): assistant.error = billing_error');
  });
});

describe('protocol (docs/cli-updates.md)', () => {
  it('appends a German row; a new file gets the header', () => {
    const record = sampleRecord({ cliVersion: '2.1.330', cost: { probeUsd: 0.003, smokeUsd: 0.006, totalUsd: 0.009, budgetUsd: 0.05 } });
    const green = protocolRow({
      date: new Date('2026-11-12T15:02:00.000Z'),
      previous: '2.1.322',
      record,
      evaluation: evaluate(record, sampleProfile({ cliVersion: '2.1.330' })),
    });
    expect(green).toBe('| 2026-11-12 | 2.1.322 → 2.1.330 | 0.3.322 | grün | 0,0090 |\n');
    const accepted = protocolRow({
      date: new Date('2026-11-12T15:02:00.000Z'),
      previous: null,
      record,
      evaluation: evaluate(record, sampleProfile({ tools: ['Bash'] })),
    });
    expect(accepted).toMatch(/^\| 2026-11-12 \| – → 2\.1\.330 \| 0\.3\.322 \| \d+ Abweichung(en)?, akzeptiert \| 0,0090 \|\n$/);

    const fresh = appendProtocol(null, green);
    expect(fresh.startsWith(PROTOCOL_HEADER)).toBe(true);
    expect(fresh.endsWith(green)).toBe(true);
    expect(appendProtocol('# x\n| a |', green)).toBe(`# x\n| a |\n${green}`);
    expect(appendProtocol(fresh, accepted)).toBe(`${fresh}${accepted}`);
  });

  it('the observation in the record keeps no account values', () => {
    const text = JSON.stringify(sampleRecord({ observation: sampleObservation() }));
    expect(text).not.toContain('email');
  });
});
