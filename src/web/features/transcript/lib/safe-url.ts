import { POSIX_PATHS, WIN32_PATHS } from '@shared/paths';
import { parseFileTarget } from '@web/lib/file-refs';

/**
 * Link policy of the transcript (CLAUDE.md, Review C.10 "Links nur http(s)"): only absolute
 * `http:`/`https:` URLs become clickable. Everything else (`javascript:`, `data:`, `vbscript:`,
 * `file:`, `mailto:`, relative paths, protocol-relative `//host`) stays plain text.
 */
export function safeHttpUrl(url: string | null | undefined): string | null {
  if (typeof url !== 'string') return null;
  const trimmed = url.trim();
  if (!/^https?:\/\/[^/\\]/i.test(trimmed)) return null;
  try {
    const parsed = new URL(trimmed);
    return parsed.protocol === 'http:' || parsed.protocol === 'https:' ? parsed.href : null;
  } catch {
    return null;
  }
}

/**
 * `urlTransform` for react-markdown: unsafe URLs become empty (the link renderers show text only).
 * WP-55: a link target (`href`) that is a local file (drive, relative, `file:///C:/…` –
 * `parseFileTarget`, never UNC/device) is kept for the link renderer, which shows it as a `FileLink`
 * – never as an `<a href>`. Image sources stay http(s)-only. WP-104: a local target of either kind of
 * host is kept (`/home/…` on Linux); the link renderer parses it again with the rules of the session's
 * host and shows anything else as a blocked link.
 */
export function markdownUrlTransform(url: string, key = 'href'): string {
  const safe = safeHttpUrl(url);
  if (safe !== null) return safe;
  if (key !== 'href') return '';
  const local = [WIN32_PATHS, POSIX_PATHS].some((rules) => {
    const target = parseFileTarget(url, rules);
    return target !== null && !target.unsafe;
  });
  return local ? url : '';
}
