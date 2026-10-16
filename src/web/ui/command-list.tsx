import { useEffect, useRef, type ComponentProps, type KeyboardEvent, type ReactNode } from 'react';
import { cn } from '@web/lib/cn';
import { Input } from './input';

/**
 * Searchable command list (combobox pattern, WAI-ARIA 1.2): the focus stays in the search field
 * (`CommandInput`, `role="combobox"`), the list (`CommandList`, `role="listbox"`) marks the active
 * option via `aria-activedescendant`. Arrows move (cyclic), Enter selects – Shift/Ctrl/Alt are passed
 * on (e.g. Shift+Enter = "open in a new window"). Filtering is the caller's job (`lib/fuzzy.ts`).
 */

export interface CommandModifiers {
  shiftKey: boolean;
  ctrlKey: boolean;
  altKey: boolean;
  metaKey: boolean;
}

/** DOM id of option `index` of the list `listId` (for `aria-activedescendant`). */
export function commandOptionId(listId: string, index: number): string {
  return `${listId}-option-${String(index)}`;
}

/** Rows moved by PageUp/PageDown. */
const PAGE = 8;

export interface CommandKeyState {
  count: number;
  activeIndex: number;
  onActiveIndexChange: (index: number) => void;
  /** Enter on the active option. */
  onSelectActive: (modifiers: CommandModifiers) => void;
}

/**
 * Key handling of the search field: ArrowUp/ArrowDown (cyclic), PageUp/PageDown, Enter. Returns true
 * (and prevents the default) when it handled the key; Esc is left to the surrounding dialog.
 */
export function handleCommandKey(event: KeyboardEvent<HTMLElement>, state: CommandKeyState): boolean {
  const { count, activeIndex } = state;
  if (event.nativeEvent.isComposing) return false;
  let next: number | null = null;
  switch (event.key) {
    case 'ArrowDown':
      next = count === 0 ? -1 : (activeIndex + 1 + count) % count;
      break;
    case 'ArrowUp':
      next = count === 0 ? -1 : activeIndex <= 0 ? count - 1 : activeIndex - 1;
      break;
    case 'PageDown':
      next = count === 0 ? -1 : Math.min(count - 1, Math.max(0, activeIndex) + PAGE);
      break;
    case 'PageUp':
      next = count === 0 ? -1 : Math.max(0, activeIndex - PAGE);
      break;
    case 'Enter':
      if (activeIndex < 0 || activeIndex >= count) return false;
      event.preventDefault();
      state.onSelectActive({
        shiftKey: event.shiftKey,
        ctrlKey: event.ctrlKey,
        altKey: event.altKey,
        metaKey: event.metaKey,
      });
      return true;
    default:
      return false;
  }
  event.preventDefault();
  state.onActiveIndexChange(next);
  return true;
}

export interface CommandInputProps extends Omit<ComponentProps<'input'>, 'role'> {
  /** Id of the `CommandList`. */
  listId: string;
  activeIndex: number;
  /** Number of options (no active descendant without options). */
  count: number;
}

/** The search field of a command list; `aria-label`/`placeholder` from `t()`. */
export function CommandInput({ listId, activeIndex, count, className, ...props }: CommandInputProps) {
  const active = activeIndex >= 0 && activeIndex < count ? commandOptionId(listId, activeIndex) : undefined;
  return (
    <Input
      role="combobox"
      aria-expanded={true}
      aria-controls={listId}
      aria-autocomplete="list"
      aria-activedescendant={active}
      autoComplete="off"
      spellCheck={false}
      data-slot="command-input"
      className={cn('h-8', className)}
      {...props}
    />
  );
}

export interface CommandListProps<T> {
  /** DOM id (the input's `aria-controls`). */
  id: string;
  /** Accessible name, from `t()`. */
  label: string;
  items: readonly T[];
  getKey: (item: T) => string;
  renderItem: (item: T, state: { active: boolean; index: number }) => ReactNode;
  activeIndex: number;
  onActiveIndexChange: (index: number) => void;
  onSelect: (item: T, modifiers: CommandModifiers) => void;
  /** Shown instead of the list when there are no items (text from `t()`). */
  empty?: ReactNode;
  className?: string;
}

/** The options; a click selects (with the modifiers of the click), hovering moves the active option. */
export function CommandList<T>({
  id,
  label,
  items,
  getKey,
  renderItem,
  activeIndex,
  onActiveIndexChange,
  onSelect,
  empty,
  className,
}: CommandListProps<T>) {
  const listRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (activeIndex < 0) return;
    const option = listRef.current?.querySelector<HTMLElement>(`[data-index="${String(activeIndex)}"]`);
    // happy-dom and old engines may lack scrollIntoView.
    if (typeof option?.scrollIntoView === 'function') option.scrollIntoView({ block: 'nearest' });
  }, [activeIndex]);
  return (
    <div
      ref={listRef}
      id={id}
      role="listbox"
      aria-label={label}
      data-slot="command-list"
      className={cn('grid max-h-80 grid-cols-[minmax(0,1fr)] gap-px overflow-y-auto', className)}
    >
      {items.length === 0 && empty !== undefined ? (
        <div role="presentation" className="text-muted-foreground px-2 py-6 text-center text-xs">
          {empty}
        </div>
      ) : null}
      {items.map((item, index) => {
        const active = index === activeIndex;
        return (
          <div
            key={getKey(item)}
            id={commandOptionId(id, index)}
            role="option"
            aria-selected={active}
            data-index={index}
            data-active={active ? '' : undefined}
            // Keep the focus in the search field.
            onMouseDown={(event) => {
              event.preventDefault();
            }}
            onMouseMove={() => {
              if (!active) onActiveIndexChange(index);
            }}
            onClick={(event) => {
              onSelect(item, {
                shiftKey: event.shiftKey,
                ctrlKey: event.ctrlKey,
                altKey: event.altKey,
                metaKey: event.metaKey,
              });
            }}
            className={cn(
              'flex min-w-0 cursor-default items-center gap-2 rounded-sm px-2 py-1.5 text-ui select-none',
              active && 'bg-accent text-accent-foreground',
            )}
          >
            {renderItem(item, { active, index })}
          </div>
        );
      })}
    </div>
  );
}
