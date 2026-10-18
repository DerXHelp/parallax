import type { SoundId } from '@shared/model';

/**
 * Notification sounds (ADR-109, WP-38): five short sounds synthesized with Web Audio – oscillators
 * with an attack/decay envelope, at most 600 ms, no audio files, nothing from the network.
 *
 * Browser autoplay policy: before the first user interaction of the window a sound is `locked` –
 * unless the browser lets audio start without one. Parallax' own Edge window runs with
 * `--autoplay-policy=no-user-gesture-required` (ADR-120), so the first sound requested before any
 * interaction asks the browser once (WP41-01): `navigator.getAutoplayPolicy('audiocontext')` where
 * it exists (no context needed; also checked by `installAudioUnlock`), otherwise a context is
 * created – `running` (Chromium reports it at once) or running after `resume()` unlocks the sounds
 * and tells the unlock listeners; else the sound stays `locked` and no later sound asks again.
 * `installAudioUnlock` (started with the notification delivery) calls `unlockAudio` on the first
 * pointerdown/keydown; preview buttons call it directly (their click is the interaction). The
 * AudioContext is created lazily with the first sound and suspended again while silent (no audio
 * thread running for nothing). The volume is the gain of the whole sound (0–1).
 */

export type PlayResult = 'played' | 'locked' | 'unsupported';
/**
 * `ready` = unlocked (the next sound plays), `locked` = no interaction yet and the browser did not
 * (yet) allow audio without one (WP41-01), `unsupported` = no Web Audio.
 */
export type AudioState = 'ready' | 'locked' | 'unsupported';

/** One oscillator with an envelope; times in seconds from the start of the sound. */
export interface Tone {
  wave: OscillatorType;
  /** Hz. */
  frequency: number;
  /** Exponential glide to this frequency over the tone (e.g. "pop"). */
  glideTo?: number;
  at: number;
  /** Attack + decay to silence. */
  duration: number;
  /** Peak gain of the envelope (before the volume); the tones of a sound add up to ≤ 1. */
  peak: number;
}

export const ATTACK_S = 0.008;
/** Oscillators stop this long after their envelope reached silence. */
export const STOP_MARGIN_S = 0.01;
/** ADR-109: every sound is shorter than this. */
export const MAX_SOUND_S = 0.6;
/** Lead time so the first envelope point is never in the past of the audio clock. */
const LEAD_S = 0.01;
/** Exponential ramps cannot reach 0. */
const SILENT = 0.0001;
/** A suspended context that does not run within this time counts as locked (no user activation). */
const RESUME_TIMEOUT_MS = 500;

/**
 * The sounds (Plan "mehrere mitgelieferte kurze Sounds"): chime = two rising notes (questions,
 * permissions), ping = one high note, pop = a short drop (done), bell = a note with inharmonic
 * partials (plan to review), alert = two short triangle beeps (errors).
 */
export const SOUNDS: Readonly<Record<SoundId, readonly Tone[]>> = {
  chime: [
    { wave: 'sine', frequency: 659.25, at: 0, duration: 0.3, peak: 0.45 },
    { wave: 'sine', frequency: 987.77, at: 0.12, duration: 0.42, peak: 0.4 },
  ],
  ping: [
    { wave: 'sine', frequency: 1318.51, at: 0, duration: 0.36, peak: 0.5 },
    { wave: 'sine', frequency: 2637.02, at: 0, duration: 0.12, peak: 0.08 },
  ],
  pop: [{ wave: 'sine', frequency: 520, glideTo: 180, at: 0, duration: 0.14, peak: 0.8 }],
  bell: [
    { wave: 'sine', frequency: 880, at: 0, duration: 0.56, peak: 0.45 },
    { wave: 'sine', frequency: 2428.8, at: 0, duration: 0.32, peak: 0.12 },
    { wave: 'sine', frequency: 4752, at: 0, duration: 0.14, peak: 0.05 },
  ],
  alert: [
    { wave: 'triangle', frequency: 784, at: 0, duration: 0.13, peak: 0.6 },
    { wave: 'triangle', frequency: 784, at: 0.17, duration: 0.13, peak: 0.6 },
  ],
};

/** Length of a sound in seconds (last oscillator stop). */
export function soundLength(id: SoundId): number {
  return Math.max(...SOUNDS[id].map((tone) => tone.at + tone.duration)) + STOP_MARGIN_S;
}

let context: AudioContext | null = null;
let unlocked = false;
/** The browser was asked once whether audio may start without an interaction (WP41-01). */
let probed = false;
/** Sounds still playing on `context` (it is suspended when the last one ends). */
let playing = 0;
/** A running `suspend()` – the next sound waits for it before resuming. */
let suspending: Promise<void> | null = null;
const unlockListeners = new Set<() => void>();

function audioContextClass(): typeof AudioContext | null {
  return typeof AudioContext === 'function' ? AudioContext : null;
}

/** `navigator.getAutoplayPolicy` (Firefox so far; not in lib.dom). */
interface AutoplayPolicyNavigator {
  getAutoplayPolicy?: (type: 'audiocontext') => string;
}

/**
 * What the browser says up front about starting Web Audio without a gesture – without creating a
 * context (no console warning): true/false, or null where it cannot tell (Chromium).
 */
function autoplayAllowed(): boolean | null {
  if (typeof navigator === 'undefined') return null;
  const nav: Navigator & AutoplayPolicyNavigator = navigator;
  if (typeof nav.getAutoplayPolicy !== 'function') return null;
  try {
    return nav.getAutoplayPolicy('audiocontext') === 'allowed';
  } catch {
    return null;
  }
}

