import { FolderIcon } from 'lucide-react';
import { memo } from 'react';
import { useT } from '@web/i18n';
import { pathTail } from '@web/lib/path-display';
import { useDisplayStatus, useSummary } from '@web/state/hooks';
import { Badge } from '@web/ui/badge';
import { StatusIcon } from '@web/ui/status-icon';
import { Tooltip, TooltipContent, TooltipTrigger } from '@web/ui/tooltip';

/**
 * Header line of a session pane: status (icon + text), title, badges and the facts the user
 * needs at a glance (folder, model, actual permission mode – C.3). Model/mode pickers and the
 * context gauge are WP-16's (composer). Reads its own summary (memo: the pane above does not
 * re-render on summary changes, R1W-04).
 */
export const SessionHeader = memo(function SessionHeader({ sessionKey }: { sessionKey: string }) {
  const t = useT();
  const summary = useSummary(sessionKey);
  const status = useDisplayStatus(sessionKey);
  if (summary === null) return null;
  const model = summary.model ?? summary.modelSetting;
  return (
    <header className="flex h-9 shrink-0 items-center gap-3 border-b px-3">
      {status === null ? null : <StatusIcon kind={status.kind} withTooltip />}
      <h1 className="min-w-0 truncate text-ui font-semibold">{summary.title}</h1>
      {status === null ? null : (
        // The status icon already carries the text for screen readers (V1-12).
        <span aria-hidden className="text-muted-foreground hidden shrink-0 text-xs md:inline">
          {t(`status.${status.kind}`)}
        </span>
      )}
      {status?.badges.compacting === true ? (
        <Badge variant="info">{t('shell.badges.compacting')}</Badge>
      ) : null}
      {status?.badges.retrying === true ? (
        <Badge variant="warning">{t('shell.badges.retrying')}</Badge>
      ) : null}
      {status !== null && status.badges.queued > 0 ? (
        <Badge variant="outline">{t('shell.badges.queued', { count: status.badges.queued })}</Badge>
      ) : null}
      {status?.badges.background === true && status.kind !== 'background' ? (
        <Badge variant="outline">{t('shell.badges.background')}</Badge>
      ) : null}
      <span className="flex-1" />
      <dl className="text-muted-foreground flex min-w-0 items-center gap-3 text-xs">
        <div className="flex min-w-0 items-center gap-1">
          <dt className="sr-only">{t('shell.session.cwd')}</dt>
          <dd className="flex min-w-0">
            <Tooltip>
              <TooltipTrigger asChild>
                {/* Shrinks with the pane (V1-04): the path never runs under the mode badge. */}
                <span className="flex max-w-full min-w-0 items-center gap-1 font-mono text-2xs">
                  <FolderIcon aria-hidden className="size-3 shrink-0" />
                  <span className="min-w-0 truncate">{pathTail(summary.cwd, 2)}</span>
                </span>
              </TooltipTrigger>
              <TooltipContent>
                <span className="font-mono break-all">{summary.cwd}</span>
              </TooltipContent>
            </Tooltip>
          </dd>
        </div>
        <div className="hidden min-w-0 items-center gap-1 lg:flex">
          <dt className="sr-only">{t('shell.session.model')}</dt>
          <dd className="truncate">{model ?? t('shell.session.modelDefault')}</dd>
        </div>
        {summary.permissionMode === null ? null : (
          <div className="flex shrink-0 items-center gap-1">
            <dt className="sr-only">{t('shell.session.permissionMode')}</dt>
            <dd>
              <Badge variant={summary.permissionMode === 'bypassPermissions' ? 'destructive' : 'outline'}>
                {t(`shell.permissionMode.${summary.permissionMode}`)}
              </Badge>
            </dd>
          </div>
        )}
      </dl>
    </header>
  );
});
