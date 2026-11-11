import { useRef, useState, type ComponentProps, type KeyboardEvent, type PointerEvent } from 'react';
import { cn } from '@web/lib/cn';

/** Default keyboard step (px) of the arrow keys (WP-54: ± 16 px). */
export const SPLITTER_STEP = 16;

export interface SplitterProps extends Omit<
  ComponentProps<'div'>,
  'onChange' | 'children' | 'role' | 'aria-label'
> {
  /** Size of the controlled pane (px); `aria-valuenow`. */
  value: number;
  min: number;
  max: number;
  /** Every change while dragging or by a key (the caller re-renders with the new `value`). */
  onChange: (value: number) => void;
  /** After a drag ended or a key changed the value – persist here. */
  onCommit?: (value: number) => void;
  /** Dragging started/ended (e.g. disable pointer events of an iframe below). */
  onDraggingChange?: (dragging: boolean) => void;
  /** 'vertical' (default) = an upright bar that resizes horizontally; 'horizontal' = a lying bar. */
  orientation?: 'vertical' | 'horizontal';
  /**
   * true: moving the bar left (up) makes `value` larger – the controlled pane lies right of (below)
   * the bar, e.g. a side panel on the right.
   */
  invert?: boolean;
  /** Arrow key step in px (default 16). */
  step?: number;
  /** Accessible name (from `t()`). */
  label: string;
  /** `aria-valuetext` (from `t()`), e.g. "480 px". */
  valueText?: string;
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), Math.max(min, max));
}

/**
 * Resize handle between two panes (WAI-ARIA window splitter): a focusable `role="separator"` with
 * `aria-orientation`, `aria-valuenow/min/max`; arrow keys move it by `step`, Home/End jump to the
 * minimum/maximum, the pointer drags it (pointer capture, so an iframe below does not swallow the
 * moves). Purely controlled: the caller owns `value` and persists it in `onCommit`.
 */
export function Splitter({
  value,
  min,
  max,
  onChange,
  onCommit,
  onDraggingChange,
  orientation = 'vertical',
  invert = false,
  step = SPLITTER_STEP,
  label,
  valueText,
  className,
  ...props
}: SplitterProps) {
  const drag = useRef<{ pointerId: number; start: number; value: number; last: number } | null>(null);
  const [dragging, setDragging] = useState(false);
  const vertical = orientation === 'vertical';
  const sign = invert ? -1 : 1;

  const setValue = (next: number, commit: boolean) => {
    const clamped = clamp(Math.round(next), min, max);
    if (clamped !== value) onChange(clamped);
    if (commit) onCommit?.(clamped);
    return clamped;
  };

  const endDrag = (element: HTMLElement, pointerId: number, commit: boolean) => {
    const current = drag.current;
    if (current?.pointerId !== pointerId) return;
    drag.current = null;
    setDragging(false);
    onDraggingChange?.(false);
    try {
      if (element.hasPointerCapture(pointerId)) element.releasePointerCapture(pointerId);
    } catch {
      // Not supported (tests) – nothing to release.
    }
    if (commit) onCommit?.(current.last);
  };

  const onPointerDown = (event: PointerEvent<HTMLDivElement>) => {
    if (event.button !== 0) return;
    event.preventDefault();
    const element = event.currentTarget;
    element.focus();
    try {
      element.setPointerCapture(event.pointerId);
    } catch {
      // happy-dom and old engines: dragging still works while the pointer stays on the bar.
    }
    drag.current = {
      pointerId: event.pointerId,
      start: vertical ? event.clientX : event.clientY,
      value,
      last: value,
    };
    setDragging(true);
    onDraggingChange?.(true);
  };

  const onPointerMove = (event: PointerEvent<HTMLDivElement>) => {
    const current = drag.current;
    if (current?.pointerId !== event.pointerId) return;
    const position = vertical ? event.clientX : event.clientY;
    current.last = setValue(current.value + sign * (position - current.start), false);
  };

  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    const smaller = vertical ? 'ArrowLeft' : 'ArrowUp';
    const larger = vertical ? 'ArrowRight' : 'ArrowDown';
    let next: number;
    switch (event.key) {
      case smaller:
        next = value + sign * -step;
        break;
      case larger:
        next = value + sign * step;
        break;
      case 'Home':
        next = min;
        break;
      case 'End':
        next = max;
        break;
      default:
        return;
    }
    event.preventDefault();
    setValue(next, true);
  };

  return (
    <div
      role="separator"
      tabIndex={0}
      aria-label={label}
      aria-orientation={orientation}
      aria-valuenow={Math.round(value)}
      aria-valuemin={Math.round(min)}
      aria-valuemax={Math.round(Math.max(min, max))}
      aria-valuetext={valueText}
      data-slot="splitter"
      data-dragging={dragging ? 'true' : undefined}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={(event) => {
        endDrag(event.currentTarget, event.pointerId, true);
      }}
      onPointerCancel={(event) => {
        endDrag(event.currentTarget, event.pointerId, true);
      }}
      onLostPointerCapture={(event) => {
        endDrag(event.currentTarget, event.pointerId, true);
      }}
      onKeyDown={onKeyDown}
      className={cn(
        'group/splitter hover:bg-ring/40 focus-visible:bg-ring data-[dragging=true]:bg-ring touch-none bg-transparent transition-colors outline-none select-none',
        vertical ? 'w-1.5 cursor-col-resize' : 'h-1.5 cursor-row-resize',
        className,
      )}
      {...props}
    />
  );
}
