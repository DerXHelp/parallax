import { describe, expect, it } from 'vitest';
import { queuedPromptSchema } from '@shared/model';
import { SAMPLE_TIME, sampleUuid } from '@shared/samples';
import { PromptQueue } from './promptQueue';

function add(queue: PromptQueue, n: number, priority: 'next' | 'now' = 'next'): string {
  const messageUuid = sampleUuid(n);
  queue.add({
    messageUuid,
    text: { text: `prompt ${String(n)}`, truncated: null },
    attachments: [],
    priority,
    queuedAt: SAMPLE_TIME,
  });
  return messageUuid;
}

describe('PromptQueue', () => {
  it('add → sending, queued → queued, started/completed/cancelled → removed; insertion order', () => {
    const q = new PromptQueue();
    const a = add(q, 1);
    const b = add(q, 2, 'now');
    const c = add(q, 3);
    expect(q.list().map((p) => [p.messageUuid, p.state, p.priority])).toEqual([
      [a, 'sending', 'next'],
      [b, 'sending', 'now'],
      [c, 'sending', 'next'],
    ]);
    for (const p of q.list()) expect(queuedPromptSchema.parse(p)).toEqual(p);
    expect(q.onLifecycle(b, 'queued')).toBe(true);
    expect(q.onLifecycle(b, 'queued')).toBe(false);
    expect(q.list().find((p) => p.messageUuid === b)?.state).toBe('queued');
    expect(q.onLifecycle(a, 'started')).toBe(true);
    expect(q.onLifecycle(b, 'completed')).toBe(true);
    expect(q.onLifecycle(c, 'cancelled')).toBe(true);
    expect(q.count()).toBe(0);
  });

  it('lifecycle of an unknown uuid is ignored (also before queued: started removes directly)', () => {
    const q = new PromptQueue();
    const a = add(q, 1);
    expect(q.onLifecycle(sampleUuid(9), 'queued')).toBe(false);
    expect(q.onLifecycle(sampleUuid(9), 'started')).toBe(false);
    expect(q.onLifecycle(a, 'started')).toBe(true);
    expect(q.onLifecycle(a, 'completed')).toBe(false);
  });

  it('a result taking over user_message_uuids removes them (no msg_lifecycle_v1, R0-29)', () => {
    const q = new PromptQueue();
    const a = add(q, 1);
    const b = add(q, 2);
    expect(q.onTurnResult([])).toBe(false);
    expect(q.onTurnResult([sampleUuid(7)])).toBe(false);
    expect(q.onTurnResult([a])).toBe(true);
    expect(q.list().map((p) => p.messageUuid)).toEqual([b]);
  });

  it('drain returns everything not started and empties the queue; remove drops one', () => {
    const q = new PromptQueue();
    const a = add(q, 1);
    const b = add(q, 2);
    expect(q.remove(sampleUuid(5))).toBe(false);
    expect(q.remove(a)).toBe(true);
    q.onLifecycle(b, 'queued');
    expect(q.drain().map((p) => [p.messageUuid, p.state])).toEqual([[b, 'queued']]);
    expect(q.count()).toBe(0);
    expect(q.drain()).toEqual([]);
  });

  it('list returns copies', () => {
    const q = new PromptQueue();
    add(q, 1);
    const list = q.list();
    list.pop();
    expect(q.count()).toBe(1);
  });
});
