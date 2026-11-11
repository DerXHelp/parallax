import type { BoundFormat } from '@web/i18n';

const UNITS = ['byte', 'kilobyte', 'megabyte', 'gigabyte'] as const;
export type ByteUnit = (typeof UNITS)[number];

/** `bytes` scaled to the largest unit below 1024 of it (binary steps, short unit names). */
export function scaleBytes(bytes: number): { value: number; unit: ByteUnit } {
  let value = Math.max(0, bytes);
  let index = 0;
  while (value >= 1024 && index < UNITS.length - 1) {
    value /= 1024;
    index++;
  }
  return { value, unit: UNITS[index] ?? 'byte' };
}

/** File size for display ("1.2 kB" / "1,2 kB"), formatted for the UI language (`useI18n().format`). */
export function formatBytes(bytes: number, format: Pick<BoundFormat, 'number'>): string {
  const { value, unit } = scaleBytes(bytes);
  return format.number(value, {
    style: 'unit',
    unit,
    unitDisplay: 'short',
    maximumFractionDigits: unit === 'byte' || value >= 100 ? 0 : 1,
  });
}
