import { act, render } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { LOCAL_HOST_ID, makeSessionKey } from '@shared/common';
import type { SessionSummary } from '@shared/model';
import {
  SAMPLE_IDS,
  sampleContextGauge,
  sampleHostState,
  sampleId,
  sampleProfileSummary,
  sampleSummary,
  sampleTime,
} from '@shared/samples';
import { setLanguage } from '@web/i18n';
import { clientStore, emptyHostRecord, resetClientStore } from '@web/state/store';
import { TooltipProvider } from '@web/ui/tooltip';
import { SessionRow } from './navigation/SessionRow';
import { SessionHeader } from './SessionHeader';

/**
 * WP-63 §1.1 (effective effort) and §1.4 (context: fill up to the autocompact, color by the share
 * of the model window, "autocompact soon" as its own symbol) in the session header and the row.
 */

const KEY = makeSessionKey(LOCAL_HOST_ID, SAMPLE_IDS.entry);
const PROFILE = sampleProfileSummary({ defaults: { model: null, permissionMode: null, effort: 'high' } });

/** 1M window, autocompact at 400K (the example of the WP). */
const NEAR_COMPACT = sampleContextGauge({
  totalTokens: 380_000,
  maxTokens: 1_000_000,
  percentage: 38,
  autoCompactThreshold: 400_000,
  isAutoCompactEnabled: true,
});
/** 200K window without autocompact: 85 % of the window → red. */
const FULL_WINDOW = sampleContextGauge({
  totalTokens: 170_000,
  maxTokens: 200_000,
  percentage: 85,
  autoCompactThreshold: null,
  isAutoCompactEnabled: false,
});

afterEach(() => {
  act(() => {
    setLanguage('en');
  });
  resetClientStore();
});

function show(summary: SessionSummary): void {
  clientStore.setState({
    hosts: {
      [LOCAL_HOST_ID]: {
        ...emptyHostRecord(LOCAL_HOST_ID),
        hostState: sampleHostState({ profiles: [PROFILE] }),
        summaries: { [SAMPLE_IDS.entry]: summary },
      },
    },
  });
}

function slot(name: string): HTMLElement | null {
  return document.querySelector<HTMLElement>(`[data-slot="${name}"]`);
}

function renderHeader(): void {
  render(
    <TooltipProvider>
      <SessionHeader sessionKey={KEY} />
    </TooltipProvider>,
  );
}

describe('session header (WP-63 §1.1, §1.4)', () => {
  it('effort: the profile default while the session has none, then its own value', () => {
    show(sampleSummary({ profileId: PROFILE.id, model: 'claude-opus-5-5', effort: null }));
    renderHeader();
    expect(slot('header-effort')?.dataset.effort).toBe('high');
    expect(slot('header-effort')?.textContent).toBe('·high');
    act(() => {
      show(sampleSummary({ profileId: PROFILE.id, model: 'claude-opus-5-5', effort: 'xhigh' }));
    });
    expect(slot('header-effort')?.textContent).toBe('·extra high');
    act(() => {
      setLanguage('de');
    });
    expect(slot('header-effort')?.textContent).toBe('·sehr hoch');
  });

  it('no effort anywhere: nothing next to the model', () => {
    show(sampleSummary({ profileId: sampleId('pf', 9), effort: null }));
    renderHeader();
    expect(slot('header-effort')).toBeNull();
  });

  it('context near the autocompact: full bar, neutral color, the symbol and its text', () => {
    show(sampleSummary({ context: NEAR_COMPACT }));
    renderHeader();
    const context = slot('header-context');
    const meter = context?.querySelector<HTMLElement>('[role="meter"]');
    expect(meter?.dataset.level).toBe('normal');
    expect(meter?.getAttribute('aria-valuenow')).toBe('95');
    expect(meter?.getAttribute('aria-valuetext')).toBe(
      '380K of 400K until autocompact · model 1M (38%) · Autocompact in about 20K',
    );
    expect(context?.dataset.compactSoon).toBe('true');
    expect(context?.querySelector('[data-slot="context-compact-soon"]')).not.toBeNull();
    expect(meter?.textContent).toContain('380K');
  });

  it('context without autocompact: fill and color follow the model window (85 % → danger)', () => {
    show(sampleSummary({ context: FULL_WINDOW }));
    renderHeader();
    const context = slot('header-context');
    const meter = context?.querySelector<HTMLElement>('[role="meter"]');
    expect(meter?.dataset.level).toBe('danger');
    expect(meter?.getAttribute('aria-valuenow')).toBe('85');
    expect(meter?.getAttribute('aria-valuetext')).toBe('170K of 200K (85%)');
    expect(context?.dataset.compactSoon).toBeUndefined();
  });
});

describe('sidebar row (WP-63 §1.1, §1.4)', () => {
  function renderRow(summary: SessionSummary, profileEffort: 'high' | null = null): void {
    render(
      <TooltipProvider>
        <ul>
          <SessionRow
            entry={{ sessionKey: KEY, hostId: LOCAL_HOST_ID, summary }}
            statusKind="idle"
            unread={false}
            now={Date.parse(sampleTime(120))}
            selected={false}
            tabStop
            profileColor={null}
            profileName={null}
            profileEffort={profileEffort}
            requiredCli={null}
            showPath
            onSelect={() => undefined}
          />
        </ul>
      </TooltipProvider>,
    );
  }

  it('short effort (own value before the profile default) and the context rule', () => {
    renderRow(sampleSummary({ effort: 'medium', context: NEAR_COMPACT }), 'high');
    expect(slot('row-effort')?.dataset.effort).toBe('medium');
    expect(slot('row-effort')?.textContent).toBe('Effortmed');
    const context = slot('row-context');
    expect(context?.dataset.level).toBe('normal');
    expect(context?.dataset.compactSoon).toBe('true');
    expect(context?.textContent).toContain('380K');
    expect(context?.textContent).toContain('Autocompact soon');
  });

  it('the profile default when the session has none; 85 % of the window is red', () => {
    renderRow(sampleSummary({ effort: null, context: FULL_WINDOW }), 'high');
    expect(slot('row-effort')?.dataset.effort).toBe('high');
    expect(slot('row-context')?.dataset.level).toBe('danger');
    expect(slot('row-context')?.dataset.compactSoon).toBeUndefined();
  });
});
