import { LIMITS } from '@shared/common';
import { describe, expect, it } from 'vitest';

import { formatFileSize, type NumberFormatter } from './bytes';

/** Intl puts (narrow) no-break spaces before some units; the tests compare plain spaces. */
function formatter(language: 'en' | 'de'): NumberFormatter {
  return {
    number: (value, options) => new Intl.NumberFormat(language, options).format(value).replace(/\s/gu, ' '),
  };
}

describe('lib/bytes formatFileSize (FIX-R5, R5W-09/V4-06)', () => {
  const en = formatter('en');
  const de = formatter('de');

  it.each([
    [0, '0 bytes', '0 Byte'],
    [1, '1 byte', '1 Byte'],
    [564, '564 bytes', '564 Byte'],
    [999, '999 bytes', '999 Byte'],
    [1000, '1 kB', '1 kB'],
    [1536, '2 kB', '2 kB'],
    [999_499, '999 kB', '999 kB'],
    [999_500, '1 MB', '1 MB'],
    [9_500_000, '9.5 MB', '9,5 MB'],
    [999_949_999, '999.9 MB', '999,9 MB'],
    [999_950_000, '1 GB', '1 GB'],
    [2_250_000_000, '2.3 GB', '2,3 GB'],
  ])('%d bytes → "%s" / "%s"', (bytes, english, german) => {
    expect(formatFileSize(bytes, en)).toBe(english);
    expect(formatFileSize(bytes, de)).toBe(german);
  });

  it('shows the limits as round decimal values (chip and viewer agree)', () => {
    expect(formatFileSize(LIMITS.fileAttachmentBytes, en)).toBe('10 MB');
    expect(formatFileSize(LIMITS.attachmentsTotalBytes, de)).toBe('20 MB');
  });

  it('never formats negative or fractional input as such', () => {
    expect(formatFileSize(-5, en)).toBe('0 bytes');
    expect(formatFileSize(999.6, en)).toBe('1 kB');
  });
});
