import { describe, expect, it } from 'vitest';
import { BUDGET_ENV, BUDGET_USD, budgetFromEnv } from './context';

describe('budgetFromEnv (recorder budget guard)', () => {
  it('defaults to the hard budget', () => {
    expect(budgetFromEnv({})).toBe(BUDGET_USD);
    expect(budgetFromEnv({ [BUDGET_ENV]: '  ' })).toBe(BUDGET_USD);
  });

  it('lowers the budget for one run', () => {
    expect(budgetFromEnv({ [BUDGET_ENV]: '0.75' })).toBe(0.75);
    expect(budgetFromEnv({ [BUDGET_ENV]: ` ${BUDGET_USD} ` })).toBe(BUDGET_USD);
  });

  it.each(['0', '-1', 'abc', String(BUDGET_USD + 0.01), 'Infinity'])('rejects %s', (value) => {
    expect(() => budgetFromEnv({ [BUDGET_ENV]: value })).toThrow(BUDGET_ENV);
  });
});
