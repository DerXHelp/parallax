/**
 * WP-84: the public-repo check over this repository's files – part of `pnpm test`/`pnpm check`.
 * With the local list (<git-common-dir>/public-check.local) it also checks the private terms;
 * without it (CI, fresh clone) only the general rules apply. Output names file, line and rule only.
 */
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { PRIVATE_LIST_NAME, trackedFiles } from './git';
import { SCRIPT_CHECKOUT, formatFinding, loadContext, scanFiles } from './scan';

const SCAN_TIMEOUT_MS = 120_000;

describe('public repo', () => {
  it(
    'has no private data in its files',
    async () => {
      const context = await loadContext(SCRIPT_CHECKOUT);
      const findings = await scanFiles(SCRIPT_CHECKOUT, context);
      expect(findings.map(formatFinding)).toEqual([]);
    },
    SCAN_TIMEOUT_MS,
  );

  it('never tracks the local list', async () => {
    const tracked = await trackedFiles(SCRIPT_CHECKOUT);
    const lists = tracked.filter(
      (file) => path.posix.basename(file).replace(/^\./u, '') === PRIVATE_LIST_NAME,
    );
    expect(lists).toEqual([]);
  });
});
