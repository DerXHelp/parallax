import { useEffect, useMemo, type ReactNode } from 'react';
import { LOCAL_HOST_ID, parseSessionKey } from '@shared/common';
import { makeError, type ErrorPayload } from '@shared/errors';
import { shellKindSchema, type ShellKind } from '@shared/model';
import { TERMINAL_CLOSE_CODES } from '@shared/terminal';
import { useI18n } from '@web/i18n';
import { effectiveShell } from '@web/lib/shells';
import { useSessionPaths } from '@web/state/host-platform';
import {
  clearTerminalTarget,
  useSessionShells,
  useTerminalTarget,
} from '@web/shell/navigation/session-actions';
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
 *
 * WP-105: the shells of the session's computer (`useSessionShells`: on Linux its `shell.detect` list); a
 * session of another computer connects through this server's relay (`env.socketUrl(hostId)`, E3); a
 * terminal requested by the shell (`useTerminalTarget`: the claude terminal of "Continue in terminal")
 * becomes active and takes the focus once it is in the list.
 */
export function TerminalPanel({ sessionKey }: { sessionKey: string }) {
  const tt = useTerminalT();
  const { tError } = useI18n();
  const env = useTerminalEnvironment();
  const parsed = parseSessionKey(sessionKey);
  const entryId = parsed?.entryId ?? null;
  const hostId = parsed?.hostId ?? LOCAL_HOST_ID;
  // WP-104: the shells of the session's computer; a setting it does not offer falls back to its default.
  const flavor = useSessionPaths(sessionKey).flavor;
  const shells = useSessionShells(sessionKey);
  const defaultShell = effectiveShell(useSettings().console.defaultShell, flavor, shells);
  const controller = useMemo(
    () =>
      entryId === null
        ? null
        : new TerminalController({
            sessionKey,
            entryId,
            url: env.socketUrl(hostId),
            createSocket: env.createSocket,
          }),
    [sessionKey, entryId, hostId, env],
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
  const target = useTerminalTarget(sessionKey);
  const targetListed =
    live && target !== null && state.items.some((item) => item.terminalId === target.terminalId);
  useEffect(() => {
    if (!targetListed) return;
    clearTerminalTarget(sessionKey, target.token);
    controller.select(target.terminalId);
    controller.focusActive();
  }, [targetListed, controller, target, sessionKey]);

  const open = (shell: ShellKind) => {
    controller?.open(shell);
  };
  /** WP-105: SHELL_NOT_FOUND names a missing Linux shell (the error text speaks of Git for Windows). */
  const errorText = (error: ErrorPayload): string => {
    const shell = shellKindSchema.safeParse(error.params.shell);
    if (error.code === 'SHELL_NOT_FOUND' && shell.success && shell.data !== 'gitbash') {
      return tt('panel.shellMissing', { shell: tt(SHELL_KEYS[shell.data]) });
    }
    return tError(error);
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
    body = (
      <TerminalTabs
        state={state}
        controller={controller}
        defaultShell={defaultShell}
        shells={shells}
        onOpen={open}
      />
    );
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
    body = <TerminalEmpty defaultShell={defaultShell} shells={shells} onOpen={open} />;
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
            title={errorText(state.error)}
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
