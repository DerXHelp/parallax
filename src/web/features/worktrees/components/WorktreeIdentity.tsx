import { GitBranchIcon } from 'lucide-react';
import { useT } from '@web/i18n';
import { portRange } from '../lib/ports';

/**
 * The worktree of a session in short (notice, cleanup dialog): "Worktree <branch>", with a port block
 * also "ports 41000–41009" (`PARALLAX_WORKTREE_PORT`, ADR-251). Nothing without a branch.
 */
export function WorktreeIdentity({ branch, portBase }: { branch: string | null; portBase: number | null }) {
  const t = useT();
  if (branch === null) return null;
  const ports = portBase === null ? null : portRange(portBase);
  return (
    <span
      data-slot="worktree-identity"
      className="text-muted-foreground inline-flex min-w-0 items-center gap-1"
    >
      <GitBranchIcon aria-hidden className="size-3 shrink-0" />
      <span className="truncate font-mono">{t('worktrees.identity.branch', { branch })}</span>
      {ports === null ? null : (
        <>
          <span aria-hidden>·</span>
          <span className="shrink-0 font-mono">
            {t('worktrees.identity.ports', { from: String(ports.from), to: String(ports.to) })}
          </span>
        </>
      )}
    </span>
  );
}
