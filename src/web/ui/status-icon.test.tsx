import { act, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { DISPLAY_STATUS_KINDS } from '@shared/status';
import { setLanguage, translate } from '@web/i18n';
import { Gauge, gaugeLevel } from './gauge';
import { STATUS_PRESENTATION, StatusIcon } from './status-icon';

afterEach(() => {
  act(() => {
    setLanguage('en');
  });
});

describe('StatusIcon', () => {
  it('has an icon and a text for every display status (never color only)', () => {
    for (const kind of DISPLAY_STATUS_KINDS) {
      expect(STATUS_PRESENTATION[kind].icon).toBeTruthy();
      const { container, unmount } = render(<StatusIcon kind={kind} />);
      expect(container.querySelector(`[data-status="${kind}"] svg`)).not.toBeNull();
      expect(screen.getByText(translate('en', `status.${kind}`)).className).toContain('sr-only');
      unmount();
    }
  });

  it('gives needs-resume its own icon', () => {
    const live = new Set([
      STATUS_PRESENTATION['needs-permission'].icon,
      STATUS_PRESENTATION['needs-answer'].icon,
      STATUS_PRESENTATION['needs-review'].icon,
    ]);
    expect(live.has(STATUS_PRESENTATION['needs-resume'].icon)).toBe(false);
  });

  it('shows the label visibly on request and follows the language', () => {
    render(<StatusIcon kind="needs-review" showLabel />);
    expect(screen.getByText('Plan ready for review').className).not.toContain('sr-only');
    act(() => {
      setLanguage('de');
    });
    expect(screen.getByText('Plan prüfen')).toBeTruthy();
  });
});

describe('Gauge', () => {
  it('maps levels at 70 % and 85 % and exposes a meter', () => {
    expect([gaugeLevel(69), gaugeLevel(70), gaugeLevel(84), gaugeLevel(85)]).toEqual([
      'normal',
      'warning',
      'warning',
      'danger',
    ]);
    render(<Gauge value={72} label="Context" />);
    const meter = screen.getByRole('meter', { name: 'Context' });
    expect(meter.getAttribute('aria-valuenow')).toBe('72');
    expect(meter.dataset.level).toBe('warning');
    expect(screen.getByText('72%')).toBeTruthy();
  });
});
