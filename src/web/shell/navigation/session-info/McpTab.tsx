import { PlugZapIcon, PowerIcon, PowerOffIcon } from 'lucide-react';
import { useState } from 'react';
import { parseSessionKey } from '@shared/common';
import type { ErrorPayload } from '@shared/errors';
import type { McpAction, SessionInfoOf } from '@shared/model';
import { useT, type TranslationKey } from '@web/i18n';
import { errorPayloadOf } from '@web/state/connection';
import { sendCommand } from '@web/state/hooks';
import { Badge, type BadgeProps } from '@web/ui/badge';
import { Button } from '@web/ui/button';
import { Spinner } from '@web/ui/spinner';
import { useInfoT } from './i18n';
import { InfoError, SectionFrame, TruncatedNote } from './SectionFrame';
import { useSessionInfo } from './use-session-info';

type Server = SessionInfoOf<'mcp'>['servers'][number];

/** Known MCP status words (start-chunk keys of the overview); anything newer stays raw. */
const STATUS_KEY: Readonly<Record<string, TranslationKey>> = {
  connected: 'navigation.info.mcpStatus.connected',
  failed: 'navigation.info.mcpStatus.failed',
  'needs-auth': 'navigation.info.mcpStatus.needsAuth',
  pending: 'navigation.info.mcpStatus.pending',
  disabled: 'navigation.info.mcpStatus.disabled',
};

const STATUS_VARIANT: Readonly<Record<string, BadgeProps['variant']>> = {
  connected: 'success',
  failed: 'destructive',
  'needs-auth': 'warning',
  pending: 'info',
  disabled: 'outline',
};

interface Outcome {
  server: string;
  action: McpAction;
  error: ErrorPayload | null;
}

/**
 * MCP tab (WP-67): every server of the running session with its status, scope, transport, tools
 * and error; "Reconnect", "Turn on" and "Turn off" (asks first) through `session.mcpAction`, then
 * the list again. The result of the last action shows above the list.
 */
export function McpTab({ sessionKey }: { sessionKey: string }) {
  const t = useT();
  const it = useInfoT();
  const query = useSessionInfo(sessionKey, 'mcp');
  const [running, setRunning] = useState<string | null>(null);
  const [confirming, setConfirming] = useState<string | null>(null);
  const [outcome, setOutcome] = useState<Outcome | null>(null);
  const entryId = parseSessionKey(sessionKey)?.entryId ?? null;

  const act = (server: string, action: McpAction): void => {
    if (entryId === null) return;
    setConfirming(null);
    setRunning(server);
    setOutcome(null);
    sendCommand(sessionKey, { name: 'session.mcpAction', entryId, server, action })
      .then(
        () => {
          setOutcome({ server, action, error: null });
          query.refresh();
        },
        (caught: unknown) => {
          setOutcome({ server, action, error: errorPayloadOf(caught) });
        },
      )
      .finally(() => {
        setRunning(null);
      });
  };

  const actions = (server: Server) => {
    const disabled = server.status === 'disabled';
    const busy = running !== null;
    if (confirming === server.name) {
      return (
        <div className="grid gap-1.5" data-slot="mcp-confirm-disable">
          <p className="text-xs">{it('mcp.confirmDisable', { name: server.name })}</p>
          <div className="flex gap-1.5">
            <Button
              size="sm"
              variant="destructive"
              data-action="mcp-confirm-disable"
              onClick={() => {
                act(server.name, 'disable');
              }}
            >
              {it('mcp.disable')}
            </Button>
            <Button
              size="sm"
              variant="ghost"
              autoFocus
              onClick={() => {
                setConfirming(null);
              }}
            >
              {it('mcp.cancel')}
            </Button>
          </div>
        </div>
      );
    }
    return (
      <div
        role="group"
        aria-label={it('mcp.actions', { name: server.name })}
        className="flex flex-wrap gap-1.5"
      >
        {running === server.name ? <Spinner aria-hidden className="self-center" /> : null}
        {disabled ? (
          <Button
            size="sm"
            variant="outline"
            data-action="mcp-enable"
            disabled={busy}
            onClick={() => {
              act(server.name, 'enable');
            }}
          >
            <PowerIcon aria-hidden />
            {it('mcp.enable')}
          </Button>
        ) : (
          <>
            <Button
              size="sm"
              variant="outline"
              data-action="mcp-reconnect"
              disabled={busy}
              onClick={() => {
                act(server.name, 'reconnect');
              }}
            >
              <PlugZapIcon aria-hidden />
              {it('mcp.reconnect')}
            </Button>
            <Button
              size="sm"
              variant="ghost"
              data-action="mcp-disable"
              disabled={busy}
              onClick={() => {
                setConfirming(server.name);
              }}
            >
              <PowerOffIcon aria-hidden />
              {it('mcp.disable')}
            </Button>
          </>
        )}
      </div>
    );
  };

  return (
    <SectionFrame query={query}>
      {(data) => (
        <div className="grid gap-3">
          {outcome === null ? null : outcome.error === null ? (
            <p role="status" className="text-success text-xs" data-slot="mcp-outcome">
              {it(`mcp.done.${outcome.action}`, { name: outcome.server })}
            </p>
          ) : (
            <InfoError title={it('mcp.failed', { name: outcome.server })} error={outcome.error} />
          )}
          {data.servers.length === 0 ? (
            <p className="text-muted-foreground text-xs">{it('mcp.empty')}</p>
          ) : null}
          <ul className="grid gap-2">
            {data.servers.map((server) => {
              const statusKey = STATUS_KEY[server.status];
              return (
                <li
                  key={server.name}
                  data-server={server.name}
                  data-status={server.status}
                  className="grid gap-1.5 rounded-md border px-3 py-2"
                >
                  <div className="flex min-w-0 flex-wrap items-center gap-2">
                    <span className="truncate font-mono text-xs font-medium">{server.name}</span>
                    <Badge variant={STATUS_VARIANT[server.status] ?? 'outline'}>
                      {statusKey === undefined ? server.status : t(statusKey)}
                    </Badge>
                    {server.serverVersion === null ? null : (
                      <span className="text-muted-foreground text-2xs">{server.serverVersion}</span>
                    )}
                  </div>
                  <div className="text-muted-foreground flex flex-wrap gap-x-3 text-2xs">
                    {server.scope === null ? null : <span>{it('mcp.scope', { scope: server.scope })}</span>}
                    {server.transport === null ? null : (
                      <span>{it('mcp.transport', { transport: server.transport })}</span>
                    )}
                    {server.tools.length === 0 ? null : (
                      <span title={server.tools.join(', ')}>
                        {it('mcp.tools', { count: server.tools.length })}
                      </span>
                    )}
                  </div>
                  {server.error === null ? null : (
                    <pre className="text-destructive bg-destructive/8 overflow-x-auto rounded-sm px-2 py-1 font-mono text-2xs whitespace-pre-wrap">
                      {server.error}
                    </pre>
                  )}
                  {actions(server)}
                </li>
              );
            })}
          </ul>
          <TruncatedNote truncated={data.truncated} />
        </div>
      )}
    </SectionFrame>
  );
}
