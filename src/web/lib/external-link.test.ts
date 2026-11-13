import { afterEach, describe, expect, it, vi } from 'vitest';
import { configureExternalLinks, onExternalLinkClick, openExternalLink } from './external-link';
import { openClaudeSessionUrl } from './windows';

const URL = 'https://example.com/docs';

let remove: (() => void) | null = null;

afterEach(() => {
  remove?.();
  remove = null;
  vi.restoreAllMocks();
});

function clickEvent(p: Partial<{ button: number; ctrlKey: boolean; shiftKey: boolean; defaultPrevented: boolean }> = {}) {
  const preventDefault = vi.fn();
  const event = {
    button: 0,
    ctrlKey: false,
    metaKey: false,
    shiftKey: false,
    altKey: false,
    defaultPrevented: false,
    ...p,
    preventDefault,
  };
  return { event, preventDefault };
}

describe('external links (WP-65 §1.6b)', () => {
  it('go to the installed opener; nothing opens here', async () => {
    const opened = vi.spyOn(window, 'open').mockReturnValue(null);
    const open = vi.fn(() => Promise.resolve());
    const fellBack = vi.fn();
    remove = configureExternalLinks({ open, fellBack });
    expect(openExternalLink(URL)).toBe(true);
    await Promise.resolve();
    expect(open).toHaveBeenCalledWith(URL);
    expect(opened).not.toHaveBeenCalled();
    expect(fellBack).not.toHaveBeenCalled();
  });

  it('a refusal opens the link here (no opener, no referrer) and asks for the hint', async () => {
    const opened = vi.spyOn(window, 'open').mockReturnValue(null);
    const fellBack = vi.fn();
    remove = configureExternalLinks({ open: () => Promise.reject(new Error('OPEN_FAILED')), fellBack });
    openExternalLink(URL);
    await vi.waitFor(() => {
      expect(fellBack).toHaveBeenCalledTimes(1);
    });
    expect(opened).toHaveBeenCalledWith(URL, '_blank', 'noopener,noreferrer');
  });

  it('without an opener the link opens here; non-http(s) links never open', () => {
    const opened = vi.spyOn(window, 'open').mockReturnValue(null);
    expect(openExternalLink(URL)).toBe(true);
    expect(opened).toHaveBeenCalledTimes(1);
    expect(openExternalLink('javascript:alert(1)')).toBe(false);
    expect(openExternalLink('file:///C:/x.txt')).toBe(false);
    expect(opened).toHaveBeenCalledTimes(1);
  });

  it('a plain click is taken over; modifiers, other buttons and handled events keep the default', () => {
    const open = vi.fn(() => Promise.resolve());
    remove = configureExternalLinks({ open, fellBack: () => undefined });
    const plain = clickEvent();
    onExternalLinkClick(plain.event, URL);
    expect(plain.preventDefault).toHaveBeenCalled();
    for (const p of [{ ctrlKey: true }, { shiftKey: true }, { button: 1 }, { defaultPrevented: true }]) {
      const other = clickEvent(p);
      onExternalLinkClick(other.event, URL);
      expect(other.preventDefault).not.toHaveBeenCalled();
    }
    expect(open).toHaveBeenCalledTimes(1);
  });

  it('"Open in the Claude app" uses the same way, only for claude.ai links', () => {
    const open = vi.fn(() => Promise.resolve());
    remove = configureExternalLinks({ open, fellBack: () => undefined });
    expect(openClaudeSessionUrl('https://claude.ai/code/session_01QKkfSZajXxCTUVAWr5SbHm')).toBe(true);
    expect(openClaudeSessionUrl(URL)).toBe(false);
    expect(open).toHaveBeenCalledTimes(1);
  });
});
