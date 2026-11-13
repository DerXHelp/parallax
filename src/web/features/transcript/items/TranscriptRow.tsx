import { lazy, memo, Suspense } from 'react';
import { SlotBoundary } from '@web/shell/SlotBoundary';
import { useItem } from '@web/state/hooks';
import { AssistantTextRow, ThinkingRow, UserMessageRow } from './MessageRows';
import { SystemRow } from './SystemRow';
import { ToolCallRow } from './ToolCallRow';
import { TurnFooter } from './TurnFooter';

/*
 * WP-66 (start-chunk budget): the side-question card is a chunk of its own – rare, and loaded only
 * when a transcript holds one. Its own boundary: a chunk that cannot be loaded shows the small error
 * card in its row, the rest of the transcript stays.
 */
const SideQuestionCard = lazy(() =>
  import('./SideQuestionCard').then((module) => ({ default: module.SideQuestionCard })),
);

/**
 * One transcript item by id: `useItem` re-renders exactly this row when the item changes (its own
 * deltas, its final upsert) – the list never re-renders for a delta (architecture §2.3g).
 */
export const TranscriptRow = memo(function TranscriptRow({
  sessionKey,
  itemId,
  hideImages = false,
}: {
  sessionKey: string;
  itemId: string;
  /** Inside an Agent card (no outer spacing). */
  nested?: boolean;
  /** WP-63 §1.5: a tool call's pictures stand in a gallery of the list. */
  hideImages?: boolean;
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
      return <ToolCallRow item={item} sessionKey={sessionKey} hideImages={hideImages} />;
    case 'system':
      return <SystemRow item={item} sessionKey={sessionKey} />;
    case 'turn_result':
      return <TurnFooter item={item} />;
    case 'side_question':
      return (
        <SlotBoundary resetKey={item.threadId} className="p-0">
          <Suspense fallback={<div className="h-16 rounded-md border border-dashed" />}>
            <SideQuestionCard item={item} sessionKey={sessionKey} />
          </Suspense>
        </SlotBoundary>
      );
  }
});
