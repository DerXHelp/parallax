import type { ConversationId } from '@shared/common';
import type { Conversation } from '@shared/model';

/**
 * "Earlier conversations" (ADR-107): every conversation of an entry except the current one, newest
 * start first (`detail.conversations` itself is ordered by "last current", not by start).
 */
export function earlierConversations(
  conversations: readonly Conversation[],
  current: ConversationId,
): Conversation[] {
  return conversations
    .filter((conversation) => conversation.id !== current)
    .sort((a, b) => Date.parse(b.startedAt) - Date.parse(a.startedAt));
}
