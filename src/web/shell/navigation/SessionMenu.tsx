import { EllipsisIcon } from 'lucide-react';
import { useMemo, useState } from 'react';
import type { SessionSummary } from '@shared/model';
import { useT } from '@web/i18n';
import { DropdownMenu, DropdownMenuContent, DropdownMenuTrigger } from '@web/ui/dropdown-menu';
import { IconButton } from '@web/ui/icon-button';
import {
  HEADER_ACTIONS,
  SessionActionItems,
  sessionActions,
  sessionMenuCloseAutoFocus,
} from './session-actions';

/**
 * "…" menu next to the session header (WP-35 §8): earlier conversations, session info, rename,
 * new window, external console, copy console command, sleep, archive. It sits next to – not in –
 * the `[data-slot="session-header"]` status line (ADR-042: the header itself stays a status display).
 */
export function SessionMenu({
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
  const actions = open ? sessionActions(HEADER_ACTIONS, sessionKey, summary, 'header') : [];
  const onCloseAutoFocus = useMemo(() => sessionMenuCloseAutoFocus(sessionKey, 'header'), [sessionKey]);
  return (
    <DropdownMenu open={open} onOpenChange={setOpen}>
      <DropdownMenuTrigger asChild>
        <IconButton label={t('navigation.actions.menu')} showTooltip={false} data-slot="session-menu">
          <EllipsisIcon aria-hidden />
        </IconButton>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="min-w-56" onCloseAutoFocus={onCloseAutoFocus}>
        <SessionActionItems actions={actions} kind="dropdown" />
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
