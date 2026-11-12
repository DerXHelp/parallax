import { describe, expect, it } from 'vitest';
import { SHIKI_TOKENS } from './code-block';

describe('SHIKI_TOKENS (V4-04)', () => {
  it('keywords use their own token with a dark value, not the profile color', () => {
    // index.css: --syntax-keyword light oklch(0.52 0.18 295), dark oklch(0.72 0.15 295) – >= 4.5:1 on
    // every code background (contrast values: docs/wp/FIX-R5-F4.md). Vitest loads no CSS, so the
    // values themselves are checked there and in the review, not here.
    expect(SHIKI_TOKENS).toContain('[--shiki-token-keyword:var(--syntax-keyword)]');
    expect(SHIKI_TOKENS).not.toContain('profile-violet');
  });
});