export function audioState(): AudioState {
  if (audioContextClass() === null) return 'unsupported';
  return unlocked ? 'ready' : 'locked';
}

/** Marks the user interaction (call from pointerdown/keydown/click); idempotent. */
export function unlockAudio(): void {
  if (audioContextClass() === null) return;
  if (unlocked) return;
  unlocked = true;
  for (const listener of [...unlockListeners]) listener();
}

/** Calls the listener when the sounds get unlocked; returns the remove function. */
export function subscribeAudioUnlock(listener: () => void): () => void {
  unlockListeners.add(listener);
  return () => {
    unlockListeners.delete(listener);
  };
}

type UnlockTarget = Pick<Window, 'addEventListener' | 'removeEventListener'>;

/**
 * Unlocks on the first pointerdown/keydown in the window (capture phase) – or right away when the
 * browser says up front that audio needs no gesture (WP41-01); returns the remove function.
 */
export function installAudioUnlock(target: UnlockTarget = window): () => void {
  if (autoplayAllowed() === true) unlockAudio();
  const handler = () => {
    unlockAudio();
  };
  target.addEventListener('pointerdown', handler, { capture: true, passive: true });
  target.addEventListener('keydown', handler, { capture: true });
  return () => {
    target.removeEventListener('pointerdown', handler, { capture: true });
    target.removeEventListener('keydown', handler, { capture: true });
  };
}

function settle(promise: Promise<void>, ms: number): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, ms);
    const done = () => {
      clearTimeout(timer);
      resolve();
    };
    promise.then(done, done);
  });
}

function finished(ctx: AudioContext): void {
  playing = Math.max(0, playing - 1);
  if (playing > 0 || ctx !== context || ctx.state !== 'running') return;
  const pending = ctx.suspend().then(
    () => undefined,
    () => undefined,
  );
  suspending = pending;
  void pending.then(() => {
    if (suspending === pending) suspending = null;
  });
}

function schedule(ctx: AudioContext, tones: readonly Tone[], volume: number): void {
  const master = ctx.createGain();
  master.gain.value = Math.min(1, Math.max(0, volume));
  master.connect(ctx.destination);
  const start = ctx.currentTime + LEAD_S;
  let open = tones.length;
  playing++;
  for (const tone of tones) {
    const oscillator = ctx.createOscillator();
    const envelope = ctx.createGain();
    const t0 = start + tone.at;
    const t1 = t0 + tone.duration;
    oscillator.type = tone.wave;
    oscillator.frequency.setValueAtTime(tone.frequency, t0);
    if (tone.glideTo !== undefined) oscillator.frequency.exponentialRampToValueAtTime(tone.glideTo, t1);
    envelope.gain.setValueAtTime(SILENT, t0);
    envelope.gain.linearRampToValueAtTime(tone.peak, t0 + ATTACK_S);
    envelope.gain.exponentialRampToValueAtTime(SILENT, t1);
    oscillator.connect(envelope);
    envelope.connect(master);
    oscillator.onended = () => {
      oscillator.disconnect();
      envelope.disconnect();
      open--;
      if (open > 0) return;
      master.disconnect();
      finished(ctx);
    };
    oscillator.start(t0);
    oscillator.stop(t1 + STOP_MARGIN_S);
  }
}

/** Plays a sound at `volume` (0–1); never throws. */
export async function playSound(id: SoundId, volume: number): Promise<PlayResult> {
  const Ctor = audioContextClass();
  if (Ctor === null) return 'unsupported';
  // WP41-01: without an interaction yet, the first sound asks the browser once (see the file comment).
  const probing = !unlocked;
  if (probing) {
    if (probed) return 'locked';
    probed = true;
    const allowed = autoplayAllowed();
    if (allowed === false) return 'locked';
    if (allowed === true) unlockAudio();
  }
  try {
    if (context === null || context.state === 'closed') {
      context = new Ctor();
      playing = 0;
    }
    const ctx = context;
    // Before the first await: the caller's next `audioState()` (e.g. the silent flag of its own
    // Web Notification, delivery.ts) already sees the unlock – no second sound from the toast.
    if (ctx.state === 'running') unlockAudio();
    if (suspending !== null) await suspending;
    if (ctx.state !== 'running') await settle(ctx.resume(), RESUME_TIMEOUT_MS);
    if (ctx.state !== 'running') {
      // No user activation after all (e.g. the first key was Esc, or the browser wants a gesture):
      // wait for the next interaction. The suspended context stays for the sounds after it.
      unlocked = false;
      return 'locked';
    }
    unlockAudio();
    schedule(ctx, SOUNDS[id], volume);
    return 'played';
  } catch {
    return 'unsupported';
  }
}

/** Tests: forget the context, the unlock, the browser probe and the listeners. */
export function resetAudio(): void {
  context = null;
  unlocked = false;
  probed = false;
  playing = 0;
  suspending = null;
  unlockListeners.clear();
}

/** What the notification delivery needs (tests inject a fake). */
export interface SoundPlayer {
  state(): AudioState;
  play(id: SoundId, volume: number): Promise<PlayResult>;
  onUnlock(listener: () => void): () => void;
  /** The user asked for sounds (button "Enable sounds" of the hint, R4W-05): a user interaction. */
  unlock?(): void;
}

export const webAudioPlayer: SoundPlayer = {
  state: audioState,
  play: playSound,
  onUnlock: subscribeAudioUnlock,
  unlock: unlockAudio,
};
