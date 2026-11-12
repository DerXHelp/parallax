/** The part of `useI18n().format` the size formatter needs (structural: lib does not import i18n). */
export interface NumberFormatter {
  number(value: number, options?: Intl.NumberFormatOptions): string;
}

/**
 * Size of a file for display in decimal units, like the limits (`LIMITS.fileAttachmentBytes` =
 * 10 000 000 = "10 MB"), formatted for the UI language (FIX-R5, R5W-09/V4-06: one convention for
 * composer chips, viewer and files panel):
 * - below 1000: whole bytes, long unit ("8 bytes" / "8 Byte" – the short form reads "8 byte");
 * - kB whole, MB and GB with one decimal ("9.5 MB" / "9,5 MB").
 */
export function formatFileSize(bytes: number, format: NumberFormatter): string {
  const value = Math.max(0, Math.round(bytes));
  if (value < 1000) return format.number(value, { style: 'unit', unit: 'byte', unitDisplay: 'long' });
  if (value < 999_500) return format.number(Math.round(value / 1000), { style: 'unit', unit: 'kilobyte' });
  if (value < 999_950_000) {
    return format.number(value / 1_000_000, { style: 'unit', unit: 'megabyte', maximumFractionDigits: 1 });
  }
  return format.number(value / 1_000_000_000, { style: 'unit', unit: 'gigabyte', maximumFractionDigits: 1 });
}
