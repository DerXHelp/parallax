import { describe, expect, it, vi } from 'vitest';
import type { Language } from '@shared/common';
import { DEFAULT_NOTIFICATION_EVENTS } from '@shared/model';
import { sampleId, sampleSettings } from '@shared/samples';
import type { NotificationKind } from '@shared/status';
import type { ToastRequest, ToastResult } from '../lib/toast';
import {
  DISABLED_NATIVE_TOASTS,
  TOAST_TEXTS,
  createNativeToasts,
  toastShowOptions,
  toastText,
} from './nativeToasts';

const ENTRY = sampleId('en', 1);

function setup(results: ToastResult[] = [], language: Language = 'en') {
  const shown: ToastRequest[] = [];
  const removed: string[] = [];
  const log = { info: vi.fn(), warn: vi.fn(), debug: vi.fn() };
  const onUnavailable = vi.fn();
  const clock = { ms: 0 };
  let n = 0;
  const next = (): Promise<ToastResult> => Promise.resolve(results[n++] ?? { kind: 'shown' });
  const toasts = createNativeToasts({
    enabled: true,
    language: () => language,
    log,
    onUnavailable,
    now: () => clock.ms,
    show: (request) => {
      shown.push(request);
      return next();
    },
    remove: (tag) => {
      removed.push(tag);
      return next();
    },
  });
  return { toasts, shown, removed, log, onUnavailable, clock };
}

const TIMEOUT: ToastResult = { kind: 'failed', reason: 'timeout', permanent: false };

