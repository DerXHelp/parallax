import { ArrowDownIcon, ArrowUpIcon, GitBranchIcon, RefreshCwIcon } from 'lucide-react';
import { useId } from 'react';
import { GIT_DIFF_SCOPES, type GitDiffScope, type GitStatus } from '@shared/model';
import { useI18n } from '@web/i18n';
import { cn } from '@web/lib/cn';
import { IconButton } from '@web/ui/icon-button';
import { Label } from '@web/ui/label';
import { Switch } from '@web/ui/switch';
import { ToggleGroup, ToggleGroupItem } from '@web/ui/toggle-group';

/**
 * Head of the tab "Changes" (WP-113): branch (or the detached commit), upstream, ahead/behind and
 * "Refresh"; below the compared scope (Session · Uncommitted · Staged) and – without a worktree – the
 * filter "Only files of this session" with its hint (other sessions may write in the same folder).
 */

function isScope(value: string): value is GitDiffScope {
  return (GIT_DIFF_SCOPES as readonly string[]).includes(value);
}

export function shortSha(sha: string): string {
  return sha.slice(0, 7);
}

export function BranchLine({
  status,
  loading,
  onRefresh,
}: {
  status: GitStatus | null;
  loading: boolean;
  onRefresh: () => void;
}) {
  const { t } = useI18n();
  const head = status?.head ?? null;
  const detached =
    head === null ? t('changes.header.noCommit') : t('changes.header.detached', { sha: shortSha(head) });
  const branch = status === null ? null : (status.branch ?? detached);
  return (
    <div className="flex min-w-0 items-center gap-2 px-3 py-1.5" data-slot="changes-branch-line">
      <GitBranchIcon aria-hidden className="text-muted-foreground size-3.5 shrink-0" />
      <span className="sr-only">{t('changes.header.branch')}</span>
      <span
        className="min-w-0 truncate font-mono text-xs font-medium"
        data-slot="changes-branch"
        title={branch ?? undefined}
      >
        {branch}
      </span>
      {status?.isRepo === true ? (
        <span
          className="text-muted-foreground min-w-0 truncate font-mono text-2xs"
          data-slot="changes-upstream"
          title={
            status.upstream === null
              ? t('changes.header.noUpstream')
              : t('changes.header.upstream', { upstream: status.upstream })
          }
        >
          {status.upstream ?? t('changes.header.noUpstream')}
        </span>
      ) : null}
      {status?.isRepo === true && (status.ahead > 0 || status.behind > 0) ? (
        <span
          className="text-muted-foreground flex shrink-0 items-center gap-1.5 text-2xs tabular-nums"
          data-slot="changes-ahead-behind"
        >
          {status.ahead > 0 ? (
            <span
              className="inline-flex items-center"
              title={t('changes.header.ahead', { count: status.ahead })}
            >
              <ArrowUpIcon aria-hidden className="size-3" />
              <span aria-hidden>{status.ahead}</span>
              <span className="sr-only">{t('changes.header.ahead', { count: status.ahead })}</span>
            </span>
          ) : null}
          {status.behind > 0 ? (
            <span
              className="inline-flex items-center"
              title={t('changes.header.behind', { count: status.behind })}
            >
              <ArrowDownIcon aria-hidden className="size-3" />
              <span aria-hidden>{status.behind}</span>
              <span className="sr-only">{t('changes.header.behind', { count: status.behind })}</span>
            </span>
          ) : null}
        </span>
      ) : null}
      <span className="flex-1" />
      <IconButton
        label={t('changes.header.refresh')}
        data-action="changes-refresh"
        aria-busy={loading}
        onClick={onRefresh}
      >
        <RefreshCwIcon aria-hidden className={cn(loading && 'animate-spin motion-reduce:animate-none')} />
      </IconButton>
    </div>
  );
}

export function ScopeBar({
  scope,
  base,
  onScope,
  filter,
}: {
  scope: GitDiffScope;
  /** The commit the session scope starts at (`git.diff` → `base`). */
  base: string | null;
  onScope: (scope: GitDiffScope) => void;
  /** Without a worktree: the filter and its state; null = no filter (worktree session). */
  filter: { on: boolean; onChange: (on: boolean) => void } | null;
}) {
  const { t } = useI18n();
  const switchId = useId();
  return (
    <div className="grid gap-1.5 px-3 pb-2" data-slot="changes-scope-bar">
      <div className="flex min-w-0 flex-wrap items-center gap-2">
        <ToggleGroup
          type="single"
          variant="outline"
          size="sm"
          value={scope}
          aria-label={t('changes.scope.label')}
          onValueChange={(value) => {
            if (isScope(value)) onScope(value);
          }}
        >
          {GIT_DIFF_SCOPES.map((value) => (
            <ToggleGroupItem
              key={value}
              value={value}
              data-scope={value}
              title={t(`changes.scope.${value}Title`)}
              className="px-2 text-xs"
            >
              {t(`changes.scope.${value}`)}
            </ToggleGroupItem>
          ))}
        </ToggleGroup>
        {scope === 'session' && base !== null ? (
          <span
            className="text-muted-foreground font-mono text-2xs"
            data-slot="changes-base"
            title={t('changes.header.baseTitle', { sha: shortSha(base) })}
          >
            {t('changes.header.base', { sha: shortSha(base) })}
          </span>
        ) : null}
      </div>
      {filter === null ? null : (
        <div className="grid gap-0.5">
          <div className="flex items-center gap-2">
            <Switch
              id={switchId}
              checked={filter.on}
              aria-describedby={`${switchId}-hint`}
              onCheckedChange={filter.onChange}
            />
            <Label htmlFor={switchId} className="font-normal">
              {t('changes.filter.onlySession')}
            </Label>
          </div>
          <p id={`${switchId}-hint`} className="text-muted-foreground text-2xs">
            {filter.on ? t('changes.filter.onlySessionHint') : t('changes.filter.allHint')}
          </p>
        </div>
      )}
    </div>
  );
}
