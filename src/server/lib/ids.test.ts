import { describe, expect, it } from 'vitest';
import { conversationIdSchema, decisionIdSchema, entryIdSchema, profileIdSchema } from '@shared/common';
import { authCodeSchema, launcherTokenSchema } from '@shared/http';
import { newId, newToken, newUuid } from './ids';

describe('ids', () => {
  it('creates ids that match the contract schemas', () => {
    expect(entryIdSchema.parse(newId('en'))).toMatch(/^en_[0-9a-f]{32}$/);
    expect(conversationIdSchema.safeParse(newId('cv')).success).toBe(true);
    expect(decisionIdSchema.safeParse(newId('dc')).success).toBe(true);
    expect(profileIdSchema.safeParse(newId('pf')).success).toBe(true);
  });

  it('creates unique values', () => {
    const ids = new Set(Array.from({ length: 1000 }, () => newId('en')));
    expect(ids.size).toBe(1000);
    expect(newUuid()).not.toBe(newUuid());
  });

  it('creates 43-char base64url tokens', () => {
    const token = newToken();
    expect(token).toHaveLength(43);
    expect(authCodeSchema.safeParse(token).success).toBe(true);
    expect(launcherTokenSchema.safeParse(token).success).toBe(true);
  });
});
