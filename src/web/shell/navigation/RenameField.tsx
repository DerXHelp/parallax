import { useEffect, useRef } from 'react';
import { LIMITS } from '@shared/common';
import type { SessionSummary } from '@shared/model';
import { useT } from '@web/i18n';
import { cn } from '@web/lib/cn';
import { sessionTitle } from '@web/lib/session-title';
import { Input } from '@web/ui/input';
import { finishRename } from './rename';
import { runSessionCommand } from './session-actions';

/**
 * The inline title field (sidebar row or header): Enter saves (`session.rename`; empty = `null`,
 * back to the automatic title), Esc cancels, leaving the field saves a changed non-empty title.
 * Unchanged titles send nothing.
 */
export function RenameField({
  sessionKey,
  summary,
  className,
}: {
  sessionKey: string;
  summary: Pick<SessionSummary, 'entryId' | 'title' | 'titleSource' | 'cwd'>;
  className?: string;
}) {
  const t = useT();
  const inputRef = useRef<HTMLInputElement>(null);
  const done = useRef(false);

  useEffect(() => {
    const input = inputRef.current;
    if (input === null) return;
    input.focus();
    input.select();
  }, []);

  const finish = (value: string | null, restoreFocus: boolean) => {
    if (done.current) return;
    done.current = true;
    finishRename(restoreFocus);
    if (value === null) return;
    const trimmed = value.trim();
    const title = trimmed === '' ? null : trimmed;
    const unchanged = title === null ? summary.titleSource !== 'custom' : title === summary.title.trim();
    if (unchanged) return;
    runSessionCommand(sessionKey, { name: 'session.rename', entryId: summary.entryId, title });
  };

  return (
    <Input
      ref={inputRef}
      data-slot="rename-field"
      defaultValue={summary.title}
      // What an empty title shows: the folder name (data, not a UI text; V2-05).
      placeholder={sessionTitle({ title: '', cwd: summary.cwd })}
      maxLength={LIMITS.titleChars}
      aria-label={t('navigation.rename.label')}
      title={t('navigation.rename.hint')}
      className={cn('h-6 px-1.5', className)}
      onKeyDown={(event) => {
        if (event.nativeEvent.isComposing) return;
        if (event.key === 'Enter') {
          event.preventDefault();
          finish(event.currentTarget.value, true);
        } else if (event.key === 'Escape') {
          // Not the Esc stack of the window (composer stop, dialogs).
          event.preventDefault();
          event.stopPropagation();
          finish(null, true);
        }
      }}
      onBlur={(event) => {
        const value = event.currentTarget.value;
        finish(value.trim() === '' ? null : value, false);
      }}
      onDoubleClick={(event) => {
        event.stopPropagation();
      }}
    />
  );
}
