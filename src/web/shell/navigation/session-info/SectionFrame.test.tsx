import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { makeError } from '@shared/errors';
import { SectionFrame } from './SectionFrame';
import type { InfoLoad, SessionInfoQuery } from './use-session-info';

function query(
  load: InfoLoad<'status'>,
  extra: Partial<SessionInfoQuery<'status'>> = {},
): SessionInfoQuery<'status'> {
  return { load, busy: false, error: null, refresh: vi.fn(), start: vi.fn(), ...extra };
}

const READY: InfoLoad<'status'> = {
  kind: 'ready',
  data: {
    section: 'status',
    groups: [{ title: 'Session', rows: [{ label: 'cwd', value: 'D:\\work' }] }],
    extra: [],
  },
};

function renderFrame(q: SessionInfoQuery<'status'>) {
  return render(
    <SectionFrame query={q} toolbar={<button type="button">Tool</button>}>
      {(data) => <p>{data.groups[0]?.rows[0]?.value}</p>}
    </SectionFrame>,
  );
}

describe('SectionFrame (WP-67 tab states)', () => {
  it('loading: a status line, refresh off while busy, no toolbar yet', () => {
    renderFrame(query({ kind: 'loading' }, { busy: true }));
    expect(screen.getByRole('status').textContent).toContain('Asking Claude Code…');
    expect(screen.getByRole('button', { name: 'Refresh' }).hasAttribute('disabled')).toBe(true);
    expect(screen.queryByRole('button', { name: 'Tool' })).toBeNull();
  });

  it('ready: the data, the toolbar and "Refresh"', async () => {
    const q = query(READY);
    renderFrame(q);
    expect(screen.getByText('D:\\work')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Tool' })).toBeTruthy();
    await userEvent.setup().click(screen.getByRole('button', { name: 'Refresh' }));
    expect(q.refresh).toHaveBeenCalledTimes(1);
  });

  it('a failed refresh keeps the data and shows the error above it', () => {
    renderFrame(
      query(READY, { error: makeError('CLAUDE_CONTROL_FAILED', { method: 'readInfo', section: 'status' }) }),
    );
    expect(screen.getByRole('alert').textContent).toContain('This section could not be loaded');
    expect(screen.getByText('D:\\work')).toBeTruthy();
  });

  it('an action error with the CLI text shows that text', () => {
    renderFrame(
      query({
        kind: 'failed',
        error: makeError('CLAUDE_CONTROL_FAILED', {
          method: 'reload',
          detail: 'Fake: the CLI refused the request',
        }),
      }),
    );
    expect(screen.getByRole('alert').textContent).toContain('Details: Fake: the CLI refused the request');
  });

  it('unavailable: a calm note, no error', () => {
    renderFrame(query({ kind: 'unavailable' }));
    expect(screen.getByText('Not available with this claude version.')).toBeTruthy();
    expect(screen.queryByRole('alert')).toBeNull();
  });

  it('not running: "Start session" calls start, refresh is off', async () => {
    const q = query({ kind: 'notRunning' });
    renderFrame(q);
    expect(screen.getByRole('button', { name: 'Refresh' }).hasAttribute('disabled')).toBe(true);
    await userEvent.setup().click(screen.getByRole('button', { name: 'Start session' }));
    expect(q.start).toHaveBeenCalledTimes(1);
  });
});
