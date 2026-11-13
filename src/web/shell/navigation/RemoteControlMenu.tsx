import { useMemo, useState } from 'react';
import type { SessionSummary } from '@shared/model';
import { useT } from '@web/i18n';
import { sessionTitle } from '@web/lib/session-title';
import { Button } from '@web/ui/button';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@web/ui/dropdown-menu';
import { Tooltip, TooltipContent, TooltipTrigger } from '@web/ui/tooltip';
import { RemoteControlIcon, useRemoteControlTexts } from './remote-control';
import {
  SessionActionItems,
  sessionActions,
  sessionMenuCloseAutoFocus,
  type SessionActionSlot,
} from './session-actions';

/**
 * The actions of the header's Remote Control menu (the same ones are in the "…" menus); WP-70:
 * "Sign in" while the bridge failed for the sign-in (REMOTE_CONTROL_AUTH).
 */
export const REMOTE_ACTIONS: readonly SessionActionSlot[] = [
  'signIn',
  'remoteControl',
  'openRemote',
  'copyRemoteLink',
];

/**
 * WP-64: Remote Control in the session header – the phone icon in its state colour (tooltip: status
 * and the readable error) opens a small menu: status, error, on/off, "Open in the Claude app" (only
 * a claude.ai link), "Copy link". Shown while the bridge is live or wanted (`showsRemoteInHeader`).
 */
export function RemoteControlMenu({
  sessionKey,
  summary,
  defaultOpen = false,
}: {
  sessionKey: string;
  summary: SessionSummary;
  /** Playground screenshots. */
  defaultOpen?: boolean;
}) {
  const t = useT();
  const [open, setOpen] = useState(defaultOpen);
  const remote = summary.remoteControl;
  const { status, error } = useRemoteControlTexts(remote);
  const actions = open ? sessionActions(REMOTE_ACTIONS, sessionKey, summary, 'header') : [];
  const onCloseAutoFocus = useMemo(() => sessionMenuCloseAutoFocus(sessionKey, 'header'), [sessionKey]);
  return (
    <DropdownMenu open={open} onOpenChange={setOpen}>
      <Tooltip>
        <TooltipTrigger asChild>
          <DropdownMenuTrigger asChild>
            <Button
              variant="ghost"
              size="icon-sm"
              aria-label={error === null ? status : `${status} – ${error}`}
              data-slot="header-remote"
              data-remote-state={remote.state}
            >
              <RemoteControlIcon remote={remote} className="size-4" />
            </Button>
          </DropdownMenuTrigger>
        </TooltipTrigger>
        <TooltipContent>
          <span className="grid max-w-80 gap-0.5">
            <span>{status}</span>
            {error === null ? null : <span className="text-warning">{error}</span>}
          </span>
        </TooltipContent>
      </Tooltip>
      <DropdownMenuContent
        align="end"
        className="max-w-80 min-w-56"
        aria-label={t('navigation.remote.button', { title: sessionTitle(summary) })}
        onCloseAutoFocus={onCloseAutoFocus}
      >
        <DropdownMenuLabel data-slot="remote-status" className="font-normal">
          <span className="grid gap-0.5">
            <span>{status}</span>
            {error === null ? null : (
              <span data-slot="remote-error" className="text-warning text-xs">
                {error}
              </span>
            )}
          </span>
        </DropdownMenuLabel>
        <DropdownMenuSeparator />
        <SessionActionItems actions={actions} kind="dropdown" />
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
