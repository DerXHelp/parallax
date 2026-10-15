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

/** `urlTransform` for react-markdown: unsafe URLs become empty (the link renderers show text only). */
export function markdownUrlTransform(url: string): string {
  return safeHttpUrl(url) ?? '';
}
