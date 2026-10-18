import { InfoIcon } from 'lucide-react';
import { useId, type ReactNode } from 'react';
import { cn } from '@web/lib/cn';
import { Label } from '@web/ui/label';

export interface FieldControlProps {
  /** `id` of the control (the label points to it). */
  id: string;
  /** `id` of the label (for controls that are no labelable element, e.g. a radio group). */
  labelId: string;
  /** Description and disabled reason, for `aria-describedby`. */
  describedBy: string | undefined;
}

/**
 * One setting of the page: label, description and – when the control is disabled for a reason –
 * that reason on the left, the control on the right; `below` for a wide control under it (a radio
 * group, the event table). The control is wired to the texts via the render prop. The label
 * points at `id` (`<label for>`) only when `control` is a labelable element that takes it
 * (`labelFor`); groups below use `labelId` (V3-12: no dangling `for`).
 */
export function SettingField({
  label,
  description,
  disabled = false,
  disabledReason = null,
  name,
  control,
  below,
  labelFor = control !== undefined,
}: {
  label: string;
  description?: string;
  /** Dims the label (the control itself carries `disabled`). */
  disabled?: boolean;
  /** Shown (and announced) while the control cannot be used, e.g. without system integration. */
  disabledReason?: string | null;
  /** `data-setting` for tests and screenshots. */
  name: string;
  control?: (ids: FieldControlProps) => ReactNode;
  below?: (ids: FieldControlProps) => ReactNode;
  /**
   * The control renders a labelable element (input, button) with `id`. Default: with `control`.
   * False e.g. for a slider (its thumb is named by `aria-label`).
   */
  labelFor?: boolean;
}) {
  const id = useId();
  const labelId = useId();
  const descriptionId = useId();
  const reasonId = useId();
  const describedBy =
    [description === undefined ? null : descriptionId, disabledReason === null ? null : reasonId]
      .filter((value) => value !== null)
      .join(' ') || undefined;
  const ids: FieldControlProps = { id, labelId, describedBy };
  return (
    <div data-setting={name} className="grid gap-2.5 py-3.5 first:pt-0 last:pb-0">
      <div className="flex items-start justify-between gap-6">
        <div className="grid min-w-0 gap-1">
          <Label
            id={labelId}
            htmlFor={labelFor ? id : undefined}
            className={cn('leading-snug', disabled && 'opacity-60')}
          >
            {label}
          </Label>
          {description === undefined ? null : (
            <p id={descriptionId} className="text-muted-foreground text-2xs leading-relaxed">
              {description}
            </p>
          )}
          {disabledReason === null ? null : (
            <p
              id={reasonId}
              className="text-muted-foreground flex items-start gap-1.5 text-2xs leading-relaxed"
            >
              <InfoIcon aria-hidden className="text-info mt-0.5 size-3 shrink-0" />
              <span>{disabledReason}</span>
            </p>
          )}
        </div>
        {control === undefined ? null : (
          <div className="flex shrink-0 items-center gap-2 pt-0.5">{control(ids)}</div>
        )}
      </div>
      {below?.(ids)}
    </div>
  );
}

/** Settings of one section, separated by lines. */
export function SettingList({ children }: { children: ReactNode }) {
  return <div className="divide-border grid divide-y">{children}</div>;
}
