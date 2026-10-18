import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { SOUND_IDS } from '@shared/model';
import {
  MAX_SOUND_S,
  SOUNDS,
  audioState,
  installAudioUnlock,
  playSound,
  resetAudio,
  soundLength,
  subscribeAudioUnlock,
  unlockAudio,
} from './sounds';
import { FakeAudioContext } from './testing';

beforeEach(() => {
  FakeAudioContext.reset();
  vi.stubGlobal('AudioContext', FakeAudioContext);
  resetAudio();
});

afterEach(() => {
  resetAudio();
  vi.unstubAllGlobals();
});

describe('sounds (ADR-109: Web Audio, synthesized, ≤ 600 ms)', () => {
  it('has five sounds, each a short oscillator envelope', () => {
    expect(Object.keys(SOUNDS).sort()).toEqual([...SOUND_IDS].sort());
    for (const id of SOUND_IDS) {
      expect(soundLength(id), id).toBeLessThanOrEqual(MAX_SOUND_S);
      for (const tone of SOUNDS[id]) {
        expect(tone.frequency).toBeGreaterThan(0);
        expect(tone.peak).toBeGreaterThan(0);
      }
      // Tones that sound at the same time never add up beyond 1 (no clipping).
      for (const tone of SOUNDS[id]) {
        const together = SOUNDS[id].filter((u) => u.at <= tone.at && tone.at < u.at + u.duration);
        expect(
          together.reduce((sum, u) => sum + u.peak, 0),
          id,
        ).toBeLessThanOrEqual(1);
      }
    }
  });

  it('is locked before the first interaction and creates no AudioContext until a sound is asked for', () => {
    const uninstall = installAudioUnlock(window);
    expect(audioState()).toBe('locked');
    expect(FakeAudioContext.instances).toHaveLength(0);
    uninstall();
  });

  it('is unsupported without Web Audio', async () => {
    vi.stubGlobal('AudioContext', undefined);
    unlockAudio();
    expect(audioState()).toBe('unsupported');
    expect(await playSound('chime', 0.6)).toBe('unsupported');
  });

  it('plays after the unlock; the gain of the whole sound is the volume', async () => {
    unlockAudio();
    expect(audioState()).toBe('ready');
    expect(await playSound('chime', 0.35)).toBe('played');
    const context = FakeAudioContext.last();
    const [master, ...envelopes] = context.gains;
    expect(master?.gain.value).toBe(0.35);
    expect(master?.connections).toEqual([context.destination]);
    expect(envelopes).toHaveLength(SOUNDS.chime.length);
    expect(context.oscillators.map((o) => o.frequency.events[0]?.value)).toEqual(
      SOUNDS.chime.map((tone) => tone.frequency),
    );
    // Envelope: silent → peak → silent, all within the sound length.
    expect(envelopes[0]?.gain.events.map((event) => event.type)).toEqual(['set', 'linear', 'exp']);
    for (const oscillator of context.oscillators) {
      expect(oscillator.startAt).toBeGreaterThanOrEqual(context.currentTime);
      expect((oscillator.stopAt ?? 0) - context.currentTime).toBeLessThanOrEqual(MAX_SOUND_S + 0.05);
    }
  });

  it('clamps the volume to 0–1 and plays every sound in one context', async () => {
    unlockAudio();
    await playSound('alert', 1.7);
    await playSound('pop', -1);
    expect(FakeAudioContext.last().masterGains()).toEqual([1, 0]);
    for (const id of SOUND_IDS) expect(await playSound(id, 0.5)).toBe('played');
    expect(FakeAudioContext.instances).toHaveLength(1);
  });

  it('suspends the context when silent and resumes it for the next sound', async () => {
    unlockAudio();
    await playSound('ping', 0.5);
    const context = FakeAudioContext.last();
    context.endAll();
    await Promise.resolve();
    expect(context.state).toBe('suspended');
    expect(context.oscillators.every((o) => o.disconnected)).toBe(true);
    expect(await playSound('ping', 0.5)).toBe('played');
    expect(context.state).toBe('running');
  });

  it('a context that cannot resume (no user activation) is locked until the next interaction', async () => {
    FakeAudioContext.resumable = false;
    class SuspendedContext extends FakeAudioContext {
      override state: 'suspended' | 'running' | 'closed' = 'suspended';
    }
    vi.stubGlobal('AudioContext', SuspendedContext);
    unlockAudio();
    expect(await playSound('bell', 0.5)).toBe('locked');
    expect(audioState()).toBe('locked');
    FakeAudioContext.resumable = true;
    unlockAudio();
    expect(await playSound('bell', 0.5)).toBe('played');
  });

  it('unlocks on the first pointerdown or keydown in the window and tells the listeners once', () => {
    const listener = vi.fn();
    const stopListening = subscribeAudioUnlock(listener);
    const uninstall = installAudioUnlock(window);
    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'a' }));
    expect(audioState()).toBe('ready');
    window.dispatchEvent(new Event('pointerdown'));
    expect(listener).toHaveBeenCalledOnce();
    uninstall();
    stopListening();
  });

  it('no listener runs after uninstalling', () => {
    const uninstall = installAudioUnlock(window);
    uninstall();
    window.dispatchEvent(new Event('pointerdown'));
    expect(audioState()).toBe('locked');
  });
});

