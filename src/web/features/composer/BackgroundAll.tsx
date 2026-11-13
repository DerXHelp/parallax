import { ArrowDownToLineIcon } from 'lucide-react';
import { useMemo, useState, type RefObject } from 'react';
import { parseSessionKey } from '@shared/common';
import type { TranscriptItem } from '@shared/model';
import type { SessionViewState } from '@shared/sync';
import { useT } from '@web/i18n';
import { useShortcut } from '@web/shell/shortcuts';
import { errorPayloadOf } from '@web/state/connection';
import { sendCommand, useSessionSelector } from '@web/state/hooks';
import { showErrorNotice } from '@web/state/notices';
import { Button } from '@web/ui/button';

/** Tools `session.backgroundTasks` moves: a foreground Bash call or subagent (WP-65 §1.5). */
const MOVABLE: ReadonlySet<string> = new Set(['Bash', 'Agent', 'Task']);

const movableCache = new WeakMap<readonly TranscriptItem[], boolean>();

/** A Bash call or subagent runs in the foreground (cached per items array). */
export function selectHasMovableTask(view: SessionViewState): boolean {
  const cached = movableCache.get(view.items);
  if (cached !== undefined) return cached;
  const found = view.items.some(
    (item) => item.kind === 'tool_call' && item.status === 'running' && MOVABLE.has(item.toolName),
  );
  movableCache.set(view.items, found);
  return found;
}

/**
 * WP-65 §1.5: "Move all to background" next to Stop – only while a Bash call or subagent runs in
 * the foreground – and its shortcut Ctrl+B: only with the focus in this session's pane (transcript
 * or composer); Ctrl+B has no meaning in the plain message field (no rich text, no Markdown
 * shortcuts) and none in Chrome on Windows (the bookmarks bar is Ctrl+Shift+B). A refusal shows as
 * a notice.
 */
export function BackgroundAll({
  sessionKey,
  composerRef,
  online,
}: {
  sessionKey: string;
  /** The composer's root: the shortcut's scope is the pane around it. */
  composerRef: RefObject<HTMLElement | null>;
  online: boolean;
}) {
  const t = useT();
  const movable = useSessionSelector(sessionKey, selectHasMovableTask, false);
  const [busy, setBusy] = useState(false);
  const paneRef = useMemo<RefObject<HTMLElement | null>>(
    () => ({
      get current() {
        return composerRef.current?.closest<HTMLElement>('section[data-session-key]') ?? null;
      },
    }),
    [composerRef],
  );
  const run = () => {
    const parsed = parseSessionKey(sessionKey);
    if (parsed === null || busy) return;
    setBusy(true);
    sendCommand(sessionKey, { name: 'session.backgroundTasks', entryId: parsed.entryId, toolUseId: null })
      .catch((error: unknown) => {
        showErrorNotice(errorPayloadOf(error), { sessionKey, id: `composer-background-${sessionKey}` });
      })
      .finally(() => {
        setBusy(false);
      });
  };
  useShortcut(
    {
      id: 'composer.backgroundAll',
      keys: 'Mod+B',
      description: 'composer.backgroundAllShortcut',
      allowInInputs: true,
      scopeRef: paneRef,
      run: () => {
        if (!online) return false;
        run();
        return true;
      },
    },
    movable,
  );
  if (!movable) return null;
  return (
    <Button
      variant="outline"
      size="sm"
      data-action="background-all"
      title={t('composer.backgroundAllHint')}
      disabled={!online || busy}
      onClick={run}
    >
      <ArrowDownToLineIcon aria-hidden />
      {t('composer.backgroundAll')}
    </Button>
  );
}
