import { Slider as SliderPrimitive } from 'radix-ui';
import type { ComponentProps } from 'react';
import { cn } from '@web/lib/cn';

export interface SliderProps extends ComponentProps<typeof SliderPrimitive.Root> {
  /**
   * Accessible name of the thumb – always from `t()`. Radix gives `role="slider"` to the thumb, not
   * to the root, so the root's `aria-label` would not name it.
   */
  thumbLabel: string;
  /** Spoken value of a thumb (e.g. "60 %"); default: the number. */
  valueText?: (value: number) => string;
}

/**
 * Range input (e.g. the notification volume, WP-38) on Radix `Slider`: one thumb per value.
 * Keyboard: arrows step, Page↑/↓ step ×10, Home/End. `onValueChange` follows every move while
 * dragging, `onValueCommit` fires once at the end of a drag (pointer up) but on **every** key
 * press – a caller that saves or plays something there groups held/repeated keys itself (e.g. the
 * volume of WP-38 saves 300 ms after the last key, R4W-17; `onKeyDown`/`onPointerDown` tell the
 * input apart).
 */
export function Slider({
  className,
  thumbLabel,
  valueText,
  value,
  defaultValue,
  min = 0,
  max = 100,
  ...props
}: SliderProps) {
  const values = value ?? defaultValue ?? [min];
  return (
    <SliderPrimitive.Root
      data-slot="slider"
      value={value}
      defaultValue={defaultValue}
      min={min}
      max={max}
      className={cn(
        'relative flex w-full touch-none items-center select-none data-[disabled]:opacity-50 data-[orientation=vertical]:h-full data-[orientation=vertical]:min-h-32 data-[orientation=vertical]:w-auto data-[orientation=vertical]:flex-col',
        className,
      )}
      {...props}
    >
      <SliderPrimitive.Track
        data-slot="slider-track"
        className="bg-muted relative h-1.5 w-full grow overflow-hidden rounded-full data-[orientation=vertical]:h-full data-[orientation=vertical]:w-1.5"
      >
        <SliderPrimitive.Range
          data-slot="slider-range"
          className="bg-brand absolute h-full data-[orientation=vertical]:w-full"
        />
      </SliderPrimitive.Track>
      {values.map((thumbValue, index) => (
        <SliderPrimitive.Thumb
          // The thumbs are positional (Radix keeps their order): the index is their identity.
          key={index}
          data-slot="slider-thumb"
          aria-label={thumbLabel}
          aria-valuetext={valueText?.(thumbValue)}
          className="border-brand bg-background hover:ring-ring/40 focus-visible:ring-ring block size-3.5 shrink-0 rounded-full border shadow-sm transition-[box-shadow] outline-none hover:ring-2 focus-visible:ring-2 data-[disabled]:pointer-events-none"
        />
      ))}
    </SliderPrimitive.Root>
  );
}
