import { describe, expect, it } from 'vitest';
import { OUTPUT_STYLES_MAX, outputStylesOf } from './outputStyle';

describe('outputStylesOf (WP-70)', () => {
  it('reads output_style and the list (trimmed, unique, strings only); never the account', () => {
    const styles = outputStylesOf({
      output_style: 'default',
      available_output_styles: ['default', ' Proactive ', 'Proactive', '', 3, 'Learning'],
      account: { email: 'someone@example.invalid' },
    });
    expect(styles).toEqual({ current: 'default', available: ['default', 'Proactive', 'Learning'] });
    expect(JSON.stringify(styles)).not.toContain('example.invalid');
  });

  it('a missing field is tolerated; neither field → null; the list is bounded', () => {
    expect(outputStylesOf({ output_style: 'Concise' })).toEqual({ current: 'Concise', available: [] });
    expect(outputStylesOf({ available_output_styles: ['a'] })).toEqual({ current: null, available: ['a'] });
    expect(outputStylesOf({ commands: [] })).toBeNull();
    expect(outputStylesOf('nope')).toBeNull();
    const many = Array.from({ length: OUTPUT_STYLES_MAX + 20 }, (_, i) => `s${String(i)}`);
    expect(outputStylesOf({ available_output_styles: many })?.available).toHaveLength(OUTPUT_STYLES_MAX);
  });
});
