import { GitBranchIcon } from 'lucide-react';
import { useId } from 'react';
import type { PathRules } from '@shared/paths';
import { useT } from '@web/i18n';
import { pathTail, shortPath } from '@web/lib/path-display';
import { Input } from '@web/ui/input';
import { Label } from '@web/ui/label';
import { RadioGroup, RadioGroupItem } from '@web/ui/radio-group';
import { Switch } from '@web/ui/switch';
import type { WorktreeChoice } from './use-worktree-choice';
import type { WorktreeMode } from './worktree-lib';

/** The folder Parallax creates a new worktree in (like `claude --worktree`, ADR-250). */
export function newWorktreeFolder(repoRoot: string, branch: string, rules: PathRules): string {
  return rules.join(
    rules.join(rules.join(repoRoot, '.claude'), 'worktrees'),
    branch.trim().replaceAll('/', '-'),
  );
}

const MODES: readonly WorktreeMode[] = ['new', 'existing'];

function isMode(value: string): value is WorktreeMode {
  return MODES.some((mode) => mode === value);
}

/**
 * The worktree part of "New session" (WP-114, ADR-250): nothing until the folder is known to be in
 * a git repository, then one quiet switch "In its own worktree". Switched on: a new branch (name
 * suggested, base = the main worktree's branch, both checked like git does) or – when the repository
 * has other worktrees – one of them. Server refusals (BRANCH_EXISTS …) show in the form's alert.
 */
