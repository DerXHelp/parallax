/**
 * Test helpers (never imported by production code): a minimal Web Audio stand-in that records the
 * graph, so tests can read gains and frequencies of `playSound` (sounds.ts). Install it with
 * `vi.stubGlobal('AudioContext', FakeAudioContext)` and call `resetAudio()` around each test.
 */

export class FakeParam {
  value = 1;
  readonly events: { type: 'set' | 'linear' | 'exp'; value: number; time: number }[] = [];
  setValueAtTime(value: number, time: number): void {
    this.events.push({ type: 'set', value, time });
  }
  linearRampToValueAtTime(value: number, time: number): void {
    this.events.push({ type: 'linear', value, time });
  }
  exponentialRampToValueAtTime(value: number, time: number): void {
    this.events.push({ type: 'exp', value, time });
  }
}

export class FakeNode {
  readonly connections: unknown[] = [];
  disconnected = false;
  connect(target: unknown): void {
    this.connections.push(target);
  }
  disconnect(): void {
    this.disconnected = true;
  }
}

export class FakeGain extends FakeNode {
  readonly gain = new FakeParam();
}

export class FakeOscillator extends FakeNode {
  type = 'sine';
  readonly frequency = new FakeParam();
  startAt: number | null = null;
  stopAt: number | null = null;
  onended: (() => void) | null = null;
  start(time: number): void {
    this.startAt = time;
  }
  stop(time: number): void {
    this.stopAt = time;
  }
}

export class FakeAudioContext {
  static instances: FakeAudioContext[] = [];
  /** What `resume()` achieves (false = no user activation). */
  static resumable = true;
  state: 'suspended' | 'running' | 'closed' = 'running';
  currentTime = 2;
  readonly destination = new FakeNode();
  readonly gains: FakeGain[] = [];
  readonly oscillators: FakeOscillator[] = [];

  constructor() {
    FakeAudioContext.instances.push(this);
  }

  static reset(): void {
    FakeAudioContext.instances = [];
    FakeAudioContext.resumable = true;
  }

  static last(): FakeAudioContext {
    const context = FakeAudioContext.instances.at(-1);
    if (context === undefined) throw new Error('no AudioContext created');
    return context;
  }

  createGain(): FakeGain {
    const node = new FakeGain();
    this.gains.push(node);
    return node;
  }

  createOscillator(): FakeOscillator {
    const node = new FakeOscillator();
    this.oscillators.push(node);
    return node;
  }

  resume(): Promise<void> {
    if (FakeAudioContext.resumable) this.state = 'running';
    return Promise.resolve();
  }

  suspend(): Promise<void> {
    this.state = 'suspended';
    return Promise.resolve();
  }

  /** Master gains (the first gain of every sound: connected to the destination). */
  masterGains(): number[] {
    return this.gains.filter((gain) => gain.connections.includes(this.destination)).map((g) => g.gain.value);
  }

  /** Ends every oscillator (the audio clock passed their stop time). */
  endAll(): void {
    for (const oscillator of this.oscillators) oscillator.onended?.();
  }
}
