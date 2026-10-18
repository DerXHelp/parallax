import { PlusIcon, ShieldOffIcon, Trash2Icon } from 'lucide-react';
import { useEffect, useRef, type ClipboardEvent, type KeyboardEvent } from 'react';
import type { ProfileIssue } from '@shared/model';
import { useI18n } from '@web/i18n';
import { cn } from '@web/lib/cn';
import { Badge } from '@web/ui/badge';
import { Button } from '@web/ui/button';
import { IconButton } from '@web/ui/icon-button';
import { Input } from '@web/ui/input';
import { isBypassArg, newRowId, problemsFor, splitLines, type ArgRow, type DraftProblem } from '../lib/draft';
import { FieldNotes } from './FieldNotes';

/** Focus target "the add button" (the last line was removed). */
const ADD_BUTTON = '__add__';

/**
 * Additional CLI arguments, one per line (C.12: no quoting): a numbered input per line with the
 * findings of its line (`params.index`) right below it. Enter adds a line after the current one,
 * Backspace in an empty line removes it, pasting several lines splits them. Bypass flags are red
 * with a "Bypass" badge (never color only).
 */
export function ArgList({
  rows,
  onChange,
  problems,
  issues,
  labelId,
  hintId,
}: {
  rows: readonly ArgRow[];
  onChange: (rows: ArgRow[]) => void;
  problems: readonly DraftProblem[];
  issues: ReadonlyMap<string, ProfileIssue[]>;
  labelId: string;
  hintId: string;
}) {
  const { t } = useI18n();
  const rootRef = useRef<HTMLDivElement>(null);
  const focusRow = useRef<{ id: string; caret: 'start' | 'end' } | null>(null);

  useEffect(() => {
    const target = focusRow.current;
    if (target === null) return;
    focusRow.current = null;
    if (target.id === ADD_BUTTON) {
      rootRef.current?.querySelector<HTMLButtonElement>('[data-action="arg-add"]')?.focus();
      return;
    }
    const input = rootRef.current?.querySelector<HTMLInputElement>(`[data-arg-row="${target.id}"] input`);
    if (input === null || input === undefined) return;
    input.focus();
    const at = target.caret === 'start' ? 0 : input.value.length;
    input.setSelectionRange(at, at);
  }, [rows]);

  const insertAfter = (index: number, values: readonly string[], replaceCurrent?: string) => {
    const next = [...rows];
    const current = next[index];
    if (current !== undefined && replaceCurrent !== undefined) next[index] = { ...current, value: replaceCurrent };
    const added = values.map((value) => ({ id: newRowId(), value }));
    next.splice(index + 1, 0, ...added);
    const last = added.at(-1);
    if (last !== undefined) focusRow.current = { id: last.id, caret: replaceCurrent === undefined ? 'start' : 'end' };
    onChange(next);
  };

  const onKeyDown = (event: KeyboardEvent<HTMLInputElement>, index: number, row: ArgRow) => {
    if (event.nativeEvent.isComposing) return;
    if (event.key === 'Enter') {
      event.preventDefault();
      insertAfter(index, ['']);
      return;
    }
    if (event.key === 'Backspace' && row.value === '') {
      event.preventDefault();
      const neighbour = rows[index - 1] ?? rows[index + 1];
      focusRow.current = { id: neighbour?.id ?? ADD_BUTTON, caret: 'end' };
      onChange(rows.filter((candidate) => candidate.id !== row.id));
    }
  };

  const onPaste = (event: ClipboardEvent<HTMLInputElement>, index: number, row: ArgRow) => {
    const lines = splitLines(event.clipboardData.getData('text'));
    if (lines.length < 2) return;
    event.preventDefault();
    const input = event.currentTarget;
    const start = input.selectionStart ?? row.value.length;
    const end = input.selectionEnd ?? start;
    const first = `${row.value.slice(0, start)}${lines[0] ?? ''}`;
    const rest = lines.slice(1);
    const lastIndex = rest.length - 1;
    rest[lastIndex] = `${rest[lastIndex] ?? ''}${row.value.slice(end)}`;
    insertAfter(index, rest, first);
  };

  const listProblems = problemsFor(problems, 'args');
  return (
    <div
      ref={rootRef}
      role="group"
      aria-labelledby={labelId}
      aria-describedby={hintId}
      data-slot="profile-args"
      className="grid gap-1.5"
    >
      {rows.length === 0 ? (
        <p className="text-muted-foreground text-2xs">{t('profiles.fields.argsEmpty')}</p>
      ) : (
        <ol className="grid gap-1">
          {rows.map((row, index) => {
            const number = index + 1;
            const rowProblems = problemsFor(problems, { argRow: row.id });
            const rowIssues = issues.get(row.id) ?? [];
            const bypass =
              isBypassArg(row.value) || rowIssues.some((finding) => finding.issue.code === 'PROFILE_BYPASS_ENABLED');
            const hasError = rowProblems.length > 0 || rowIssues.some((finding) => finding.level === 'error');
            const notesId = `${row.id}-notes`;
            return (
              <li
                key={row.id}
                data-arg-row={row.id}
                data-bypass={bypass ? 'true' : undefined}
                data-invalid={hasError ? 'true' : undefined}
                className="grid gap-0.5"
              >
                <div className="grid grid-cols-[1.5rem_minmax(0,1fr)_auto_1.5rem] items-center gap-1.5">
                  <span aria-hidden className="text-muted-foreground text-right font-mono text-2xs tabular-nums">
                    {number}
                  </span>
                  <Input
                    value={row.value}
                    spellCheck={false}
                    autoComplete="off"
                    aria-label={t('profiles.fields.argRow', { index: number })}
                    aria-invalid={hasError ? true : undefined}
                    aria-describedby={rowProblems.length + rowIssues.length > 0 ? notesId : undefined}
                    className={cn(
                      'font-mono text-xs',
                      bypass && 'border-destructive text-destructive focus-visible:ring-destructive/40',
                    )}
                    onChange={(event) => {
                      onChange(rows.map((candidate) => (candidate.id === row.id ? { ...row, value: event.target.value } : candidate)));
                    }}
                    onKeyDown={(event) => {
                      onKeyDown(event, index, row);
                    }}
                    onPaste={(event) => {
                      onPaste(event, index, row);
                    }}
                  />
                  {bypass ? (
                    <Badge variant="destructive">
                      <ShieldOffIcon aria-hidden />
                      {t('profiles.fields.argBypass')}
                    </Badge>
                  ) : (
                    <span />
                  )}
                  <IconButton
                    label={t('profiles.fields.argRemove', { index: number })}
                    data-action="arg-remove"
                    onClick={() => {
                      onChange(rows.filter((candidate) => candidate.id !== row.id));
                    }}
                  >
                    <Trash2Icon aria-hidden />
                  </IconButton>
                </div>
                <FieldNotes id={notesId} problems={rowProblems} issues={rowIssues} className="pl-7" />
              </li>
            );
          })}
        </ol>
      )}
      <FieldNotes id={`${labelId}-args-notes`} problems={listProblems} />
      <div>
        <Button
          variant="outline"
          size="sm"
          data-action="arg-add"
          onClick={() => {
            const row: ArgRow = { id: newRowId(), value: '' };
            focusRow.current = { id: row.id, caret: 'start' };
            onChange([...rows, row]);
          }}
        >
          <PlusIcon aria-hidden />
          {t('profiles.fields.argAdd')}
        </Button>
      </div>
    </div>
  );
}