describe('native toasts (WP22-03/-15, A.9)', () => {
  it('texts per language mirror the web kinds; the body names no click (Phase 1)', () => {
    expect(toastText('en', 'plan', 'Auth')).toBe('Auth – plan ready for review');
    expect(toastText('de', 'permission', 'Auth')).toBe('Auth – braucht eine Freigabe');
    for (const language of ['en', 'de'] as const) {
      expect(TOAST_TEXTS[language].body).not.toMatch(/click|klick/i);
    }
  });

  it("CR-03: the title is inserted literally ($&, $`, $', $$ are no replacement patterns)", () => {
    expect(toastText('en', 'done', 'Fix $& escaping')).toBe('Fix $& escaping – done');
    expect(toastText('de', 'error', "a$`b$'c$$d")).toBe("a$`b$'c$$d – Fehler");
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

  it('a deterministic failure (CLM, WinRT missing) switches the channel off and reports it once', async () => {
    const { toasts, shown, log, onUnavailable } = setup([
      { kind: 'failed', reason: 'exit 4: error[setup]: language mode ConstrainedLanguage', permanent: true },
    ]);
    toasts.show(ENTRY, 'done', 'A');
    toasts.show(ENTRY, 'done', 'B');
    await toasts.idle();
    expect(shown).toHaveLength(1);
    expect(toasts.available()).toBe(false);
    expect(onUnavailable).toHaveBeenCalledTimes(1);
    expect(log.warn).toHaveBeenCalledWith(
      expect.objectContaining({ reason: 'exit 4: error[setup]: language mode ConstrainedLanguage' }),
      expect.stringContaining('stay in-app'),
    );
    toasts.show(ENTRY, 'done', 'C');
    await toasts.idle();
    expect(shown).toHaveLength(1);
  });

  it('CR-05: a timeout under load is counted, the channel stays on', async () => {
    const { toasts, shown, onUnavailable } = setup([TIMEOUT]);
    toasts.show(ENTRY, 'done', 'A');
    toasts.show(ENTRY, 'question', 'B');
    await toasts.idle();
    expect(shown.map((r) => r.title)).toEqual(['A – done', 'B – has a question']);
    expect(toasts.available()).toBe(true);
    expect(onUnavailable).not.toHaveBeenCalled();
  });

  it('CR-05: a failed History.Remove is counted, the channel stays on', async () => {
    const { toasts, shown, removed, onUnavailable } = setup([
      { kind: 'shown' },
      { kind: 'failed', reason: 'exit 3: error[remove]: Element not found.', permanent: false },
    ]);
    toasts.show(ENTRY, 'done', 'A');
    toasts.clear(ENTRY);
    toasts.show(ENTRY, 'question', 'B');
    await toasts.idle();
    expect(removed).toEqual([ENTRY]);
    expect(shown.map((r) => r.title)).toEqual(['A – done', 'B – has a question']);
    expect(toasts.available()).toBe(true);
    expect(onUnavailable).not.toHaveBeenCalled();
  });

  it('CR-05: from the third failure in a row the channel pauses (1 min, doubled); a success resets', async () => {
    const { toasts, shown, clock } = setup([TIMEOUT, TIMEOUT, TIMEOUT, TIMEOUT]);
    const show = async (title: string): Promise<void> => {
      toasts.show(ENTRY, 'done', title);
      await toasts.idle();
    };
    await show('1');
    await show('2');
    await show('3');
    expect(shown).toHaveLength(3);
    // Paused for 1 min: nothing is started.
    clock.ms = 59_999;
    await show('skipped');
    expect(shown).toHaveLength(3);
    clock.ms = 60_000;
    await show('4');
    expect(shown).toHaveLength(4);
    // Fourth failure in a row: 2 min.
    clock.ms = 60_000 + 119_999;
    await show('skipped');
    expect(shown).toHaveLength(4);
    clock.ms = 60_000 + 120_000;
    await show('5'); // succeeds → counter and pause reset
    await show('6');
    expect(shown.map((r) => r.title)).toEqual(['1', '2', '3', '4', '5', '6'].map((t) => `${t} – done`));
    expect(toasts.available()).toBe(true);
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

  it('ADR-109 (WP-34): show with options passes launchUri and silent to the toast request', async () => {
    const { toasts, shown } = setup();
    toasts.show(ENTRY, 'done', 'A', { launchUri: `parallax://session/${ENTRY}`, silent: true });
    toasts.show(ENTRY, 'error', 'B', { launchUri: null, silent: false });
    await toasts.idle();
    expect(shown).toEqual([
      {
        title: 'A – done',
        body: TOAST_TEXTS.en.body,
        tag: ENTRY,
        launchUri: `parallax://session/${ENTRY}`,
        silent: true,
      },
      { title: 'B – error', body: TOAST_TEXTS.en.body, tag: ENTRY, launchUri: null, silent: false },
    ]);
  });

  it.each<[string, NotificationKind, boolean, string | null, { launchUri: string | null; silent: boolean }]>([
    [
      'handler registered, sound on',
      'permission',
      true,
      'parallax://session/x',
      { launchUri: 'parallax://session/x', silent: false },
    ],
    ['no handler (openOnClick off)', 'done', true, null, { launchUri: null, silent: false }],
    [
      'sound off for the event',
      'question',
      false,
      'parallax://session/x',
      { launchUri: 'parallax://session/x', silent: true },
    ],
  ])('toastShowOptions: %s', (_name, kind, sound, uri, expected) => {
    const settings = sampleSettings();
    const events = {
      ...settings.notifications.events,
      [kind]: { ...settings.notifications.events[kind], sound },
    };
    const asked: string[] = [];
    const system = {
      toastLaunchUri: (entryId: string) => {
        asked.push(entryId);
        return uri;
      },
    };
    expect(
      toastShowOptions(
        ENTRY,
        kind,
        { ...settings, notifications: { ...settings.notifications, events } },
        system,
      ),
    ).toEqual(expected);
    expect(asked).toEqual([ENTRY]);
  });

  it('toastShowOptions without a system integration: no click target; rate_limit is silent by default', () => {
    expect(toastShowOptions(ENTRY, 'rate_limit', sampleSettings(), undefined)).toEqual({
      launchUri: null,
      silent: !DEFAULT_NOTIFICATION_EVENTS.rate_limit.sound,
    });
    expect(toastShowOptions(ENTRY, 'done', sampleSettings(), null)).toEqual({
      launchUri: null,
      silent: false,
    });
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
