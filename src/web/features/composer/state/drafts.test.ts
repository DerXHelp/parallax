import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  clearDraft,
  draftStorageKey,
  getDraft,
  getDraftInput,
  getPastes,
  pastesStorageKey,
  resetDraftStore,
  setDraft,
} from './drafts';

const KEY = 'local:en_drafts_test';
const TOKEN = '[#1 · 30 lines]';
const TEXT = Array.from({ length: 30 }, (_, i) => `line ${String(i + 1)}`).join('\n');

afterEach(() => {
  vi.restoreAllMocks();
  resetDraftStore();
  localStorage.clear();
});

describe('drafts: storage is a convenience (R5W-11)', () => {
  it('stored text and pastes come back after a reload', () => {
    localStorage.setItem(draftStorageKey(KEY), `see ${TOKEN}`);
    localStorage.setItem(pastesStorageKey(KEY), JSON.stringify([{ id: 1, token: TOKEN, text: TEXT }]));
    expect(getDraftInput(KEY)).toBe(`see ${TOKEN}`);
    expect(getPastes(KEY)).toEqual([{ id: 1, token: TOKEN, text: TEXT }]);
    expect(getDraft(KEY)).toBe(`see ${TEXT}`);
  });

  it('broken JSON in the pastes reads as none: the text stays, the token is plain text', () => {
    localStorage.setItem(draftStorageKey(KEY), `see ${TOKEN}`);
    localStorage.setItem(pastesStorageKey(KEY), '[{"id":1,"token":');
    expect(getDraftInput(KEY)).toBe(`see ${TOKEN}`);
    expect(getPastes(KEY)).toEqual([]);
    expect(getDraft(KEY)).toBe(`see ${TOKEN}`);
  });

  it('pastes of the wrong shape or without their token in the text read as none', () => {
    localStorage.setItem(draftStorageKey(KEY), `see ${TOKEN}`);
    localStorage.setItem(pastesStorageKey(KEY), JSON.stringify([{ id: 'one', token: TOKEN, text: TEXT }]));
    expect(getPastes(KEY)).toEqual([]);
    resetDraftStore();
    localStorage.setItem(
      pastesStorageKey(KEY),
      JSON.stringify([{ id: 2, token: '[#2 · 31 lines]', text: `${TEXT}\nmore` }]),
    );
    expect(getPastes(KEY)).toEqual([]);
  });

  it('a storage that throws on access: empty draft, edits live in memory, nothing throws', () => {
    vi.spyOn(window, 'localStorage', 'get').mockImplementation(() => {
      throw new Error('denied');
    });
    expect(getDraftInput(KEY)).toBe('');
    expect(() => {
      setDraft(KEY, `see ${TOKEN}`, [{ id: 1, token: TOKEN, text: TEXT }]);
    }).not.toThrow();
    expect(getDraft(KEY)).toBe(`see ${TEXT}`);
    expect(() => {
      clearDraft(KEY);
    }).not.toThrow();
    expect(getDraftInput(KEY)).toBe('');
    expect(getPastes(KEY)).toEqual([]);
  });

  it('a full storage (setItem throws): the draft still changes in memory', () => {
    vi.spyOn(localStorage, 'setItem').mockImplementation(() => {
      throw new DOMException('quota', 'QuotaExceededError');
    });
    setDraft(KEY, `see ${TOKEN}`, [{ id: 1, token: TOKEN, text: TEXT }]);
    expect(getDraftInput(KEY)).toBe(`see ${TOKEN}`);
    expect(getDraft(KEY)).toBe(`see ${TEXT}`);
    vi.restoreAllMocks();
    expect(localStorage.getItem(draftStorageKey(KEY))).toBeNull();
    expect(localStorage.getItem(pastesStorageKey(KEY))).toBeNull();
  });
});
