import { describe, expect, it, vi } from 'vitest';
import type { Language } from '@shared/common';
import { sampleId } from '@shared/samples';
import type { ToastRequest, ToastResult } from '../lib/toast';
import { DISABLED_NATIVE_TOASTS, TOAST_TEXTS, createNativeToasts, toastText } from './nativeToasts';

const ENTRY = sampleId('en', 1);

function setup(results: ToastResult[] = [], language: Language = 'en') {
  const shown: ToastRequest[] = [];
  const removed: string[] = [];
  const log = { info: vi.fn(), warn: vi.fn(), debug: vi.fn() };
  const onUnavailable = vi.fn();
  let n = 0;
  const next = (): Promise<ToastResult> => Promise.resolve(results[n++] ?? { kind: 'shown' });
  const toasts = createNativeToasts({
    enabled: true,
    language: () => language,
    log,
    onUnavailable,
    show: (request) => {
      shown.push(request);
      return next();
    },
    remove: (tag) => {
      removed.push(tag);
      return next();
    },
  });
  return { toasts, shown, removed, log, onUnavailable };
}

describe('native toasts (WP22-03/-15, A.9)', () => {
  it('texts per language mirror the web kinds; the body names no click (Phase 1)', () => {
    expect(toastText('en', 'plan', 'Auth')).toBe('Auth – plan ready for review');
    expect(toastText('de', 'permission', 'Auth')).toBe('Auth – braucht eine Freigabe');
    for (const language of ['en', 'de'] as const) {
      expect(TOAST_TEXTS[language].body).not.toMatch(/click|klick/i);
    }
  });

  it('shows with the entry id as tag, one after the other; clear removes only shown toasts', async () => {
    const { toasts, shown, removed } = setup([], 'de');
    toasts.clear(ENTRY);
    toasts.show(ENTRY, 'done', 'Mein Projekt');
    toasts.show(ENTRY, 'question', 'Mein Projekt');
    toasts.clear(ENTRY);
    toasts.clear(ENTRY);
    await toasts.idle();
    expect(shown).toEqual([
      { title: 'Mein Projekt – fertig', body: TOAST_TEXTS.de.body, tag: ENTRY },
      { title: 'Mein Projekt – hat eine Frage', body: TOAST_TEXTS.de.body, tag: ENTRY },
    ]);
    expect(removed).toEqual([ENTRY]);
    expect(toasts.available()).toBe(true);
  });

  it('the first failure (CLM, WinRT missing) switches the channel off and reports it once', async () => {
    const { toasts, shown, log, onUnavailable } = setup([
      { kind: 'failed', reason: 'exit 3: error: blocked' },
    ]);
    toasts.show(ENTRY, 'done', 'A');
    toasts.show(ENTRY, 'done', 'B');
    await toasts.idle();
    expect(shown).toHaveLength(1);
    expect(toasts.available()).toBe(false);
    expect(onUnavailable).toHaveBeenCalledTimes(1);
    expect(log.warn).toHaveBeenCalledWith(
      expect.objectContaining({ reason: 'exit 3: error: blocked' }),
      expect.stringContaining('stay in-app'),
    );
    toasts.show(ENTRY, 'done', 'C');
    await toasts.idle();
    expect(shown).toHaveLength(1);
  });

  it('a burst beyond the queue is dropped instead of starting PowerShells without end', async () => {
    const gate = Promise.withResolvers<ToastResult>();
    const shown: string[] = [];
    const toasts = createNativeToasts({
      enabled: true,
      language: () => 'en',
      log: { info: vi.fn(), warn: vi.fn(), debug: vi.fn() },
      maxQueue: 2,
      show: (request) => {
        shown.push(request.title);
        return gate.promise;
      },
    });
    for (let i = 0; i < 5; i += 1) toasts.show(sampleId('en', i + 1), 'done', `T${String(i)}`);
    gate.resolve({ kind: 'shown' });
    await toasts.idle();
    expect(shown).toEqual(['T0 – done', 'T1 – done']);
  });

  it('disabled: never available, does nothing', async () => {
    const log = { info: vi.fn(), warn: vi.fn(), debug: vi.fn() };
    expect(createNativeToasts({ enabled: false, language: () => 'en', log })).toBe(DISABLED_NATIVE_TOASTS);
    expect(DISABLED_NATIVE_TOASTS.available()).toBe(false);
    DISABLED_NATIVE_TOASTS.show(ENTRY, 'done', 'x');
    DISABLED_NATIVE_TOASTS.clear(ENTRY);
    await DISABLED_NATIVE_TOASTS.idle();
  });
});
