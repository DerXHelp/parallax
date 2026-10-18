import { render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { LOCAL_HOST_ID, makeSessionKey } from '@shared/common';
import { SAMPLE_IDS, sampleContextGauge, sampleHostState, sampleSummary } from '@shared/samples';
import { clientStore, emptyHostRecord, resetClientStore } from '@web/state/store';
import { TooltipProvider } from '@web/ui/tooltip';
import { SessionHeader } from './SessionHeader';

const KEY = makeSessionKey(LOCAL_HOST_ID, SAMPLE_IDS.entry);

afterEach(() => {
  resetClientStore();
});

describe('SessionHeader layout (V3-05)', () => {
  it('only path and model shrink (with an ellipsis); CLI version, mode and context keep their width', () => {
    clientStore.setState({
      hosts: {
        [LOCAL_HOST_ID]: {
          ...emptyHostRecord(LOCAL_HOST_ID),
          hostState: sampleHostState(),
          summaries: {
            [SAMPLE_IDS.entry]: sampleSummary({
              title: 'Ein sehr langer Sessiontitel '.repeat(4).trim(),
              cwd: 'D:\\proj\\beta-mit-einem-sehr-langen-ordnernamen-fuer-den-lauf-der-kopfzeile',
              model: 'claude-opus-5-5',
              cliVersion: '2.1.300',
              permissionMode: 'acceptEdits',
              context: sampleContextGauge({ percentage: 40 }),
            }),
          },
        },
      },
    });
    render(
      <TooltipProvider>
        <SessionHeader sessionKey={KEY} />
      </TooltipProvider>,
    );
    const facts = document.querySelector('[data-slot="header-facts"]');
    if (facts === null) throw new Error('facts missing');
    const items = [...facts.children];
    expect(items.length).toBeGreaterThanOrEqual(5);
    for (const item of items) {
      // A fact that may shrink must truncate; everything else never shrinks (no overlap).
      const truncates = item.querySelector('.truncate') !== null;
      expect(truncates || item.classList.contains('shrink-0')).toBe(true);
    }
    const cli = document.querySelector('[data-slot="header-cli-version"]')?.parentElement;
    expect(cli?.classList.contains('shrink-0')).toBe(true);
    expect(cli?.classList.contains('min-w-0')).toBe(false);
    // The title gives way first.
    expect(screen.getByRole('heading', { level: 1 }).className).toContain('shrink-[8]');
  });
});

describe('SessionHeader folder (WP41-02)', () => {
  function showCwd(cwd: string): void {
    clientStore.setState({
      hosts: {
        [LOCAL_HOST_ID]: {
          ...emptyHostRecord(LOCAL_HOST_ID),
          hostState: sampleHostState(),
          summaries: { [SAMPLE_IDS.entry]: sampleSummary({ cwd }) },
        },
      },
    });
  }

  function headerPath(): HTMLElement {
    const element = document.querySelector<HTMLElement>('[data-slot="header-path"]');
    if (element === null) throw new Error('no folder in the header');
    return element;
  }

  it('sibling project folders under one long folder stay apart: the last segment never shrinks', () => {
    showCwd('C:\\Users\\me\\AppData\\Local\\Temp\\parallax-live2-20261018-183959\\p1');
    render(
      <TooltipProvider>
        <SessionHeader sessionKey={KEY} />
      </TooltipProvider>,
    );
    expect(headerPath().textContent).toBe('parallax-live2-20261018-183959\\p1');
    const head = headerPath().querySelector('[data-slot="path-head"]');
    expect(head?.textContent).toBe('parallax-live2-20261018-183959');
    expect(head?.className.split(' ')).toEqual(expect.arrayContaining(['min-w-0', 'truncate']));
    const last = headerPath().querySelector('[data-slot="path-last"]');
    expect(last?.textContent).toBe('\\p1');
    expect(last?.className.split(' ')).toContain('shrink-0');
  });
});
