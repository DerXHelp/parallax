import { ChevronDownIcon } from 'lucide-react';
import type { ReactNode } from 'react';
import { cn } from '@web/lib/cn';
import { Button } from '@web/ui/button';
import {
  DropdownMenu,
  DropdownMenuCheckboxItem,
  DropdownMenuContent,
  DropdownMenuLabel,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@web/ui/dropdown-menu';

export interface Choice<V extends string> {
  value: V;
  label: string;
  hint?: string;
  /** Warning shown next to the label (icon + text, never color only). */
  badge?: ReactNode;
  destructive?: boolean;
}

/** An on/off part of the choice below the options (e.g. "With fresh context", WP-56). */
export interface MenuToggle {
  key: string;
  label: string;
  hint?: string;
  /** Shown next to the label (e.g. "Recommended" with a tooltip). */
  badge?: ReactNode;
  checked: boolean;
  onCheckedChange: (checked: boolean) => void;
}

/**
 * The "▾" half of a split button: picks an option (radio) and switches `toggles`, never answers by
 * itself – the main button answers (pointer or Mod+Enter only, card-shell.tsx). So keys typed into
 * an open menu can at most change the choice. A toggle keeps the menu open (the user may pick an
 * option next); `indicator` marks the trigger with a dot (e.g. a recommended toggle, the menu says
 * why).
 */
export function ChoiceMenu<V extends string>({
  label,
  heading,
  value,
  choices,
  onChange,
  toggles = [],
  footer,
  disabled,
  indicator = false,
}: {
  label: string;
  heading: string;
  value: V;
  choices: readonly Choice<V>[];
  onChange: (value: V) => void;
  toggles?: readonly MenuToggle[];
  footer?: ReactNode;
  disabled?: boolean;
  indicator?: boolean;
}) {
  return (
    <DropdownMenu modal={false}>
      <DropdownMenuTrigger asChild>
        <Button
          variant="outline"
          size="icon-sm"
          aria-label={label}
          title={label}
          disabled={disabled}
          className="relative"
        >
          <ChevronDownIcon aria-hidden />
          {indicator ? (
            <span
              aria-hidden
              data-slot="choice-menu-indicator"
              className="bg-info ring-background absolute -top-0.5 -right-0.5 size-2 rounded-full ring-2"
            />
          ) : null}
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" className="max-w-80">
        <DropdownMenuLabel>{heading}</DropdownMenuLabel>
        <DropdownMenuRadioGroup
          value={value}
          onValueChange={(next) => {
            const choice = choices.find((candidate) => candidate.value === next);
            if (choice !== undefined) onChange(choice.value);
          }}
        >
          {choices.map((choice) => (
            <DropdownMenuRadioItem
              key={choice.value}
              value={choice.value}
              className={cn('items-start', choice.destructive === true && 'text-destructive')}
            >
              <span className="grid min-w-0 gap-0.5">
                <span className="flex flex-wrap items-center gap-1.5">
                  {choice.label}
                  {choice.badge}
                </span>
                {choice.hint === undefined ? null : (
                  <span className="text-muted-foreground text-2xs">{choice.hint}</span>
                )}
              </span>
            </DropdownMenuRadioItem>
          ))}
        </DropdownMenuRadioGroup>
        {toggles.length === 0 ? null : <DropdownMenuSeparator />}
        {toggles.map((toggle) => (
          <DropdownMenuCheckboxItem
            key={toggle.key}
            data-toggle={toggle.key}
            checked={toggle.checked}
            className="items-start"
            onCheckedChange={(checked) => {
              toggle.onCheckedChange(checked);
            }}
            onSelect={(event) => {
              event.preventDefault();
            }}
          >
            <span className="grid min-w-0 gap-0.5">
              <span className="flex flex-wrap items-center gap-1.5">
                {toggle.label}
                {toggle.badge}
              </span>
              {toggle.hint === undefined ? null : (
                <span className="text-muted-foreground text-2xs">{toggle.hint}</span>
              )}
            </span>
          </DropdownMenuCheckboxItem>
        ))}
        {footer === undefined ? null : (
          <>
            <DropdownMenuSeparator />
            <div className="text-muted-foreground max-w-76 px-2 py-1 text-2xs">{footer}</div>
          </>
        )}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
