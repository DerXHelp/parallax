import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { useState } from 'react';
import { describe, expect, it } from 'vitest';
import { Disclosure } from './disclosure';

function Controlled() {
  const [open, setOpen] = useState(false);
  return (
    <>
      <span data-testid="state">{open ? 'open' : 'closed'}</span>
      <Disclosure
        open={open}
        onOpenChange={setOpen}
        header={<span>Details</span>}
        actions={<button>Copy</button>}
      >
        <p>Body</p>
      </Disclosure>
    </>
  );
}

describe('Disclosure', () => {
  it('uncontrolled: a real button with aria-expanded, the body mounts only while open', async () => {
    const user = userEvent.setup();
    render(
      <Disclosure header={<span>Input</span>} label="Show input">
        <p>Body</p>
      </Disclosure>,
    );
    const trigger = screen.getByRole('button', { name: 'Show input' });
    expect(trigger.tagName).toBe('BUTTON');
    expect(trigger.getAttribute('aria-expanded')).toBe('false');
    expect(screen.queryByText('Body')).toBeNull();
    await user.click(trigger);
    expect(trigger.getAttribute('aria-expanded')).toBe('true');
    expect(screen.getByText('Body')).toBeTruthy();
  });

  it('respects defaultOpen and toggles with the keyboard', async () => {
    const user = userEvent.setup();
    render(
      <Disclosure defaultOpen header={<span>Change</span>}>
        <p>Diff</p>
      </Disclosure>,
    );
    expect(screen.getByText('Diff')).toBeTruthy();
    screen.getByRole('button', { name: 'Change' }).focus();
    await user.keyboard('{Enter}');
    expect(screen.queryByText('Diff')).toBeNull();
  });

  it('controlled: reports changes; actions sit outside the toggle', async () => {
    const user = userEvent.setup();
    render(<Controlled />);
    await user.click(screen.getByRole('button', { name: 'Copy' }));
    expect(screen.getByTestId('state').textContent).toBe('closed');
    await user.click(screen.getByRole('button', { name: 'Details' }));
    expect(screen.getByTestId('state').textContent).toBe('open');
    expect(screen.getByText('Body')).toBeTruthy();
  });
});
