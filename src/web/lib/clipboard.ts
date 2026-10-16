/**
 * Copies text to the clipboard; resolves false instead of throwing when the API is missing (no
 * secure context – 127.0.0.1 is one) or the write is refused. Only from a user action.
 */
export async function copyText(text: string): Promise<boolean> {
  const clipboard = typeof navigator === 'undefined' ? undefined : navigator.clipboard;
  if (clipboard === undefined) return false;
  try {
    await clipboard.writeText(text);
    return true;
  } catch {
    return false;
  }
}
