/**
 * Saves text as a file through the browser's download (WP-67 export): a Blob URL on a temporary
 * `<a download>`, clicked once and revoked right after. Only from a user action. Returns false when
 * the browser refused (no DOM, Blob URLs blocked) instead of throwing.
 */
export function downloadText(text: string, filename: string, type = 'text/plain;charset=utf-8'): boolean {
  if (typeof document === 'undefined' || typeof URL.createObjectURL !== 'function') return false;
  let url: string | null = null;
  try {
    url = URL.createObjectURL(new Blob([text], { type }));
    const anchor = document.createElement('a');
    anchor.href = url;
    anchor.download = filename;
    anchor.rel = 'noopener';
    anchor.style.display = 'none';
    document.body.append(anchor);
    anchor.click();
    anchor.remove();
    return true;
  } catch {
    return false;
  } finally {
    // The click starts the download synchronously; the URL is no longer needed afterwards.
    if (url !== null) {
      const revoke = url;
      setTimeout(() => {
        URL.revokeObjectURL(revoke);
      }, 0);
    }
  }
}
