import { describe, expect, it } from 'vitest';
import { PRODUCT_ID, PRODUCT_NAME } from './product';

describe('product constants', () => {
  it('derives the id from the name', () => {
    expect(PRODUCT_ID).toBe(PRODUCT_NAME.toLowerCase());
  });
});
