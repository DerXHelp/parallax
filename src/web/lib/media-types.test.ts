import { describe, expect, it } from 'vitest';
import { ATTACHMENT_MEDIA_TYPES } from '@shared/http';
import { extensionForMediaType, fileNameForMediaType } from './media-types';

describe('extensionForMediaType (R4W-21)', () => {
  it.each([
    ['image/png', 'png'],
    ['image/jpeg', 'jpg'],
    ['image/webp', 'webp'],
    ['image/gif', 'gif'],
    ['image/svg+xml', 'svg'],
    ['application/pdf', 'pdf'],
    ['IMAGE/PNG; foo=1', 'png'],
    ['text/plain', null],
    ['toString', null],
    ['', null],
  ] as const)('%j → %j', (type, extension) => {
    expect(extensionForMediaType(type)).toBe(extension);
  });

  it('knows every attachment type', () => {
    for (const type of ATTACHMENT_MEDIA_TYPES) expect(extensionForMediaType(type), type).not.toBeNull();
  });
});

describe('fileNameForMediaType', () => {
  it.each([
    ['image.png', 'image/jpeg', 'image.jpg'],
    ['Screenshot 2026-10-16.png', 'image/png', 'Screenshot 2026-10-16.png'],
    ['', 'image/png', 'image.png'],
    ['  ', 'image/gif', 'image.gif'],
    ['archive.tar.gz', 'image/webp', 'archive.tar.webp'],
    ['.hidden', 'image/gif', '.hidden.gif'],
    ['notes.md', 'text/markdown', 'notes.md'],
  ] as const)('%j as %s → %j', (name, type, expected) => {
    expect(fileNameForMediaType(name, type)).toBe(expected);
  });

  it('uses the fallback for an empty name', () => {
    expect(fileNameForMediaType('', 'image/png', 'shot')).toBe('shot.png');
  });
});
