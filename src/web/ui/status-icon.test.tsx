import { act, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { DISPLAY_STATUS_KINDS } from '@shared/status';
import { setLanguage, translate } from '@web/i18n';
import { Gauge, gaugeLevel } from './gauge';
import { STATUS_PRESENTATION, StatusIcon } from './status-icon';

// The first test renders every status icon: 0.4 s in a full `pnpm test`, over 3 s when several
// runs load the machine (docs/wp/FLAKES.md).
vi.setConfig({ testTimeout: 30_000 });

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

  it('WP-71 pulse: working/starting strong, background soft – only motion-safe, instead of the spin', () => {
    const pulseOf = (kind: (typeof DISPLAY_STATUS_KINDS)[number], pulse = true) => {
      const { container, unmount } = render(<StatusIcon kind={kind} pulse={pulse} />);
      const root = container.querySelector<HTMLElement>('[data-slot="status-icon"]');
      const disc = container.querySelector<HTMLElement>('[data-slot="status-pulse"]');
      const svg = container.querySelector('svg');
      const result = {
        pulse: root?.dataset.pulse ?? null,
        disc: disc?.className ?? null,
        duration: disc?.style.animationDuration ?? null,
        spin: svg?.getAttribute('class')?.includes('animate-spin') ?? false,
      };
      unmount();
      return result;
    };
    const working = pulseOf('working');
    expect(working).toMatchObject({ pulse: 'strong', duration: '1.6s', spin: false });
    // The animation only with motion allowed; with "reduce motion" a calm dot stays.
    expect(working.disc).toContain('motion-safe:animate-ping');
    expect(
      working.disc?.split(/\s+/).filter((c) => c.includes('animate-') && !c.startsWith('motion-safe:')),
    ).toEqual([]);
    expect(working.disc).toContain('bg-status-working/30');
    expect(pulseOf('starting').pulse).toBe('strong');
    const background = pulseOf('background');
    expect(background).toMatchObject({ pulse: 'soft', duration: '3s' });
    expect(background.disc).toContain('bg-status-working/15');
    for (const kind of ['idle', 'done', 'sleeping', 'needs-permission', 'error'] as const) {
      expect(pulseOf(kind)).toMatchObject({ pulse: null, disc: null });
    }
    // Without `pulse` (header, decision cards): the spin as before, no disc.
    expect(pulseOf('working', false)).toMatchObject({ pulse: null, disc: null, spin: true });
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
