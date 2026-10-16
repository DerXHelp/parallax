import { useState } from 'react';
import { getSelectedSession } from '@web/state/selection';
import { selectSummary } from '@web/state/hooks';
import { clientStore } from '@web/state/store';
import { useShellRequestHandler } from '../requests';
import { useShortcut } from '../shortcuts';
import { ConversationsDialog } from './ConversationsDialog';
import { QuickSwitcher } from './QuickSwitcher';
import { renamePlaceFor, startRename } from './rename';
import { SessionInfoDialog } from './SessionInfoDialog';

function sessionExists(sessionKey: string): boolean {
  return selectSummary(clientStore.getState(), sessionKey) !== null;
}

/**
 * Window-wide navigation parts (mounted by the AppShell while the shell stands): the handlers of
 * the shell request channel `renameTitle`, `conversations`, `sessionInfo`, `quickSwitcher`
 * (WP-30 §4.14 C – e.g. `/rename`, `/resume`, `/status` of WP-37), the shortcuts Ctrl+K and F2
 * (ADR-118) and the dialogs they open.
 */
export function NavigationLayer() {
  const [switcher, setSwitcher] = useState(false);
  const [conversations, setConversations] = useState<string | null>(null);
  const [info, setInfo] = useState<string | null>(null);

  useShellRequestHandler('quickSwitcher', () => {
    setSwitcher(true);
    return true;
  });
  useShellRequestHandler('conversations', (request) => {
    if (!sessionExists(request.sessionKey)) return false;
    setConversations(request.sessionKey);
    return true;
  });
  useShellRequestHandler('sessionInfo', (request) => {
    if (!sessionExists(request.sessionKey)) return false;
    setInfo(request.sessionKey);
    return true;
  });
  useShellRequestHandler('renameTitle', (request) => {
    if (!sessionExists(request.sessionKey)) return false;
    startRename(request.sessionKey);
    return true;
  });

  useShortcut({
    id: 'navigation.quickSwitcher',
    keys: 'Mod+K',
    description: 'navigation.shortcuts.quickSwitcher',
    allowInInputs: true,
    run: () => {
      setSwitcher(true);
      return true;
    },
  });
  useShortcut({
    id: 'navigation.rename',
    keys: 'F2',
    description: 'navigation.shortcuts.rename',
    run: (event) => {
      // On a focused sidebar row: that row; otherwise the selected session (header first).
      const row = event.target instanceof Element ? event.target.closest('[data-session-row]') : null;
      const key = row?.getAttribute('data-session-row') ?? getSelectedSession();
      if (key === null || !sessionExists(key)) return false;
      startRename(key, row === null ? renamePlaceFor(key) : 'sidebar');
      return true;
    },
  });

  return (
    <>
      <QuickSwitcher open={switcher} onOpenChange={setSwitcher} />
      {conversations === null ? null : (
        <ConversationsDialog
          sessionKey={conversations}
          onClose={() => {
            setConversations(null);
          }}
        />
      )}
      {info === null ? null : (
        <SessionInfoDialog
          sessionKey={info}
          onClose={() => {
            setInfo(null);
          }}
        />
      )}
    </>
  );
}
