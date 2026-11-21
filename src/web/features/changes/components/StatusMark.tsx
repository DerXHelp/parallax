import type { GitFileKind } from '@shared/model';
import { useT } from '@web/i18n';
import { cn } from '@web/lib/cn';

/** Letter and color per change kind (letters as in `git status --short`; the name is always there for screen readers). */
const MARK: Readonly<Record<GitFileKind, { letter: string; className: string }>> = {
  modified: { letter: 'M', className: 'text-info border-info/40 bg-info/10' },
  added: { letter: 'A', className: 'text-success border-success/40 bg-success/10' },
  untracked: { letter: 'U', className: 'text-success border-success/40 bg-success/10' },
  deleted: { letter: 'D', className: 'text-destructive border-destructive/40 bg-destructive/10' },
  renamed: { letter: 'R', className: 'text-warning border-warning/40 bg-warning/10' },
  copied: { letter: 'C', className: 'text-warning border-warning/40 bg-warning/10' },
  type_changed: { letter: 'T', className: 'text-muted-foreground border-border bg-muted' },
  conflicted: { letter: '!', className: 'text-destructive border-destructive/60 bg-destructive/15' },
};

/** The status symbol of a changed file: a letter in a small box, its name as tooltip and for screen readers. */
export function StatusMark({ kind, className }: { kind: GitFileKind; className?: string }) {
  const t = useT();
  const mark = MARK[kind];
  const name = t(`changes.kind.${kind}`);
  return (
    <span
      data-slot="changes-status"
      data-kind={kind}
      title={name}
      className={cn(
        'inline-flex size-4 shrink-0 items-center justify-center rounded-[3px] border font-mono text-2xs leading-none font-semibold',
        mark.className,
        className,
      )}
    >
      <span aria-hidden>{mark.letter}</span>
      <span className="sr-only">{name}</span>
    </span>
  );
}
