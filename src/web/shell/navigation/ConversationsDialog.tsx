import { useMemo, useState } from 'react';
import type { ConversationId } from '@shared/common';
import type { Conversation } from '@shared/model';
import { useFormat, useT } from '@web/i18n';
import { earlierConversations } from '@web/lib/conversations';
import { errorPayloadOf } from '@web/state/connection';
import { sendCommand, useSessionDetail, useSummary } from '@web/state/hooks';
import { showErrorNotice } from '@web/state/notices';
import { Button } from '@web/ui/button';
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@web/ui/dialog';
import { Skeleton } from '@web/ui/skeleton';

/**
 * "Earlier conversations" (request `conversations`, header menu, `/resume` of WP-37): title, start,
 * end and reason of each conversation before the current one; "Open" = `session.switchConversation`
 * (the server refuses busy sessions with SESSION_BUSY – shown as a notice).
 */
export function ConversationsDialog({ sessionKey, onClose }: { sessionKey: string; onClose: () => void }) {
  const t = useT();
  const format = useFormat();
  const summary = useSummary(sessionKey);
  const detail = useSessionDetail(sessionKey);
  const [pending, setPending] = useState<ConversationId | null>(null);
  const conversations = useMemo(
    () => (detail === null ? null : earlierConversations(detail.conversations, detail.conversationId)),
    [detail],
  );

  const open = (conversation: Conversation) => {
    if (summary === null) return;
    setPending(conversation.id);
    sendCommand(sessionKey, {
      name: 'session.switchConversation',
      entryId: summary.entryId,
      conversationId: conversation.id,
    }).then(
      () => {
        setPending(null);
        onClose();
      },
      (error: unknown) => {
        setPending(null);
        const payload = errorPayloadOf(error);
        showErrorNotice(payload, { sessionKey, tone: payload.code === 'SESSION_BUSY' ? 'warning' : 'error' });
      },
    );
  };

  return (
    <Dialog
      open
      onOpenChange={(next) => {
        if (!next) onClose();
      }}
    >
      <DialogContent data-slot="conversations-dialog" className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>{t('navigation.conversations.title')}</DialogTitle>
          <DialogDescription>{t('navigation.conversations.description')}</DialogDescription>
        </DialogHeader>
        {conversations === null ? (
          <div className="grid gap-2" aria-busy="true" aria-label={t('common.loading')}>
            <Skeleton className="h-12" />
            <Skeleton className="h-12" />
          </div>
        ) : conversations.length === 0 ? (
          <p className="text-muted-foreground text-xs">{t('navigation.conversations.empty')}</p>
        ) : (
          <ul
            aria-label={t('navigation.conversations.list')}
            className="grid max-h-[60vh] grid-cols-[minmax(0,1fr)] gap-1.5 overflow-y-auto"
          >
            {conversations.map((conversation) => (
              <li
                key={conversation.id}
                data-conversation={conversation.id}
                className="flex min-w-0 items-center gap-3 rounded-md border px-3 py-2"
              >
                <div className="grid min-w-0 flex-1 gap-0.5">
                  <span className="truncate font-medium">
                    {conversation.title ?? t('navigation.conversations.untitled')}
                  </span>
                  <span className="text-muted-foreground flex flex-wrap gap-x-1.5 text-2xs">
                    <span>
                      {t('navigation.conversations.started', {
                        time: format.dateTime(conversation.startedAt),
                      })}
                    </span>
                    {conversation.endedAt === null ? null : (
                      <>
                        <span aria-hidden>·</span>
                        <span>
                          {t('navigation.conversations.ended', {
                            time: format.dateTime(conversation.endedAt),
                          })}
                        </span>
                      </>
                    )}
                    {conversation.endReason === null ? null : (
                      <>
                        <span aria-hidden>·</span>
                        <span>{t(`navigation.conversations.reasons.${conversation.endReason}`)}</span>
                      </>
                    )}
                  </span>
                  {conversation.sessionId === null ? (
                    <span className="text-muted-foreground text-2xs">
                      {t('navigation.conversations.notStarted')}
                    </span>
                  ) : null}
                </div>
                <Button
                  size="sm"
                  variant="outline"
                  disabled={conversation.sessionId === null || pending !== null}
                  onClick={() => {
                    open(conversation);
                  }}
                >
                  {pending === conversation.id
                    ? t('navigation.conversations.opening')
                    : t('navigation.conversations.open')}
                </Button>
              </li>
            ))}
          </ul>
        )}
      </DialogContent>
    </Dialog>
  );
}
