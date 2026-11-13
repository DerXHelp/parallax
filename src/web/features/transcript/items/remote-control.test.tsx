/**
 * WP-64 §1.4 in the transcript: a prompt typed in the Claude app carries the hint "From the Claude
 * app"; a decision answered there reads "Answered in the Claude app" (en/de).
 */
import { render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { sampleItems, sampleOutcomes } from '@shared/samples';
import { setLanguage, t } from '@web/i18n';
import { resetClientStore } from '@web/state/store';
import { resetExpansion } from '../state/expansion';
import { decisionOutcomeText } from './decision-outcome';
import { UserMessageRow } from './MessageRows';

afterEach(() => {
  setLanguage('en');
  resetClientStore();
  resetExpansion();
});

const KEY = 'local:en_00000000000000000000000000000001';

describe('prompt from the Claude app (WP-64)', () => {
  it('source remote → the hint; a local prompt has none', () => {
    const { container, unmount } = render(
      <UserMessageRow item={sampleItems.userMessage({ id: 'px:user:remote', source: 'remote' })} sessionKey={KEY} />,
    );
    expect(container.querySelector('[data-slot="user-remote"]')?.textContent).toBe('From the Claude app');
    unmount();
    const local = render(<UserMessageRow item={sampleItems.userMessage({ id: 'px:user:local' })} sessionKey={KEY} />);
    expect(local.container.querySelector('[data-slot="user-remote"]')).toBeNull();
  });

  it('German text', () => {
    setLanguage('de');
    render(
      <UserMessageRow item={sampleItems.userMessage({ id: 'px:user:remote-de', source: 'remote' })} sessionKey={KEY} />,
    );
    expect(screen.getByText('Aus der Claude-App')).toBeTruthy();
  });
});

describe('decision answered in the Claude app (WP-64)', () => {
  it('outcome answered_elsewhere → quiet text, en and de', () => {
    expect(decisionOutcomeText(sampleOutcomes.answered_elsewhere, t)).toEqual({
      text: 'Answered in the Claude app',
      tone: 'muted',
    });
    setLanguage('de');
    expect(decisionOutcomeText(sampleOutcomes.answered_elsewhere, t).text).toBe('In der Claude-App beantwortet');
  });
});
