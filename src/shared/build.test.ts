import { describe, expect, it } from 'vitest';
import { BUILD_ID, DEV_BUILD_ID } from './build';

describe('build id', () => {
  it("is 'dev' when the code runs unbundled (no define)", () => {
    expect(DEV_BUILD_ID).toBe('dev');
    expect(BUILD_ID).toBe(DEV_BUILD_ID);
  });
});
