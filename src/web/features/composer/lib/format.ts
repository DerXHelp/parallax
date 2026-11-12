import type { BoundFormat } from '@web/i18n';

/**
 * Size of a file for chips and hints in decimal units, like the limits (`LIMITS.pdfBytes` =
 * 10 000 000 = "10 MB"): byte, kB (whole), MB (one decimal).
 */
export function formatFileSize(bytes: number, format: Pick<BoundFormat, 'number'>): string {
  // "8 bytes" / "8 Byte" – the short form reads "8 byte" in English.
  if (bytes < 1000) return format.number(bytes, { style: 'unit', unit: 'byte', unitDisplay: 'long' });
  if (bytes < 1_000_000) {
    return format.number(Math.round(bytes / 1000), { style: 'unit', unit: 'kilobyte' });
  }
  return format.number(bytes / 1_000_000, { style: 'unit', unit: 'megabyte', maximumFractionDigits: 1 });
}
