import { memo } from 'react';
import { useItem } from '@web/state/hooks';
import { AssistantTextRow, ThinkingRow, UserMessageRow } from './MessageRows';
import { SystemRow } from './SystemRow';
import { ToolCallRow } from './ToolCallRow';
import { TurnFooter } from './TurnFooter';

/**
 * One transcript item by id: `useItem` re-renders exactly this row when the item changes (its own
 * deltas, its final upsert) – the list never re-renders for a delta (architecture §2.3g).
 */
export const TranscriptRow = memo(function TranscriptRow({
  sessionKey,
  itemId,
}: {
  sessionKey: string;
  itemId: string;
  /** Inside an Agent card (no outer spacing). */
  nested?: boolean;
}) {
  const item = useItem(sessionKey, itemId);
  if (item === null) return null;
  switch (item.kind) {
    case 'user_message':
      return <UserMessageRow item={item} sessionKey={sessionKey} />;
    case 'assistant_text':
      return <AssistantTextRow item={item} sessionKey={sessionKey} />;
    case 'thinking':
      return <ThinkingRow item={item} sessionKey={sessionKey} />;
    case 'tool_call':
      return <ToolCallRow item={item} sessionKey={sessionKey} />;
    case 'system':
      return <SystemRow item={item} sessionKey={sessionKey} />;
    case 'turn_result':
      return <TurnFooter item={item} />;
  }
});
