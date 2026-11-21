import { GitBranchIcon } from 'lucide-react';
import { useId, useState } from 'react';
import type { ErrorPayload } from '@shared/errors';
import { isValidGitRefName } from '@shared/model';
import { useI18n } from '@web/i18n';
import { errorPayloadOf } from '@web/state/connection';
import { Button } from '@web/ui/button';
import { Input } from '@web/ui/input';
import { Label } from '@web/ui/label';
import { Popover, PopoverContent, PopoverTrigger } from '@web/ui/popover';
import { createBranch, switchBranch } from '../state/git';
import { GitError } from './GitError';

/**
 * Branch menu of the git bar (WP-113, F4): a name, then "Create and switch", "Create only" or
 * "Switch to it" (`git.branchCreate {switch}` / `git.branchSwitch`). The name is checked like the
 * server does (`isValidGitRefName`); errors (BRANCH_EXISTS, a switch with conflicts) stay in the menu.
 */
export function BranchMenu({
  sessionKey,
  disabled,
  onDone,
}: {
  sessionKey: string;
  disabled: boolean;
  /** After a successful action: the message for the panel. */
  onDone: (message: string) => void;
}) {
  const { t } = useI18n();
  const inputId = useId();
  const [open, setOpen] = useState(false);
  const [name, setName] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<ErrorPayload | null>(null);
  const branch = name.trim();
  const valid = branch !== '' && isValidGitRefName(branch);
  const invalid = branch !== '' && !valid;

  const run = (action: 'createSwitch' | 'create' | 'switch') => {
    if (!valid || busy) return;
    setBusy(true);
    setError(null);
    const request =
      action === 'switch'
        ? switchBranch(sessionKey, branch)
        : createBranch(sessionKey, branch, action === 'createSwitch');
    request.then(
      () => {
        setBusy(false);
        setOpen(false);
        setName('');
        onDone(
          action === 'create'
            ? t('changes.branch.created', { branch })
            : t('changes.branch.switched', { branch }),
        );
      },
      (failure: unknown) => {
        setBusy(false);
        setError(errorPayloadOf(failure));
      },
    );
  };

  return (
    <Popover
      open={open}
      onOpenChange={(next) => {
        setOpen(next);
        if (!next) setError(null);
      }}
    >
      <PopoverTrigger asChild>
        <Button variant="outline" size="sm" disabled={disabled} data-action="branch-menu">
          <GitBranchIcon aria-hidden />
          {t('changes.branch.menu')}
        </Button>
      </PopoverTrigger>
      <PopoverContent align="start" className="grid w-80 gap-2" aria-label={t('changes.branch.title')}>
        <form
          className="grid gap-2"
          onSubmit={(event) => {
            event.preventDefault();
            run('createSwitch');
          }}
        >
          <Label htmlFor={inputId}>{t('changes.branch.name')}</Label>
          <Input
            id={inputId}
            autoFocus
            value={name}
            aria-invalid={invalid}
            aria-describedby={invalid ? `${inputId}-invalid` : undefined}
            className="font-mono"
            onChange={(event) => {
              setName(event.target.value);
            }}
          />
          {invalid ? (
            <p id={`${inputId}-invalid`} className="text-destructive text-2xs">
              {t('changes.branch.invalid')}
            </p>
          ) : null}
          <div className="flex flex-wrap gap-1.5">
            <Button type="submit" size="sm" disabled={!valid || busy} data-action="branch-create-switch">
              {t('changes.branch.createSwitch')}
            </Button>
            <Button
              variant="outline"
              size="sm"
              disabled={!valid || busy}
              data-action="branch-create"
              onClick={() => {
                run('create');
              }}
            >
              {t('changes.branch.create')}
            </Button>
            <Button
              variant="outline"
              size="sm"
              disabled={!valid || busy}
              data-action="branch-switch"
              onClick={() => {
                run('switch');
              }}
            >
              {t('changes.branch.switch')}
            </Button>
          </div>
        </form>
        {error === null ? null : (
          <GitError sessionKey={sessionKey} title={t('changes.branch.error')} error={error} />
        )}
      </PopoverContent>
    </Popover>
  );
}
