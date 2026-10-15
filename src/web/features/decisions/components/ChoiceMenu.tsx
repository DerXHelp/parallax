import { ChevronDownIcon } from 'lucide-react';
import type { ReactNode } from 'react';
import { cn } from '@web/lib/cn';
import { Button } from '@web/ui/button';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
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

export interface MenuNote {
  key: string;
  label: string;
  hint?: string;
}

/**
 * The "▾" half of a split button: picks an option (radio), never answers by itself – the main
 * button answers (pointer or Mod+Enter only, card-shell.tsx). So keys typed into an open menu can
 * at most change the choice. `notes` are disabled entries (e.g. "With fresh context" in Phase 1).
 */
export function ChoiceMenu<V extends string>({
  label,
  heading,
  value,
  choices,
  onChange,
  notes = [],
  footer,
  disabled,
}: {
  label: string;
  heading: string;
  value: V;
  choices: readonly Choice<V>[];
  onChange: (value: V) => void;
  notes?: readonly MenuNote[];
  footer?: ReactNode;
  disabled?: boolean;
}) {
  return (
    <DropdownMenu modal={false}>
      <DropdownMenuTrigger asChild>
        <Button variant="outline" size="icon-sm" aria-label={label} title={label} disabled={disabled}>
          <ChevronDownIcon aria-hidden />
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
        {notes.length === 0 ? null : <DropdownMenuSeparator />}
        {notes.map((note) => (
          <DropdownMenuItem key={note.key} disabled className="items-start">
            <span className="grid min-w-0 gap-0.5">
              <span>{note.label}</span>
              {note.hint === undefined ? null : (
                <span className="text-muted-foreground text-2xs">{note.hint}</span>
              )}
            </span>
          </DropdownMenuItem>
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
