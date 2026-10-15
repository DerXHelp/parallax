/**
 * AsyncQueue<T> (WP-13 §3.1): one producer, ONE consumer – used for `AgentSession.events` and the
 * SDK streaming input. Values pushed before `end()` are always delivered first; afterwards a
 * pending or later `next()` resolves `done` (or rejects once with the error given to `end`).
 *
 * The consumer may stop early (`break` in `for await` → `return()`): buffered values are dropped
 * and later pushes are ignored (the producer cannot know that nobody listens any more).
 */
interface Waiter<T> {
  resolve(result: IteratorResult<T>): void;
  reject(error: Error): void;
}

export class AsyncQueue<T> implements AsyncIterable<T> {
  /** Boxed, so `T` may include `undefined`. */
  private readonly buffer: { value: T }[] = [];
  private readonly waiters: Waiter<T>[] = [];
  private endError: Error | null = null;
  private isEnded = false;
  private errorDelivered = false;
  private consumerDone = false;
  private iterated = false;

  /** Appends a value; throws after `end()`. */
  push(value: T): void {
    if (this.isEnded) throw new Error('AsyncQueue: push after end()');
    if (this.consumerDone) return;
    const waiter = this.waiters.shift();
    if (waiter !== undefined) waiter.resolve({ value, done: false });
    else this.buffer.push({ value });
  }

  /** Ends the queue (idempotent): buffered values stay readable, then `done` (or the error once). */
  end(error?: Error): void {
    if (this.isEnded) return;
    this.isEnded = true;
    this.endError = error ?? null;
    while (this.waiters.length > 0) {
      const waiter = this.waiters.shift();
      if (waiter === undefined) break;
      this.settleEnded(waiter);
    }
  }

  /** True after `end()`. */
  get ended(): boolean {
    return this.isEnded;
  }

  /** Buffered values not yet consumed. */
  get size(): number {
    return this.buffer.length;
  }

  [Symbol.asyncIterator](): AsyncIterator<T> {
    if (this.iterated) throw new Error('AsyncQueue: single consumer – the queue is already being iterated');
    this.iterated = true;
    return {
      next: () => this.next(),
      return: () => {
        this.consumerDone = true;
        this.buffer.length = 0;
        return Promise.resolve({ value: undefined, done: true });
      },
    };
  }

  private next(): Promise<IteratorResult<T>> {
    if (this.consumerDone) return Promise.resolve({ value: undefined, done: true });
    const boxed = this.buffer.shift();
    if (boxed !== undefined) return Promise.resolve({ value: boxed.value, done: false });
    return new Promise<IteratorResult<T>>((resolve, reject) => {
      const waiter: Waiter<T> = { resolve, reject };
      if (this.isEnded) this.settleEnded(waiter);
      else this.waiters.push(waiter);
    });
  }

  private settleEnded(waiter: Waiter<T>): void {
    if (this.endError !== null && !this.errorDelivered) {
      this.errorDelivered = true;
      waiter.reject(this.endError);
      return;
    }
    waiter.resolve({ value: undefined, done: true });
  }
}
