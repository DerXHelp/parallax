/**
 * Makes invisible characters visible (WP-67): control characters, format characters (zero-width
 * spaces, bidi overrides) and line/paragraph separators become `\u{…}`, so a permission rule or a
 * path reads as what the CLI actually holds. Line breaks and tabs stay when `keepLayout` is set
 * (multi-line hook commands).
 */
const INVISIBLE = /[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/gu;

export function revealInvisible(text: string, { keepLayout = false }: { keepLayout?: boolean } = {}): string {
  return text.replace(INVISIBLE, (char) => {
    if (keepLayout && (char === '\n' || char === '\t' || char === '\r')) return char;
    const code = char.codePointAt(0) ?? 0;
    return `\\u{${code.toString(16).toUpperCase().padStart(4, '0')}}`;
  });
}
