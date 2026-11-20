import { useEffect, useMemo, type ReactNode } from 'react';
import { parseSessionKey } from '@shared/common';
import { makeError } from '@shared/errors';
import type { ShellKind } from '@shared/model';
import { TERMINAL_CLOSE_CODES } from '@shared/terminal';
import { useI18n } from '@web/i18n';
import { useSettings } from '@web/state/settings';
import { Alert } from '@web/ui/alert';
import { Button } from '@web/ui/button';
import { Spinner } from '@web/ui/spinner';
import { TerminalEmpty } from './components/TerminalEmpty';
import { TerminalTabs } from './components/TerminalTabs';
import { useTerminalT } from './i18n';
import { SHELL_KEYS } from './lib/shells';
import { TerminalController } from './state/controller';
import { useTerminalEnvironment } from './state/environment';
import { useTerminalSession } from './state/terminals';

/**
 * Side panel tab "Terminal" (WP-99, ADR-239; slot `TerminalPanel`, lazy chunk of `index.ts`): shells
 * in the session's folder, in a pseudo console of this computer. One socket per mounted panel; on the
 * first connect without terminals it opens one with the default shell of the settings, after the
 * user closed all of them it shows one button per shell. Server errors show inline (translated
 * code), `available: false` the hint `TERMINAL_UNAVAILABLE`. Root `data-slot="terminal-panel"`.
 */
export function TerminalPanel({ sessionKey }: { sessionKey: string }) {
  const tt = useTerminalT();
  const { tError } = useI18n();
  const env = useTerminalEnvironment();
  const entryId = parseSessionKey(sessionKey)?.entryId ?? null;
  const defaultShell = useSettings().console.defaultShell;
  const controller = useMemo(
    () =>
      entryId === null
        ? null
        : new TerminalController({
            sessionKey,
            entryId,
            url: env.socketUrl(),
            createSocket: env.createSocket,
          }),
    [sessionKey, entryId, env],
  );
  useEffect(() => {
    controller?.setDefaultShell(defaultShell);
  }, [controller, defaultShell]);
  useEffect(() => {
    if (controller === null) return undefined;
    controller.start();
    return () => {
      controller.stop();
    };
  }, [controller]);
  const state = useTerminalSession(sessionKey);
  // Until this mount's controller started, the store may still describe an earlier mount.
  const live = controller !== null && state.owner === controller.id;

  const open = (shell: ShellKind) => {
    controller?.open(shell);
  };
  const firstPending = state.pending[0];

  let body: ReactNode = null;
  if (!live) {
    body = null;
  } else if (state.failure !== null) {
    body = (
      <div className="p-3">
        <Alert
          tone="error"
          data-slot="terminal-failed"
          title={
            state.failure === TERMINAL_CLOSE_CODES.protocol ? tt('panel.protocol') : tt('panel.entryNotFound')
          }
        />
      </div>
    );
  } else if (state.available === false) {
    body = (
      <div className="p-3">
        <Alert
          tone="warning"
          data-slot="terminal-unavailable"
          title={tError(state.unavailable ?? makeError('TERMINAL_UNAVAILABLE', { reason: 'unknown' }))}
        />
      </div>
    );
  } else if (state.available === null) {
    body = (
      <div
        data-slot="terminal-connecting"
        className="text-muted-foreground flex flex-1 items-center justify-center gap-2 p-6 text-xs"
      >
        <Spinner label={tt('panel.connecting')} />
        {tt('panel.connecting')}
      </div>
    );
  } else if (state.items.length > 0) {
    body = <TerminalTabs state={state} controller={controller} defaultShell={defaultShell} onOpen={open} />;
  } else if (firstPending !== undefined) {
    const shell = tt(SHELL_KEYS[firstPending.shell]);
    body = (
      <div
        data-slot="terminal-starting"
        className="text-muted-foreground flex flex-1 items-center justify-center gap-2 p-6 text-xs"
      >
        <Spinner label={tt('panel.starting', { shell })} />
        {tt('panel.starting', { shell })}
      </div>
    );
  } else if (state.loaded) {
    body = <TerminalEmpty defaultShell={defaultShell} onOpen={open} />;
  }

  return (
    <section
      data-slot="terminal-panel"
      aria-label={tt('panel.label')}
      className="flex h-full min-h-0 flex-1 flex-col"
    >
      {live && state.connection === 'reconnecting' ? (
        <p
          role="status"
          data-slot="terminal-reconnecting"
          className="text-muted-foreground shrink-0 border-b px-3 py-1 text-xs"
        >
          {tt('panel.reconnecting')}
        </p>
      ) : null}
      {!live || state.error === null ? null : (
        <div className="shrink-0 border-b p-2">
          <Alert
            tone="error"
            data-slot="terminal-error"
            title={tError(state.error)}
            actions={
              <Button
                size="sm"
                variant="outline"
                onClick={() => {
                  controller.dismissError();
                }}
              >
                {tt('panel.dismiss')}
              </Button>
            }
          />
        </div>
      )}
      {body}
    </section>
  );
}

export default TerminalPanel;
