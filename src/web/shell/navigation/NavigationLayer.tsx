import { lazy, Suspense, useState, type ReactNode } from 'react';
import { LOCAL_HOST_ID } from '@shared/common';
import { getSelectedSession } from '@web/state/selection';
import { selectSummary } from '@web/state/hooks';
import { clientStore } from '@web/state/store';
import { useShellRequestHandler, type ShellRequestOf } from '../requests';
import { useShortcut } from '../shortcuts';
import { SlotBoundary } from '../SlotBoundary';
import { useQuickAsk } from './quick-ask';
import { QuickSwitcher } from './QuickSwitcher';
import { closeRemoveDialog, useRemoveDialog } from './remove-session';
import { renamePlaceFor, startRename } from './rename';

/*
 * The dialogs behind a menu entry open rarely: lazy chunks, not part of the start chunk (WP-63,
 * start-chunk budget `scripts/bundle-budget.ts`). The quick switcher stays eager (Ctrl+K, typed at
 * once).
 */
const ConversationsDialog = lazy(() =>
  import('./ConversationsDialog').then((module) => ({ default: module.ConversationsDialog })),
);
const SessionInfoDialog = lazy(() =>
  import('./SessionInfoDialog').then((module) => ({ default: module.SessionInfoDialog })),
);
const RemoveSessionDialog = lazy(() =>
  import('./RemoveSessionDialog').then((module) => ({ default: module.RemoveSessionDialog })),
);
const ArchiveCleanupDialog = lazy(() =>
  import('./ArchiveCleanupDialog').then((module) => ({ default: module.ArchiveCleanupDialog })),
);
/** WP-66: the popover of "Quick question…" (a side question from the sidebar). */
const QuickAskPopover = lazy(() =>
  import('./QuickAskPopover').then((module) => ({ default: module.QuickAskPopover })),
);

/** WP-70: the sign-in dialog of a profile and the output style of a session's project. */
const LoginDialog = lazy(() =>
  import('../login/LoginDialog').then((module) => ({ default: module.LoginDialog })),
);
const OutputStyleDialog = lazy(() =>
  import('../output-style/OutputStyleDialog').then((module) => ({ default: module.OutputStyleDialog })),
);

/**
 * A lazy dialog: like the settings page it appears whole once its chunk is there (no fallback; the
 * opener keeps the focus until then, so the dialog still returns it on close). A failed chunk shows
 * the card of the SlotBoundary on top of the window instead of unmounting the app; a new request
 * (`resetKey`) tries again.
 */
function LazyDialog({ resetKey, children }: { resetKey: unknown; children: ReactNode }) {
  return (
    <SlotBoundary resetKey={resetKey} className="fixed inset-x-0 top-16 z-50">
      <Suspense fallback={null}>{children}</Suspense>
    </SlotBoundary>
  );
}

function sessionExists(sessionKey: string): boolean {
  return selectSummary(clientStore.getState(), sessionKey) !== null;
}

/**
 * Window-wide navigation parts (mounted by the AppShell while the shell stands): the handlers of
 * the shell request channel `renameTitle`, `conversations`, `sessionInfo`, `quickSwitcher`
 * (WP-30 §4.14 C – e.g. `/rename`, `/resume`, `/status` of WP-37), the shortcuts Ctrl+K and F2
 * (ADR-118) and the dialogs they open. WP-63: "Remove from Parallax…" and "Clean up archive…"
 * (`remove-session.ts`); WP-66: the popover of "Quick question…" (`quick-ask.ts`); WP-70: `login`
 * (sign in a profile, one dialog at a time – a new request mounts it anew and starts again) and
 * `outputStyle`; every dialog except the quick switcher is a lazy chunk.
 */
export function NavigationLayer() {
  const [switcher, setSwitcher] = useState(false);
  const [conversations, setConversations] = useState<string | null>(null);
  const [info, setInfo] = useState<string | null>(null);
  const removeDialog = useRemoveDialog();
  const quickAsk = useQuickAsk();
  const [login, setLogin] = useState<{ request: ShellRequestOf<'login'>; n: number } | null>(null);
  const [outputStyle, setOutputStyle] = useState<string | null>(null);

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
  useShellRequestHandler('login', (request) => {
    setLogin((current) => ({ request, n: (current?.n ?? 0) + 1 }));
    return true;
  });
  useShellRequestHandler('outputStyle', (request) => {
    if (!sessionExists(request.sessionKey)) return false;
    setOutputStyle(request.sessionKey);
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
        <LazyDialog resetKey={conversations}>
          <ConversationsDialog
            sessionKey={conversations}
            onClose={() => {
              setConversations(null);
            }}
          />
        </LazyDialog>
      )}
      {info === null ? null : (
        <LazyDialog resetKey={info}>
          <SessionInfoDialog
            sessionKey={info}
            onClose={() => {
              setInfo(null);
            }}
          />
        </LazyDialog>
      )}
      {removeDialog === null ? null : (
        <LazyDialog resetKey={removeDialog}>
          {removeDialog.kind === 'session' ? (
            <RemoveSessionDialog
              key={removeDialog.sessionKey}
              sessionKey={removeDialog.sessionKey}
              onClose={closeRemoveDialog}
            />
          ) : (
            <ArchiveCleanupDialog onClose={closeRemoveDialog} />
          )}
        </LazyDialog>
      )}
      {login === null ? null : (
        <LazyDialog resetKey={login.n}>
          <LoginDialog
            key={login.n}
            hostId={login.request.hostId ?? LOCAL_HOST_ID}
            profileId={login.request.profileId}
            modal={login.request.modal === true}
            onClose={() => {
              setLogin(null);
            }}
          />
        </LazyDialog>
      )}
      {outputStyle === null ? null : (
        <LazyDialog resetKey={outputStyle}>
          <OutputStyleDialog
            sessionKey={outputStyle}
            onClose={() => {
              setOutputStyle(null);
            }}
          />
        </LazyDialog>
      )}
      {quickAsk === null || !sessionExists(quickAsk.sessionKey) ? null : (
        <LazyDialog resetKey={quickAsk.request}>
          <QuickAskPopover key={quickAsk.request} sessionKey={quickAsk.sessionKey} />
        </LazyDialog>
      )}
    </>
  );
}
