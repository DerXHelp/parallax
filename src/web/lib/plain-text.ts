/**
 * Plain text from Markdown snippets (plan titles, summaries, WP-93 feedback names) – for showing a
 * name, never for rendering. Emphasis only counts as emphasis where Markdown would read it so: an
 * underscore inside a word (`config_file`) or a lone `*` stays.
 */

/** Inline Markdown reduced to its text: links and images to their text, code ticks, emphasis. */
export function plainInline(text: string): string {
  return text
    .replace(/!?\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/(`+)([^`]+?)\1/g, '$2')
    .replace(/(?<![\w*])(\*\*|\*)(?=\S)(.+?)(?<=\S)\1(?![\w*])/g, '$2')
    .replace(/(?<!\w)(__|_)(?=\S)(.+?)(?<=\S)\1(?!\w)/g, '$2')
    .replace(/~~(?=\S)(.+?)(?<=\S)~~/g, '$1')
    .replace(/\s+/g, ' ')
    .trim();
}

/** `text` cut to `max` characters, ending in "…" when cut. */
export function clipText(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, max - 1).trimEnd()}…`;
}