describe('sounds without an interaction when the browser allows it (WP41-01, ADR-120)', () => {
  afterEach(() => {
    Reflect.deleteProperty(navigator, 'getAutoplayPolicy');
  });

  function stubAutoplayPolicy(answer: string): void {
    Object.defineProperty(navigator, 'getAutoplayPolicy', { configurable: true, value: () => answer });
  }

  it("Parallax' Edge window (a new context runs at once): the first sound plays and unlocks before it settles", async () => {
    const listener = vi.fn();
    subscribeAudioUnlock(listener);
    expect(audioState()).toBe('locked');
    const result = playSound('chime', 0.5);
    // Already now – the window's own Web Notification reads this for its silent flag (delivery.ts).
    expect(audioState()).toBe('ready');
    expect(listener).toHaveBeenCalledOnce();
    expect(await result).toBe('played');
    expect(FakeAudioContext.instances).toHaveLength(1);
    expect(FakeAudioContext.last().masterGains()).toEqual([0.5]);
  });

  it('a context that runs only after resume() (spec order) unlocks as well', async () => {
    FakeAudioContext.initialState = 'suspended';
    const listener = vi.fn();
    subscribeAudioUnlock(listener);
    expect(await playSound('pop', 0.5)).toBe('played');
    expect(audioState()).toBe('ready');
    expect(listener).toHaveBeenCalledOnce();
  });

  it('a browser that wants a gesture: the first sound asks once and stays locked; the interaction unlocks the same context', async () => {
    FakeAudioContext.initialState = 'suspended';
    FakeAudioContext.resumable = false;
    const listener = vi.fn();
    subscribeAudioUnlock(listener);
    expect(await playSound('bell', 0.5)).toBe('locked');
    expect(await playSound('bell', 0.5)).toBe('locked');
    // Asked once, not with every sound.
    expect(FakeAudioContext.instances).toHaveLength(1);
    expect(FakeAudioContext.last().resumeCalls).toBe(1);
    expect(audioState()).toBe('locked');
    expect(listener).not.toHaveBeenCalled();
    // The first click gives the page its user activation.
    FakeAudioContext.resumable = true;
    unlockAudio();
    expect(listener).toHaveBeenCalledOnce();
    expect(await playSound('bell', 0.5)).toBe('played');
    expect(FakeAudioContext.instances).toHaveLength(1);
  });

  it('navigator.getAutoplayPolicy answers without a context: "allowed" unlocks at install, otherwise the sound stays locked', async () => {
    stubAutoplayPolicy('allowed-muted');
    let uninstall = installAudioUnlock(window);
    expect(audioState()).toBe('locked');
    expect(await playSound('ping', 0.5)).toBe('locked');
    expect(FakeAudioContext.instances).toHaveLength(0);
    uninstall();

    resetAudio();
    stubAutoplayPolicy('allowed');
    const listener = vi.fn();
    subscribeAudioUnlock(listener);
    uninstall = installAudioUnlock(window);
    expect(audioState()).toBe('ready');
    expect(listener).toHaveBeenCalledOnce();
    expect(FakeAudioContext.instances).toHaveLength(0);
    expect(await playSound('ping', 0.5)).toBe('played');
    uninstall();
  });
});
