/**
 * WP-70: output styles of a project. Read from `initializationResult()` (`output_style`,
 * `available_output_styles` – the answer also holds `account`, which is never read here), set with
 * the public `updateSettings('localSettings', { outputStyle })` (the CLI's own settings writer:
 * `<cwd>\.claude\settings.local.json`; it accepts only `outputStyle` for that file).
 */
import { z } from 'zod';
import type { OutputStyles } from './types';

/** Longest style name and most styles taken over (the contract's bounds). */
export const OUTPUT_STYLE_CHARS = 100;
export const OUTPUT_STYLES_MAX = 200;

const styleName = z.string().trim().min(1).max(OUTPUT_STYLE_CHARS);

const initStylesSchema = z.object({
  output_style: styleName.nullish().catch(null),
  available_output_styles: z.array(z.unknown()).nullish().catch(null),
});

/** Styles of an `initializationResult()` answer; null when neither field is usable. */
export function outputStylesOf(raw: unknown): OutputStyles | null {
  const parsed = initStylesSchema.safeParse(raw);
  if (!parsed.success) return null;
  const current = parsed.data.output_style ?? null;
  const available: string[] = [];
  for (const value of parsed.data.available_output_styles ?? []) {
    const name = styleName.safeParse(value);
    if (name.success && !available.includes(name.data)) available.push(name.data);
    if (available.length >= OUTPUT_STYLES_MAX) break;
  }
  if (current === null && available.length === 0) return null;
  return { current, available };
}
