import { EyeIcon, EyeOffIcon, PlusIcon, Trash2Icon } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import type { ProfileIssue } from '@shared/model';
import { useI18n } from '@web/i18n';
import { cn } from '@web/lib/cn';
import { Button } from '@web/ui/button';
import { IconButton } from '@web/ui/icon-button';
import { Input } from '@web/ui/input';
import { newRowId, problemsFor, type DraftProblem, type EnvRow } from '../lib/draft';
import { isSecretEnvKey } from '../lib/secrets';
import { FieldNotes } from './FieldNotes';

/**
 * Environment variables of a profile (Plan "Claude-Profile"): name/value rows. Values of secret
 * names (`*_KEY`, `*_TOKEN`, `*_SECRET`, `*PASSWORD*`) are masked (`type="password"`,
 * `autocomplete="new-password"` so the browser never fills in a saved password) until the eye
 * button reveals them – per row, in this window only. Values never leave the form except in
 * `profile.validate`/`profile.save`.
 */
export function EnvTable({
  rows,
  onChange,
  problems,
  issues,
  labelId,
  hintId,
}: {
  rows: readonly EnvRow[];
  onChange: (rows: EnvRow[]) => void;
  problems: readonly DraftProblem[];
  issues: ReadonlyMap<string, ProfileIssue[]>;
  labelId: string;
  hintId: string;
}) {
  const { t } = useI18n();
  const [revealed, setRevealed] = useState<ReadonlySet<string>>(() => new Set());
  const rootRef = useRef<HTMLDivElement>(null);
  const focusRow = useRef<string | null>(null);

  useEffect(() => {
    const id = focusRow.current;
    if (id === null) return;
    focusRow.current = null;
    rootRef.current?.querySelector<HTMLInputElement>(`[data-env-row="${id}"] input[data-part="key"]`)?.focus();
  }, [rows]);

  const update = (id: string, patch: Partial<EnvRow>) => {
    onChange(rows.map((row) => (row.id === id ? { ...row, ...patch } : row)));
  };

  const listProblems = problemsFor(problems, 'env');
  return (
    <div
      ref={rootRef}
      role="group"
      aria-labelledby={labelId}
      aria-describedby={hintId}
      data-slot="profile-env"
      className="grid gap-1.5"
    >
      {rows.length === 0 ? (
        <p className="text-muted-foreground text-2xs">{t('profiles.fields.envEmpty')}</p>
      ) : (
        <div className="grid gap-1">
          <div aria-hidden className="text-muted-foreground grid grid-cols-[minmax(0,2fr)_minmax(0,3fr)_1.5rem] gap-1.5 text-2xs">
            <span>{t('profiles.fields.envName')}</span>
            <span>{t('profiles.fields.envValue')}</span>
          </div>
          {rows.map((row, index) => {
            const number = index + 1;
            const secret = isSecretEnvKey(row.key);
            const masked = secret && !revealed.has(row.id);
            const rowProblems = problemsFor(problems, { envRow: row.id });
            const rowIssues = issues.get(row.id) ?? [];
            const notesId = `${row.id}-notes`;
            const described = rowProblems.length + rowIssues.length > 0 ? notesId : undefined;
            const hasError = rowProblems.length > 0 || rowIssues.some((finding) => finding.level === 'error');
            return (
              <div key={row.id} data-env-row={row.id} className="grid gap-0.5">
                <div className="grid grid-cols-[minmax(0,2fr)_minmax(0,3fr)_1.5rem] items-center gap-1.5">
                  <Input
                    data-part="key"
                    value={row.key}
                    spellCheck={false}
                    autoComplete="off"
                    aria-label={t('profiles.fields.envNameRow', { index: number })}
                    aria-invalid={hasError ? true : undefined}
                    aria-describedby={described}
                    className="font-mono text-xs"
                    onChange={(event) => {
                      update(row.id, { key: event.target.value });
                    }}
                  />
                  <div className="flex min-w-0 items-center gap-1">
                    <Input
                      data-part="value"
                      data-masked={masked ? 'true' : 'false'}
                      type={masked ? 'password' : 'text'}
                      value={row.value}
                      spellCheck={false}
                      autoComplete={secret ? 'new-password' : 'off'}
                      aria-label={t('profiles.fields.envValueRow', { index: number })}
                      aria-describedby={described}
                      className="font-mono text-xs"
                      onChange={(event) => {
                        update(row.id, { value: event.target.value });
                      }}
                    />
                    {secret ? (
                      <IconButton
                        label={t('profiles.fields.envShow', { index: number })}
                        aria-pressed={!masked}
                        data-action="env-reveal"
                        onClick={() => {
                          setRevealed((current) => {
                            const next = new Set(current);
                            if (next.has(row.id)) next.delete(row.id);
                            else next.add(row.id);
                            return next;
                          });
                        }}
                      >
                        {masked ? <EyeIcon aria-hidden /> : <EyeOffIcon aria-hidden />}
                      </IconButton>
                    ) : null}
                  </div>
                  <IconButton
                    label={t('profiles.fields.envRemove', { index: number })}
                    data-action="env-remove"
                    onClick={() => {
                      onChange(rows.filter((candidate) => candidate.id !== row.id));
                    }}
                  >
                    <Trash2Icon aria-hidden />
                  </IconButton>
                </div>
                <FieldNotes id={notesId} problems={rowProblems} issues={rowIssues} />
              </div>
            );
          })}
        </div>
      )}
      <FieldNotes id={`${labelId}-env-notes`} problems={listProblems} />
      <div>
        <Button
          variant="outline"
          size="sm"
          data-action="env-add"
          className={cn(rows.length === 0 && 'mt-0.5')}
          onClick={() => {
            const row: EnvRow = { id: newRowId(), key: '', value: '' };
            focusRow.current = row.id;
            onChange([...rows, row]);
          }}
        >
          <PlusIcon aria-hidden />
          {t('profiles.fields.envAdd')}
        </Button>
      </div>
    </div>
  );
}
