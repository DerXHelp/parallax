import { CircleAlertIcon } from 'lucide-react';
import type { ProfileIssue } from '@shared/model';
import { useI18n } from '@web/i18n';
import { cn } from '@web/lib/cn';
import { ProfileIssueText } from '@web/shell/new-session/profile-status';
import type { DraftProblem } from '../lib/draft';

/**
 * Problems of the draft (found in the editor) and findings of the server check (`profile.validate`)
 * right below the field they are about; `id` is the field's `aria-describedby`.
 */
export function FieldNotes({
  id,
  problems = [],
  issues = [],
  className,
}: {
  id: string;
  problems?: readonly DraftProblem[];
  issues?: readonly ProfileIssue[];
  className?: string;
}) {
  const { t } = useI18n();
  if (problems.length === 0 && issues.length === 0) return null;
  return (
    <div id={id} data-slot="field-notes" className={cn('grid gap-0.5', className)}>
      {problems.map((problem, index) => (
        <span
          key={`${problem.key}-${String(index)}`}
          data-slot="draft-problem"
          className="text-destructive flex items-start gap-1.5 text-2xs"
        >
          <CircleAlertIcon aria-hidden className="mt-px size-3 shrink-0" />
          {t(problem.key, problem.params)}
        </span>
      ))}
      {issues.map((finding, index) => (
        <ProfileIssueText key={`${finding.issue.code}-${String(index)}`} finding={finding} />
      ))}
    </div>
  );
}
