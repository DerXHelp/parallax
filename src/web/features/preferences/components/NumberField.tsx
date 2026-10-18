import { useId, useState } from 'react';
import { useT } from '@web/i18n';
import { cn } from '@web/lib/cn';
import { Input } from '@web/ui/input';
import { parseWholeNumber, type NumberRange } from '../lib/limits';

function textOf(value: number | null): string {
  return value === null ? '' : String(value);
}

/**
 * Whole-number setting (port, minutes, seconds): edited as text, saved on Enter or when the field
 * loses the focus – never per keystroke. An invalid entry stays in the field with an error next to
 * it (`aria-invalid`) and saves nothing; a value from outside (server ack, rollback) shows as soon
 * as the field is not being edited.
 */
export function NumberField({
  id,
  describedBy,
  value,
  range,
  allowEmpty = false,
  disabled = false,
  placeholder,
  unit,
  onCommit,
}: {
  id: string;
  describedBy?: string | undefined;
  value: number | null;
  range: NumberRange;
  /** Empty = null (e.g. the default port). */
  allowEmpty?: boolean;
  disabled?: boolean;
  /** From `t()`. */
  placeholder?: string;
  /** Unit after the field (from `t()`), e.g. "minutes". */
  unit?: string;
  onCommit: (value: number | null) => void;
}) {
  const t = useT();
  const errorId = useId();
  /** Text while editing; null = show `value`. */
  const [draft, setDraft] = useState<string | null>(null);
  const [invalid, setInvalid] = useState(false);

  const commit = () => {
    if (draft === null) return;
    const parsed = parseWholeNumber(draft, range, allowEmpty);
    if (parsed === undefined) {
      setInvalid(true);
      return;
    }
    setInvalid(false);
    setDraft(null);
    if (parsed !== value) onCommit(parsed);
  };

  const params = { min: String(range.min), max: String(range.max) };
  return (
    <div className="grid justify-items-end gap-1">
      <div className="flex items-center gap-1.5">
        <Input
          id={id}
          inputMode="numeric"
          autoComplete="off"
          value={draft ?? textOf(value)}
          disabled={disabled}
          placeholder={placeholder}
          aria-invalid={invalid ? true : undefined}
          aria-describedby={
            [describedBy, invalid ? errorId : undefined].filter(Boolean).join(' ') || undefined
          }
          className={cn('w-28 text-right tabular-nums', placeholder !== undefined && 'w-36')}
          onChange={(event) => {
            setDraft(event.target.value);
          }}
          onBlur={commit}
          onKeyDown={(event) => {
            if (event.key === 'Enter') {
              event.preventDefault();
              commit();
            }
          }}
        />
        {unit === undefined ? null : <span className="text-muted-foreground w-14 text-xs">{unit}</span>}
      </div>
      {invalid ? (
        <p id={errorId} role="alert" className="text-destructive max-w-64 text-right text-2xs">
          {allowEmpty
            ? t('preferences.validation.rangeOrEmpty', params)
            : t('preferences.validation.range', params)}
        </p>
      ) : null}
    </div>
  );
}