export function WorktreeFields({
  choice,
  rules,
  disabled = false,
  invalidBranch = false,
  onEdit,
}: {
  choice: WorktreeChoice;
  rules: PathRules;
  disabled?: boolean;
  /** The server refused the branch or folder (BRANCH_EXISTS, WORKTREE_EXISTS). */
  invalidBranch?: boolean;
  /** Any change (the form clears its error). */
  onEdit?: () => void;
}) {
  const t = useT();
  const switchId = useId();
  const hintId = useId();
  const modeLabelId = useId();
  const branchId = useId();
  const branchHintId = useId();
  const baseId = useId();
  const baseHintId = useId();
  const existingLabelId = useId();
  const { repoRoot } = choice;
  if (repoRoot === null) return null;
  const branchProblem = choice.branchIssue;
  const showExisting = choice.pickable.length > 0;
  return (
    <div
      data-slot="new-session-worktree"
      data-on={choice.on ? 'true' : 'false'}
      className="grid grid-cols-[minmax(0,1fr)] gap-2"
    >
      <div className="flex items-start gap-2">
        <Switch
          id={switchId}
          checked={choice.on}
          disabled={disabled}
          aria-describedby={hintId}
          onCheckedChange={(on) => {
            choice.setOn(on);
            onEdit?.();
          }}
          className="mt-0.5"
        />
        <div className="grid min-w-0 gap-0.5">
          <Label htmlFor={switchId} className="font-normal">
            {t('newSession.worktree.toggle')}
          </Label>
          <p id={hintId} className="text-muted-foreground text-2xs">
            {t('newSession.worktree.toggleHint', { repo: pathTail(repoRoot, 1) })}
          </p>
        </div>
      </div>
      {choice.on ? (
        <div className="border-border ml-9 grid grid-cols-[minmax(0,1fr)] gap-2.5 border-l pl-3">
          {showExisting ? (
            <RadioGroup
              aria-label={t('newSession.worktree.modeLabel')}
              value={choice.mode}
              onValueChange={(value) => {
                if (!isMode(value)) return;
                choice.setMode(value);
                onEdit?.();
              }}
              className="flex flex-wrap gap-x-4 gap-y-1"
              disabled={disabled}
            >
              {MODES.map((mode) => (
                <div key={mode} className="flex items-center gap-1.5">
                  <RadioGroupItem id={`${modeLabelId}-${mode}`} value={mode} />
                  <Label htmlFor={`${modeLabelId}-${mode}`} className="font-normal">
                    {t(`newSession.worktree.modes.${mode}`)}
                  </Label>
                </div>
              ))}
            </RadioGroup>
          ) : null}
          {choice.mode === 'new' ? (
            <>
              <div className="grid grid-cols-[minmax(0,3fr)_minmax(0,2fr)] gap-2">
                <div className="grid min-w-0 gap-1">
                  <Label htmlFor={branchId}>{t('newSession.worktree.branch')}</Label>
                  <Input
                    id={branchId}
                    name="worktreeBranch"
                    value={choice.branch}
                    disabled={disabled}
                    spellCheck={false}
                    autoComplete="off"
                    aria-invalid={branchProblem !== null || invalidBranch ? true : undefined}
                    aria-describedby={branchHintId}
                    className="font-mono text-xs"
                    onChange={(event) => {
                      choice.setBranch(event.target.value);
                      onEdit?.();
                    }}
                  />
                </div>
                <div className="grid min-w-0 gap-1">
                  <Label htmlFor={baseId}>{t('newSession.worktree.base')}</Label>
                  <Input
                    id={baseId}
                    name="worktreeBase"
                    value={choice.base}
                    disabled={disabled}
                    spellCheck={false}
                    autoComplete="off"
                    placeholder={t('newSession.worktree.basePlaceholder')}
                    aria-invalid={choice.baseIssue === null ? undefined : true}
                    aria-describedby={baseHintId}
                    className="font-mono text-xs"
                    onChange={(event) => {
                      choice.setBase(event.target.value);
                      onEdit?.();
                    }}
                  />
                </div>
              </div>
              <div className="grid grid-cols-[minmax(0,1fr)] gap-0.5">
                {branchProblem === null ? (
                  <p
                    id={branchHintId}
                    className="text-muted-foreground truncate text-2xs"
                    data-slot="worktree-folder"
                  >
                    {t('newSession.worktree.folder', {
                      folder: shortPath(newWorktreeFolder(repoRoot, choice.branch, rules), 4),
                    })}
                  </p>
                ) : (
                  <p id={branchHintId} role="alert" className="text-destructive text-2xs">
                    {t(`newSession.worktree.branchIssues.${branchProblem}`)}
                  </p>
                )}
                {choice.baseIssue === null ? (
                  <p id={baseHintId} className="text-muted-foreground text-2xs">
                    {t('newSession.worktree.baseHint')}
                  </p>
                ) : (
                  <p id={baseHintId} role="alert" className="text-destructive text-2xs">
                    {t('newSession.worktree.baseInvalid')}
                  </p>
                )}
              </div>
            </>
          ) : (
            <div className="grid grid-cols-[minmax(0,1fr)] gap-1">
              <span id={existingLabelId} className="text-xs font-medium">
                {t('newSession.worktree.existing')}
              </span>
              <RadioGroup
                aria-labelledby={existingLabelId}
                value={choice.path ?? ''}
                disabled={disabled}
                onValueChange={(path) => {
                  choice.setPath(path);
                  onEdit?.();
                }}
                data-slot="worktree-existing"
                className="grid max-h-32 grid-cols-[minmax(0,1fr)] gap-0.5 overflow-y-auto rounded-md border p-1"
              >
                {choice.pickable.map((worktree, index) => {
                  const itemId = `${existingLabelId}-${String(index)}`;
                  return (
                    <div key={worktree.path} className="flex min-w-0 items-center gap-2 px-1 py-0.5">
                      <RadioGroupItem id={itemId} value={worktree.path} />
                      <Label htmlFor={itemId} title={worktree.path} className="min-w-0 font-normal">
                        <GitBranchIcon aria-hidden className="text-muted-foreground size-3.5 shrink-0" />
                        <span className="truncate font-mono text-xs">
                          {t('newSession.worktree.existingItem', {
                            branch: worktree.branch ?? '',
                            folder: pathTail(worktree.path, 1),
                          })}
                        </span>
                      </Label>
                    </div>
                  );
                })}
              </RadioGroup>
              {choice.path === null ? (
                <p className="text-muted-foreground text-2xs">{t('newSession.worktree.existingHint')}</p>
              ) : null}
            </div>
          )}
        </div>
      ) : null}
    </div>
  );
}
