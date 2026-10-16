import { describe, expect, it } from 'vitest';
import { isCliDiagnostic, resultErrors } from './builders';

describe('result errors (WP22-08)', () => {
  it('leaves the internal CLI diagnostics out, keeps real errors (capped)', () => {
    const diagnostic = '[ede_diagnostic] result_type=user last_content_type=n/a stop_reason=tool_use';
    expect(isCliDiagnostic(diagnostic)).toBe(true);
    expect(isCliDiagnostic('  [some_diagnostic] x')).toBe(true);
    expect(isCliDiagnostic('API Error: 529 overloaded')).toBe(false);
    expect(isCliDiagnostic('see [ede_diagnostic] later')).toBe(false);
    expect(resultErrors([diagnostic, 'API Error: 529 overloaded', 42, 'x'.repeat(5000)])).toEqual([
      'API Error: 529 overloaded',
      'x'.repeat(4000),
    ]);
    expect(resultErrors(undefined)).toEqual([]);
  });
});
