import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { useState } from 'react';
import { describe, expect, it, vi } from 'vitest';
import {
  CommandInput,
  CommandList,
  commandOptionId,
  handleCommandKey,
  type CommandModifiers,
} from './command-list';

const ITEMS = ['Alpha', 'Beta', 'Gamma'];

function Picker({
  onSelect,
  items = ITEMS,
}: {
  onSelect: (item: string, modifiers: CommandModifiers) => void;
  items?: string[];
}) {
  const [active, setActive] = useState(0);
  return (
    <>
      <CommandInput
        listId="list"
        activeIndex={active}
        count={items.length}
        aria-label="Search"
        onKeyDown={(event) => {
          handleCommandKey(event, {
            count: items.length,
            activeIndex: active,
            onActiveIndexChange: setActive,
            onSelectActive: (modifiers) => {
              const item = items[active];
              if (item !== undefined) onSelect(item, modifiers);
            },
          });
        }}
      />
      <CommandList
        id="list"
        label="Results"
        items={items}
        getKey={(item) => item}
        activeIndex={active}
        onActiveIndexChange={setActive}
        onSelect={onSelect}
        empty="Nothing"
        renderItem={(item) => <span>{item}</span>}
      />
    </>
  );
}

describe('CommandList (ui)', () => {
  it('is a combobox + listbox; arrows move cyclically, Enter and Shift+Enter select', async () => {
    const onSelect = vi.fn();
    const user = userEvent.setup();
    render(<Picker onSelect={onSelect} />);
    const input = screen.getByRole('combobox', { name: 'Search' });
    expect(input.getAttribute('aria-controls')).toBe('list');
    expect(input.getAttribute('aria-activedescendant')).toBe(commandOptionId('list', 0));
    expect(screen.getByRole('listbox', { name: 'Results' })).toBeTruthy();
    expect(screen.getAllByRole('option').map((option) => option.getAttribute('aria-selected'))).toEqual([
      'true',
      'false',
      'false',
    ]);
    await user.click(input);
    await user.keyboard('{ArrowUp}');
    expect(input.getAttribute('aria-activedescendant')).toBe(commandOptionId('list', 2));
    await user.keyboard('{ArrowDown}');
    expect(input.getAttribute('aria-activedescendant')).toBe(commandOptionId('list', 0));
    await user.keyboard('{ArrowDown}{Enter}');
    expect(onSelect).toHaveBeenLastCalledWith('Beta', expect.objectContaining({ shiftKey: false }));
    await user.keyboard('{Shift>}{Enter}{/Shift}');
    expect(onSelect).toHaveBeenLastCalledWith('Beta', expect.objectContaining({ shiftKey: true }));
  });

  it('selects on click with the click modifiers and shows the empty text', async () => {
    const onSelect = vi.fn();
    const user = userEvent.setup();
    const view = render(<Picker onSelect={onSelect} />);
    await user.click(screen.getByRole('option', { name: 'Gamma' }));
    expect(onSelect).toHaveBeenLastCalledWith('Gamma', expect.objectContaining({ shiftKey: false }));
    view.rerender(<Picker onSelect={onSelect} items={[]} />);
    expect(screen.getByText('Nothing')).toBeTruthy();
    expect(screen.getByRole('combobox').getAttribute('aria-activedescendant')).toBeNull();
  });
});
