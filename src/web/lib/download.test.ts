import { afterEach, describe, expect, it, vi } from 'vitest';
import { downloadText } from './download';

afterEach(() => {
  vi.restoreAllMocks();
  vi.useRealTimers();
});

describe('downloadText', () => {
  it('clicks a temporary download link with the file name and revokes the Blob URL', async () => {
    vi.useFakeTimers();
    const create = vi.spyOn(URL, 'createObjectURL').mockReturnValue('blob:fake-1');
    const revoke = vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => undefined);
    const clicked: { href: string; download: string; attached: boolean }[] = [];
    vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(function (this: HTMLAnchorElement) {
      clicked.push({ href: this.href, download: this.download, attached: this.isConnected });
    });

    expect(downloadText('hello\nworld', '2026-11-13-101500-fix.txt')).toBe(true);

    expect(clicked).toEqual([{ href: 'blob:fake-1', download: '2026-11-13-101500-fix.txt', attached: true }]);
    const blob = create.mock.calls[0]?.[0];
    expect(blob).toBeInstanceOf(Blob);
    if (blob instanceof Blob) {
      expect(blob.type).toBe('text/plain;charset=utf-8');
      expect(await blob.text()).toBe('hello\nworld');
    }
    expect(document.querySelector('a[download]')).toBeNull();
    expect(revoke).not.toHaveBeenCalled();
    vi.runAllTimers();
    expect(revoke).toHaveBeenCalledWith('blob:fake-1');
  });

  it('returns false when the browser refuses the Blob URL', () => {
    vi.spyOn(URL, 'createObjectURL').mockImplementation(() => {
      throw new Error('blocked');
    });
    expect(downloadText('x', 'x.txt')).toBe(false);
  });
});
