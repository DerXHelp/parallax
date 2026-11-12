import { act, renderHook } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { STORAGE_KEYS } from '@web/lib/storage';
import {
  getTranscriptView,
  resetTranscriptView,
  setTranscriptView,
  useTranscriptView,
} from './transcript-view';

afterEach(() => {
  act(() => {
    resetTranscriptView();
  });
});

describe('transcript view setting (WP-63 §1.5)', () => {
  it('defaults to compact; a choice is kept in localStorage (the default as no entry)', () => {
    expect(getTranscriptView()).toBe('compact');
    const { result } = renderHook(() => useTranscriptView());
    act(() => {
      setTranscriptView('all');
    });
    expect(result.current).toBe('all');
    expect(window.localStorage.getItem(STORAGE_KEYS.transcriptView)).toBe('all');
    act(() => {
      setTranscriptView('compact');
    });
    expect(result.current).toBe('compact');
    expect(window.localStorage.getItem(STORAGE_KEYS.transcriptView)).toBeNull();
  });

  it('follows other windows (storage event); unknown values mean compact', () => {
    const { result } = renderHook(() => useTranscriptView());
    act(() => {
      window.dispatchEvent(
        new StorageEvent('storage', { key: STORAGE_KEYS.transcriptView, newValue: 'all' }),
      );
    });
    expect(result.current).toBe('all');
    act(() => {
      window.dispatchEvent(
        new StorageEvent('storage', { key: STORAGE_KEYS.transcriptView, newValue: 'bogus' }),
      );
    });
    expect(result.current).toBe('compact');
  });
});
