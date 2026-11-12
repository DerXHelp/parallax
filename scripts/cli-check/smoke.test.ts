import { describe, expect, it } from 'vitest';
import { parseLiveRun, parsePlaywrightReport } from './smoke';

function test(status: string, annotations: { type: string; description?: string }[] = [], error?: string) {
  return {
    status,
    annotations: [],
    results: [{ status: status === 'expected' ? 'passed' : 'failed', annotations, ...(error === undefined ? {} : { error: { message: error } }) }],
  };
}

const REPORT = {
  config: {},
  suites: [
    {
      title: 'live\\live.spec.ts',
      specs: [
        { title: 'the displayed claude version equals `claude --version`', tests: [test('expected')] },
        {
          title: 'Stop interrupts a running tool',
          tests: [test('unexpected', [], '\u001b[31mError: expect(locator).toHaveCount(expected)\u001b[39m\n\nCall log: …')],
        },
      ],
      suites: [
        {
          title: '',
          specs: [
            {
              title: 'real SDK data: no contract slip in the server log; usage within the budget',
              tests: [
                test('skipped', [
                  { type: 'live-cost-usd', description: '0.0055' },
                  { type: 'validation-drops', description: '0' },
                  { type: 'unknown-counts', description: '{"system/brand_new":1}' },
                ]),
              ],
            },
          ],
        },
      ],
    },
  ],
  errors: [{ message: 'Error: global setup failed\nstack' }],
  stats: { expected: 1, unexpected: 1, flaky: 0, skipped: 1, duration: 1, startTime: 'x' },
};

describe('parsePlaywrightReport (WP-62)', () => {
  it('counts, failures with their first error line (no ANSI) and the live annotations', () => {
    expect(parsePlaywrightReport(REPORT)).toEqual({
      passed: 1,
      failed: 1,
      skipped: 1,
      flaky: 0,
      failures: [
        { title: '(global)', message: 'Error: global setup failed' },
        { title: 'live\\live.spec.ts › Stop interrupts a running tool', message: 'Error: expect(locator).toHaveCount(expected)' },
      ],
      unknownCounts: { 'system/brand_new': 1 },
      validationDrops: 0,
    });
  });

  it('without annotations the live data stays unknown; a broken report throws', () => {
    const view = parsePlaywrightReport({ suites: [], errors: [], stats: { expected: 0, unexpected: 0, flaky: 0, skipped: 6 } });
    expect(view).toMatchObject({ skipped: 6, unknownCounts: null, validationDrops: null, failures: [] });
    expect(() => parsePlaywrightReport({ suites: [] })).toThrow();
  });

  it('parseLiveRun reads the fixture artifact', () => {
    expect(parseLiveRun({ root: 'C:\\Temp\\parallax-live-e2e-x', costUsd: 0.0054 })).toEqual({
      root: 'C:\\Temp\\parallax-live-e2e-x',
      costUsd: 0.0054,
    });
    expect(parseLiveRun({ root: 1 })).toBeNull();
    expect(parseLiveRun(undefined)).toBeNull();
  });
});
