/**
 * Prompt queue of one entry (WP-13 §3.5.7; B "Gequeuete Nachrichten", F.9, R0-29): prompts Parallax
 * sent that the CLI has not started yet. `sending` = accepted by Parallax, `queued` =
 * `command_lifecycle queued`; `started`/`completed`/`cancelled` remove a prompt (its
 * `user_message` item comes from the normalizer), so does its uuid in a result's
 * `user_message_uuids` (fallback without `msg_lifecycle_v1`). Order = insertion order. Every
 * change is reported by the caller as `detail.patch {queue}` + `queue_changed`.
 */
import type { PromptPriority } from '@shared/common';
import type { BlobRef, CappedText, QueuedPrompt } from '@shared/model';

export interface QueueAdd {
  messageUuid: string;
  text: CappedText;
  attachments: BlobRef[];
  priority: PromptPriority;
  queuedAt: string;
}

export type LifecycleState = 'queued' | 'started' | 'completed' | 'cancelled';

export class PromptQueue {
  private items: QueuedPrompt[] = [];

  add(p: QueueAdd): void {
    this.items.push({
      messageUuid: p.messageUuid,
      text: p.text,
      attachments: p.attachments,
      priority: p.priority,
      state: 'sending',
      queuedAt: p.queuedAt,
    });
  }

  /** Removes a prompt the backend refused (send threw). */
  remove(messageUuid: string): boolean {
    const before = this.items.length;
    this.items = this.items.filter((p) => p.messageUuid !== messageUuid);
    return this.items.length !== before;
  }

  /** True if the queue changed (unknown uuids are ignored). */
  onLifecycle(messageUuid: string, state: LifecycleState): boolean {
    const index = this.items.findIndex((p) => p.messageUuid === messageUuid);
    const current = this.items[index];
    if (current === undefined) return false;
    if (state === 'queued') {
      if (current.state === 'queued') return false;
      this.items = this.items.map((p, i) => (i === index ? { ...p, state: 'queued' } : p));
      return true;
    }
    this.items = this.items.filter((_, i) => i !== index);
    return true;
  }

  /** Taken over once listed in a result's user_message_uuids (also without lifecycle). */
  onTurnResult(uuids: readonly string[]): boolean {
    if (uuids.length === 0) return false;
    const listed = new Set(uuids);
    const before = this.items.length;
    this.items = this.items.filter((p) => !listed.has(p.messageUuid));
    return this.items.length !== before;
  }

  /** Process end: removes all and returns the ones never started (all still queued ones). */
  drain(): QueuedPrompt[] {
    const drained = this.items;
    this.items = [];
    return drained;
  }

  list(): QueuedPrompt[] {
    return this.items.map((p) => ({ ...p }));
  }

  count(): number {
    return this.items.length;
  }
}
