import { ChevronDownIcon } from 'lucide-react';
import { useId } from 'react';
import { cn } from '@web/lib/cn';
import { Button } from '@web/ui/button';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuTrigger,
} from '@web/ui/dropdown-menu';

/** Value of the "not set" option (radio values are strings). */
const NONE = '__none__';

export interface MenuOption<T extends string> {
  value: T | null;
  label: string;
  hint?: string;
  /** Red, e.g. "Bypass permissions" (C.3). */
  destructive?: boolean;
}

/**
 * A compact choice in a dropdown menu (the picker pattern of the composer): the trigger shows the
 * chosen label, the accessible name is "<visible label> <chosen label>".
 */
export function OptionMenu<T extends string>({
  id,
  labelId,
  value,
  options,
  onChange,
  invalid = false,
  slot,
}: {
  id: string;
  labelId: string;
  value: T | null;
  options: readonly MenuOption<T>[];
  onChange: (value: T | null) => void;
  invalid?: boolean;
  slot?: string;
}) {
  const valueId = useId();
  const chosen = options.find((option) => option.value === value) ?? null;
  return (
    <DropdownMenu modal={false}>
      <DropdownMenuTrigger asChild>
        <Button
          id={id}
          variant="outline"
          data-slot={slot}
          data-value={value ?? ''}
          aria-labelledby={`${labelId} ${valueId}`}
          aria-invalid={invalid ? true : undefined}
          className={cn(
            // Shrinks with its column; the label ends with an ellipsis instead of overflowing (V3-06).
            'w-full min-w-0 justify-between font-normal',
            chosen?.destructive === true && 'text-destructive hover:text-destructive',
          )}
        >
          <span id={valueId} className="min-w-0 truncate" title={chosen?.label}>
            {chosen?.label ?? value ?? ''}
          </span>
          <ChevronDownIcon aria-hidden className="text-muted-foreground size-3.5" />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" className="w-(--radix-dropdown-menu-trigger-width) min-w-56">
        <DropdownMenuRadioGroup
          value={value ?? NONE}
          onValueChange={(next) => {
            const option = options.find((candidate) => (candidate.value ?? NONE) === next);
            if (option !== undefined) onChange(option.value);
          }}
        >
          {options.map((option) => (
            <DropdownMenuRadioItem
              key={option.value ?? NONE}
              value={option.value ?? NONE}
              className={cn('items-start', option.destructive === true && 'text-destructive')}
            >
              <span className="grid min-w-0 gap-0.5">
                <span>{option.label}</span>
                {option.hint === undefined ? null : (
                  <span className="text-muted-foreground text-2xs">{option.hint}</span>
                )}
              </span>
            </DropdownMenuRadioItem>
          ))}
        </DropdownMenuRadioGroup>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
