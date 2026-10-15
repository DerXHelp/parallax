import { render } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { SAMPLE_IDS, sampleId } from '@shared/samples';
import { focusDecision, registerDecisionFocusHandler, useDecisionFocusHandler } from './decision-focus';

const KEY = `local:${SAMPLE_IDS.entry}`;
const OTHER = sampleId('dc', 2);

function bar(sessionKey: string, decisionIds: readonly string[]) {
  const region = document.createElement('div');
  region.dataset.decisionBar = sessionKey;
  region.tabIndex = -1;
  for (const id of decisionIds) {
    const card = document.createElement('div');
    card.dataset.decisionId = id;
    card.tabIndex = -1;
    region.append(card);
  }
  document.body.append(region);
  return region;
}

afterEach(() => {
  document.body.replaceChildren();
});

describe('focusDecision (architecture §2.3e)', () => {
  it('focuses the card in the bar of the session, else the bar region', () => {
    const region = bar(KEY, [OTHER, SAMPLE_IDS.decision]);
    bar('local:en_ffffffffffffffffffffffffffffffff', [SAMPLE_IDS.decision]);
    expect(focusDecision(KEY, SAMPLE_IDS.decision)).toBe(true);
    expect(document.activeElement).toBe(region.querySelector(`[data-decision-id="${SAMPLE_IDS.decision}"]`));
    expect(focusDecision(KEY, sampleId('dc', 9))).toBe(true);
    expect(document.activeElement).toBe(region);
  });

  it('returns false when the session is not shown', () => {
    expect(focusDecision(KEY, SAMPLE_IDS.decision)).toBe(false);
  });

  it('prefers the handler of the DecisionBar (newest first) and falls back when it declines', () => {
    const region = bar(KEY, []);
    const declined = vi.fn(() => false);
    const remove = registerDecisionFocusHandler(KEY, declined);
    expect(focusDecision(KEY, SAMPLE_IDS.decision)).toBe(true);
    expect(declined).toHaveBeenCalledWith(SAMPLE_IDS.decision);
    expect(document.activeElement).toBe(region);
    remove();

    const handled = vi.fn(() => true);
    function Bar() {
      useDecisionFocusHandler(KEY, handled);
      return null;
    }
    const view = render(<Bar />);
    region.blur();
    expect(focusDecision(KEY, OTHER)).toBe(true);
    expect(handled).toHaveBeenCalledWith(OTHER);
    expect(document.activeElement).not.toBe(region);
    view.unmount();
    expect(focusDecision(KEY, OTHER)).toBe(true);
    expect(handled).toHaveBeenCalledTimes(1);
  });
});
