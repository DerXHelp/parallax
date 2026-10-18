import { FlaskConicalIcon, FolderSearchIcon, SaveIcon, StarIcon, Trash2Icon, TriangleAlertIcon } from 'lucide-react';
import { useEffect, useEffectEvent, useId, useMemo, useRef, useState, type ReactNode } from 'react';
import { EFFORT_LEVELS, type EffortLevel, type PermissionMode, type ProfileId } from '@shared/common';
import type { ErrorPayload } from '@shared/errors';
import type { ClaudeInstallStatus, Profile, ProfileIssue, ProfileSummary } from '@shared/model';
import { useI18n } from '@web/i18n';
import { FolderBrowser } from '@web/shell/new-session/FolderBrowser';
import { issueCounts } from '@web/shell/new-session/profile-issues';
import { ProfileIssueText } from '@web/shell/new-session/profile-status';
import { errorPayloadOf } from '@web/state/connection';
import { sendCommand } from '@web/state/hooks';
import { Alert } from '@web/ui/alert';
import { Badge } from '@web/ui/badge';
import { Button } from '@web/ui/button';
import { Input } from '@web/ui/input';
import { Label } from '@web/ui/label';
import { RadioGroup, RadioGroupItem } from '@web/ui/radio-group';
import { Spinner } from '@web/ui/spinner';
import { Switch } from '@web/ui/switch';
import {
  CONTEXT_WINDOW_MAX,
  CONTEXT_WINDOW_MIN,
  PROFILE_NAME_MAX,
  buildInput,
  bypassAllowed,
  configDirChanged,
  draftFromProfile,
  draftKey,
  newDraft,
  placeIssues,
  problemsFor,
  type BuiltInput,
  type ProfileDraft,
} from '../lib/draft';
import { ArgList } from './ArgList';
import { ColorPicker } from './ColorPicker';
import { EnvTable } from './EnvTable';
import { FieldNotes } from './FieldNotes';
import { OptionMenu, type MenuOption } from './OptionMenu';
import { TestResult } from './TestResult';

/** Live check of the draft (`profile.validate`) after this pause in typing. */
export const VALIDATE_DEBOUNCE_MS = 400;

/** Modes offered as profile default (like the composer: `dontAsk` never; bypass only if allowed). */
const MODES: readonly PermissionMode[] = ['default', 'acceptEdits', 'plan', 'auto'];

export interface ProfileEditorEvents {
  /** After `profile.save` (the list then shows the saved profile). */
  onSaved: (profileId: ProfileId, name: string) => void;
  onDeleted: (name: string) => void;
  onDefaultSet: (name: string) => void;
  /** "Discard" of a new, unsaved profile. */
  onDiscardNew: () => void;
  /** The form differs from its start (an untouched new profile is not dirty – nothing to lose). */
  onDirtyChange: (dirty: boolean) => void;
}

/**
 * Loads the complete profile (`profile.get` – the host state never contains env values) and shows
 * the form. Mounted anew per profile and after every save (key), so the form starts from the
 * server's state.
 */
export function SavedProfileEditor({
  profileId,
  summary,
  events,
}: {
  profileId: ProfileId;
  summary: ProfileSummary | null;
  events: ProfileEditorEvents;
}) {
  const { t, tError } = useI18n();
  const [attempt, setAttempt] = useState(0);
  const [loaded, setLoaded] = useState<
    | { profile: Profile; draft: ProfileDraft; issues: ProfileIssue[]; entryCount: number }
    | { error: ErrorPayload }
    | null
  >(null);
  useEffect(() => {
    let cancelled = false;
    sendCommand(null, { name: 'profile.get', profileId }).then(
      (result) => {
        if (!cancelled) setLoaded({ ...result, draft: draftFromProfile(result.profile) });
      },
      (caught: unknown) => {
        if (!cancelled) setLoaded({ error: errorPayloadOf(caught) });
      },
    );
    return () => {
      cancelled = true;
    };
  }, [profileId, attempt]);

  if (loaded === null) {
    return (
      <div className="text-muted-foreground flex items-center gap-2 p-4 text-xs" data-slot="profile-editor-loading">
        <Spinner label={t('profiles.editor.loading')} />
        {t('profiles.editor.loading')}
      </div>
    );
  }
  if ('error' in loaded) {
    return (
      <Alert
        tone="error"
        title={t('profiles.editor.loadFailed')}
        actions={
          <Button
            size="sm"
            variant="outline"
            onClick={() => {
              setLoaded(null);
              setAttempt((value) => value + 1);
            }}
          >
            {t('common.retry')}
          </Button>
        }
      >
        {tError(loaded.error)}
      </Alert>
    );
  }
  return (
    <ProfileForm
      profileId={profileId}
      summary={summary}
      initialDraft={loaded.draft}
      initialIssues={loaded.issues}
      savedConfigDir={loaded.profile.configDir}
      entryCount={summary?.entryCount ?? loaded.entryCount}
      builtin={loaded.profile.builtin}
      events={events}
    />
  );
}

/** The form of a new profile (nothing to load). */
export function NewProfileEditor({
  profiles,
  events,
}: {
  profiles: readonly ProfileSummary[];
  events: ProfileEditorEvents;
}) {
  const [initialDraft] = useState(() => newDraft(profiles));
  return (
    <ProfileForm
      profileId={null}
      summary={null}
      initialDraft={initialDraft}
      initialIssues={[]}
      savedConfigDir={null}
      entryCount={0}
      builtin={false}
      events={events}
    />
  );
}

type Busy = 'save' | 'default' | 'test' | 'delete' | null;

function inputKey(built: BuiltInput): string | null {
  return built.input === null ? null : JSON.stringify([built.input, built.argRowIds]);
}

function Section({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className="grid gap-3">
      <h4 className="text-muted-foreground text-2xs font-semibold tracking-wide uppercase">{title}</h4>
      {children}
    </section>
  );
}

function ProfileForm({
  profileId,
  summary,
  initialDraft,
  initialIssues,
  savedConfigDir,
  entryCount,
  builtin,
  events,
}: {
  /** null = a new profile. */
  profileId: ProfileId | null;
  summary: ProfileSummary | null;
  initialDraft: ProfileDraft;
  initialIssues: ProfileIssue[];
  savedConfigDir: string | null;
  entryCount: number;
  builtin: boolean;
  events: ProfileEditorEvents;
}) {
  const { t, tError, format } = useI18n();
  const ids = {
    name: useId(),
    nameNotes: useId(),
    color: useId(),
    executable: useId(),
    executablePath: useId(),
    executableNotes: useId(),
    configDir: useId(),
    configDirHint: useId(),
    env: useId(),
    envHint: useId(),
    args: useId(),
    argsHint: useId(),
    passRaw: useId(),
    contextWindow: useId(),
    contextWindowHint: useId(),
    model: useId(),
    modelNotes: useId(),
    mode: useId(),
    modeLabel: useId(),
    modeNotes: useId(),
    effort: useId(),
    effortLabel: useId(),
  };
  const [draft, setDraft] = useState(initialDraft);
  const [baseline] = useState(() => draftKey(initialDraft));
  const [validation, setValidation] = useState(() => ({
    issues: initialIssues,
    argRowIds: initialDraft.args.filter((row) => row.value !== '').map((row) => row.id),
  }));
  // The loaded findings belong to the saved profile: the first check runs only after a change.
  const [firstKey] = useState(() =>
    inputKey(buildInput(initialDraft, profileId, { allowsBypass: bypassAllowed(initialIssues) })),
  );
  const validatedKey = useRef<string | null>(firstKey);
  const [checking, setChecking] = useState(false);
  const [attempted, setAttempted] = useState(false);
  const [busy, setBusy] = useState<Busy>(null);
  const [actionError, setActionError] = useState<ErrorPayload | null>(null);
  const [testResult, setTestResult] = useState<ClaudeInstallStatus | null>(null);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const validateSeq = useRef(0);
  const resultsRef = useRef<HTMLDivElement>(null);
  const deleteRef = useRef<HTMLButtonElement>(null);

  const allowsBypass = bypassAllowed(validation.issues);
  const built = useMemo(() => buildInput(draft, profileId, { allowsBypass }), [draft, profileId, allowsBypass]);
  const currentKey = inputKey(built);
  const changed = draftKey(draft) !== baseline;
  /** Something to save: every new profile, a saved one only when changed. */
  const dirty = profileId === null || changed;
  const placed = useMemo(
    () => placeIssues(validation.issues, validation.argRowIds, draft.env),
    [validation, draft.env],
  );
  const counts = issueCounts(validation.issues);
  const visibleProblems = attempted ? built.problems : built.problems.filter((problem) => problem.field !== 'name');
  const isDefault = summary?.isDefault === true;
  const savedErrors = summary === null ? 0 : issueCounts(summary.issues).error;
  const showConfigDirWarning = profileId !== null && entryCount > 0 && configDirChanged(savedConfigDir, draft.configDir);

  const reportDirty = useEffectEvent((value: boolean) => {
    events.onDirtyChange(value);
  });
  useEffect(() => {
    reportDirty(changed);
  }, [changed]);

  // V3-14: the result of "Test profile" (or its error) appears below the fold – bring it into view.
  useEffect(() => {
    if (testResult === null && actionError === null) return;
    const results = resultsRef.current;
    // happy-dom and old engines may lack scrollIntoView.
    if (typeof results?.scrollIntoView === 'function') results.scrollIntoView({ block: 'nearest' });
  }, [testResult, actionError]);

  /** `profile.validate` of the current draft; only the newest answer counts. */
  const validateNow = (key: string) => {
    const input = built.input;
    if (input === null) return;
    const argRowIds = built.argRowIds;
    const seq = ++validateSeq.current;
    setChecking(true);
    sendCommand(null, { name: 'profile.validate', profile: input }).then(
      (result) => {
        if (seq !== validateSeq.current) return;
        validatedKey.current = key;
        setValidation({ issues: result.issues, argRowIds });
        setChecking(false);
      },
      () => {
        if (seq === validateSeq.current) setChecking(false);
      },
    );
  };
  const runValidation = useEffectEvent((key: string) => {
    validateNow(key);
  });

  useEffect(() => {
    if (currentKey === null || currentKey === validatedKey.current) return undefined;
    const timer = setTimeout(() => {
      runValidation(currentKey);
    }, VALIDATE_DEBOUNCE_MS);
    return () => {
      clearTimeout(timer);
    };
  }, [currentKey]);

  const patch = (next: Partial<ProfileDraft>) => {
    setDraft((current) => ({ ...current, ...next }));
  };

  const save = async () => {
    setAttempted(true);
    if (built.input === null || counts.error > 0 || busy !== null) return;
    const input = built.input;
    setBusy('save');
    setActionError(null);
    try {
      const result = await sendCommand(null, { name: 'profile.save', profile: input });
      events.onSaved(result.profileId, input.name);
    } catch (caught) {
      const error = errorPayloadOf(caught);
      setActionError(error);
      if (currentKey !== null && error.code === 'PROFILE_INVALID') validateNow(currentKey);
    } finally {
      setBusy(null);
    }
  };

  const run = async (kind: Exclude<Busy, null | 'save'>, action: () => Promise<void>) => {
    if (busy !== null) return;
    setBusy(kind);
    setActionError(null);
    try {
      await action();
    } catch (caught) {
      setActionError(errorPayloadOf(caught));
    } finally {
      setBusy(null);
    }
  };

  const modeOptions: MenuOption<PermissionMode>[] = [
    { value: null, label: t('profiles.fields.notSet') },
    ...MODES.map((mode) => ({ value: mode, label: t(`shell.permissionMode.${mode}`) })),
  ];
  if (allowsBypass || draft.permissionMode === 'bypassPermissions') {
    modeOptions.push({
      value: 'bypassPermissions',
      label: t('shell.permissionMode.bypassPermissions'),
      hint: allowsBypass ? undefined : t('profiles.problems.bypassNotAllowed'),
      destructive: true,
    });
  }
  const effortOptions: MenuOption<EffortLevel>[] = [
    { value: null, label: t('profiles.fields.notSet') },
    ...EFFORT_LEVELS.map((effort) => ({ value: effort, label: t(`newSession.efforts.${effort}`) })),
  ];

  const nameProblems = problemsFor(visibleProblems, 'name');
  const executableProblems = problemsFor(visibleProblems, 'executable');
  const configDirProblems = problemsFor(visibleProblems, 'configDir');
  const contextProblems = problemsFor(visibleProblems, 'contextWindow');
  const modelProblems = problemsFor(visibleProblems, 'model');
  const modeProblems = problemsFor(visibleProblems, 'permissionMode');
  const deleteReason =
    profileId === null
      ? null
      : builtin
        ? t('profiles.editor.deleteBuiltin')
        : entryCount > 0
          ? t('profiles.editor.deleteInUse', { count: entryCount })
          : null;
  const title = profileId === null ? t('profiles.editor.titleNew') : (summary?.name ?? initialDraft.name);

  return (
    <form
      data-slot="profile-editor"
      data-profile-id={profileId ?? 'new'}
      aria-label={title}
      className="grid gap-5"
      onSubmit={(event) => {
        event.preventDefault();
        void save();
      }}
    >
      <div className="flex flex-wrap items-center gap-2">
        <h3 className="text-sm font-semibold">{title}</h3>
        {isDefault ? <Badge variant="outline">{t('profiles.list.default')}</Badge> : null}
        {builtin ? <Badge variant="secondary">{t('profiles.list.builtin')}</Badge> : null}
        {dirty && profileId !== null ? (
          <Badge variant="warning" data-slot="profile-dirty">
            {t('profiles.editor.unsaved')}
          </Badge>
        ) : null}
      </div>

      <div className="grid gap-1.5" data-slot="profile-findings" aria-live="polite">
        <div className="text-muted-foreground flex flex-wrap items-center gap-1.5 text-2xs">
          <span className="font-medium">{t('profiles.editor.findings')}</span>
          {checking ? <Spinner label={t('profiles.editor.checking')} className="size-3" /> : null}
          {counts.error + counts.warning + counts.info === 0 ? (
            <span>{t('profiles.editor.noFindings')}</span>
          ) : (
            <>
              {counts.error > 0 ? (
                <Badge variant="destructive">{t('profiles.list.errors', { count: counts.error })}</Badge>
              ) : null}
              {counts.warning > 0 ? (
                <Badge variant="warning">{t('profiles.list.warnings', { count: counts.warning })}</Badge>
              ) : null}
              {counts.info > 0 ? (
                <Badge variant="info">{t('profiles.list.infos', { count: counts.info })}</Badge>
              ) : null}
            </>
          )}
        </div>
        {placed.general.length === 0 ? null : (
          <div className="grid gap-1">
            {placed.general.map((finding, index) => (
              <ProfileIssueText key={`${finding.issue.code}-${String(index)}`} finding={finding} />
            ))}
          </div>
        )}
      </div>

      <Section title={t('profiles.sections.general')}>
        <div className="grid gap-1.5">
          <Label htmlFor={ids.name}>{t('profiles.fields.name')}</Label>
          <Input
            id={ids.name}
            value={draft.name}
            maxLength={PROFILE_NAME_MAX}
            autoComplete="off"
            placeholder={t('profiles.fields.namePlaceholder')}
            aria-invalid={nameProblems.length > 0 ? true : undefined}
            aria-describedby={nameProblems.length > 0 ? ids.nameNotes : undefined}
            onChange={(event) => {
              patch({ name: event.target.value });
            }}
          />
          <FieldNotes id={ids.nameNotes} problems={nameProblems} />
        </div>
        <div className="grid gap-1.5">
          {/* Names a group (aria-labelledby), not one form field: no <label> (V3-12). */}
          <span id={ids.color} className="text-xs font-medium">
            {t('profiles.fields.color')}
          </span>
          <ColorPicker
            value={draft.color}
            labelId={ids.color}
            onChange={(color) => {
              patch({ color });
            }}
          />
        </div>
      </Section>

      <Section title={t('profiles.sections.claude')}>
        <div className="grid gap-1.5">
          <span id={ids.executable} className="text-xs font-medium">
            {t('profiles.fields.executable')}
          </span>
          <RadioGroup
            aria-labelledby={ids.executable}
            value={draft.executableKind}
            onValueChange={(value) => {
              if (value === 'auto' || value === 'path') patch({ executableKind: value });
            }}
            className="gap-1.5"
          >
            <div className="flex items-center gap-2">
              <RadioGroupItem value="auto" id={`${ids.executable}-auto`} />
              <Label htmlFor={`${ids.executable}-auto`} className="font-normal">
                {t('profiles.fields.executableAuto')}
              </Label>
            </div>
            <div className="flex items-center gap-2">
              <RadioGroupItem value="path" id={`${ids.executable}-path`} />
              <Label htmlFor={`${ids.executable}-path`} className="font-normal">
                {t('profiles.fields.executablePath')}
              </Label>
            </div>
          </RadioGroup>
          {draft.executableKind === 'path' ? (
            <Input
              id={ids.executablePath}
              value={draft.executablePath}
              spellCheck={false}
              autoComplete="off"
              aria-label={t('profiles.fields.executablePathLabel')}
              placeholder={t('profiles.fields.executablePlaceholder')}
              aria-invalid={
                executableProblems.length > 0 || placed.executable.some((finding) => finding.level === 'error')
                  ? true
                  : undefined
              }
              aria-describedby={ids.executableNotes}
              className="font-mono text-xs"
              onChange={(event) => {
                patch({ executablePath: event.target.value });
              }}
            />
          ) : null}
          <FieldNotes id={ids.executableNotes} problems={executableProblems} issues={placed.executable} />
        </div>

        <div className="grid gap-1.5">
          <Label htmlFor={ids.configDir}>{t('profiles.fields.configDir')}</Label>
          <div className="flex gap-2">
            <Input
              id={ids.configDir}
              value={draft.configDir}
              spellCheck={false}
              autoComplete="off"
              placeholder={t('profiles.fields.configDirPlaceholder')}
              aria-invalid={
                configDirProblems.length > 0 || placed.configDir.length > 0 ? true : undefined
              }
              aria-describedby={ids.configDirHint}
              className="font-mono text-xs"
              onChange={(event) => {
                patch({ configDir: event.target.value });
              }}
            />
            <FolderBrowser
              initialPath={draft.configDir.trim() === '' ? null : draft.configDir}
              onSelect={(path) => {
                patch({ configDir: path });
              }}
            >
              <Button variant="outline" data-action="browse-config-dir">
                <FolderSearchIcon aria-hidden />
                {t('profiles.fields.configDirBrowse')}
              </Button>
            </FolderBrowser>
          </div>
          <div id={ids.configDirHint} className="grid gap-1">
            <p className="text-muted-foreground text-2xs">{t('profiles.fields.configDirHint')}</p>
            {/* WP41-06: Claude Code sets up a chosen folder itself – even "Test profile" writes there. */}
            {draft.configDir.trim() === '' ? null : (
              <p data-slot="config-dir-writes" className="text-muted-foreground text-2xs">
                {t('profiles.fields.configDirWrites')}
              </p>
            )}
            <FieldNotes id={`${ids.configDirHint}-notes`} problems={configDirProblems} issues={placed.configDir} />
            {showConfigDirWarning ? (
              <Alert tone="warning" data-slot="config-dir-warning">
                {t('profiles.fields.configDirWarning', { count: entryCount })}
              </Alert>
            ) : null}
          </div>
        </div>
      </Section>

      <Section title={t('profiles.sections.environment')}>
        <div className="grid gap-1.5">
          <span id={ids.env} className="text-xs font-medium">
            {t('profiles.fields.env')}
          </span>
          <p id={ids.envHint} className="text-muted-foreground text-2xs">
            {t('profiles.fields.envHint', { reference: '${env:NAME}' })}
          </p>
          <EnvTable
            rows={draft.env}
            labelId={ids.env}
            hintId={ids.envHint}
            problems={visibleProblems}
            issues={placed.env}
            onChange={(env) => {
              patch({ env });
            }}
          />
        </div>
      </Section>

      <Section title={t('profiles.sections.arguments')}>
        <div className="grid gap-1.5">
          <span id={ids.args} className="text-xs font-medium">
            {t('profiles.fields.args')}
          </span>
          <p id={ids.argsHint} className="text-muted-foreground text-2xs">
            {t('profiles.fields.argsHint')}
          </p>
          <ArgList
            rows={draft.args}
            labelId={ids.args}
            hintId={ids.argsHint}
            problems={visibleProblems}
            issues={placed.args}
            onChange={(args) => {
              patch({ args });
            }}
          />
          <div className="flex items-start gap-2 pt-1">
            <Switch
              id={ids.passRaw}
              checked={draft.passRawArgs}
              data-action="pass-raw"
              aria-describedby={`${ids.passRaw}-hint`}
              onCheckedChange={(checked) => {
                patch({ passRawArgs: checked });
              }}
            />
            <div className="grid gap-0.5">
              <Label htmlFor={ids.passRaw} className="font-normal">
                {t('profiles.fields.passRaw')}
              </Label>
              <span id={`${ids.passRaw}-hint`} className="text-muted-foreground text-2xs">
                {t('profiles.fields.passRawHint')}
              </span>
            </div>
          </div>
        </div>
        <div className="grid gap-1.5">
          <Label htmlFor={ids.contextWindow}>{t('profiles.fields.contextWindow')}</Label>
          <Input
            id={ids.contextWindow}
            value={draft.contextWindow}
            inputMode="numeric"
            autoComplete="off"
            placeholder={t('profiles.fields.contextWindowPlaceholder')}
            aria-invalid={contextProblems.length > 0 ? true : undefined}
            aria-describedby={ids.contextWindowHint}
            className="max-w-48 font-mono text-xs"
            onChange={(event) => {
              patch({ contextWindow: event.target.value });
            }}
          />
          <div id={ids.contextWindowHint} className="grid gap-0.5">
            <p className="text-muted-foreground text-2xs">
              {t('profiles.fields.contextWindowHint', {
                min: format.number(CONTEXT_WINDOW_MIN),
                max: format.number(CONTEXT_WINDOW_MAX),
              })}
            </p>
            <FieldNotes id={`${ids.contextWindowHint}-notes`} problems={contextProblems} />
          </div>
        </div>
      </Section>

      <Section title={t('profiles.sections.defaults')}>
        {/* One field per row (V3-06): the menu labels ("Not set – Claude Code decides") never fit three columns. */}
        <div className="grid max-w-sm grid-cols-[minmax(0,1fr)] gap-3" data-slot="profile-defaults">
          <div className="grid content-start gap-1.5">
            <Label htmlFor={ids.model}>{t('profiles.fields.model')}</Label>
            <Input
              id={ids.model}
              value={draft.model}
              spellCheck={false}
              autoComplete="off"
              placeholder={t('profiles.fields.modelPlaceholder')}
              aria-invalid={modelProblems.length > 0 ? true : undefined}
              aria-describedby={modelProblems.length > 0 ? ids.modelNotes : undefined}
              className="font-mono text-xs"
              onChange={(event) => {
                patch({ model: event.target.value });
              }}
            />
            <FieldNotes id={ids.modelNotes} problems={modelProblems} />
          </div>
          <div className="grid content-start gap-1.5">
            <Label id={ids.modeLabel} htmlFor={ids.mode}>
              {t('profiles.fields.mode')}
            </Label>
            <OptionMenu
              id={ids.mode}
              labelId={ids.modeLabel}
              slot="profile-mode"
              value={draft.permissionMode}
              options={modeOptions}
              invalid={modeProblems.length > 0}
              onChange={(permissionMode) => {
                patch({ permissionMode });
              }}
            />
            <FieldNotes id={ids.modeNotes} problems={modeProblems} />
          </div>
          <div className="grid content-start gap-1.5">
            <Label id={ids.effortLabel} htmlFor={ids.effort}>
              {t('profiles.fields.effort')}
            </Label>
            <OptionMenu
              id={ids.effort}
              labelId={ids.effortLabel}
              slot="profile-effort"
              value={draft.effort}
              options={effortOptions}
              onChange={(effort) => {
                patch({ effort });
              }}
            />
          </div>
        </div>
      </Section>

      {testResult === null && actionError === null ? null : (
        <div ref={resultsRef} data-slot="profile-results" className="grid gap-3">
          {testResult === null ? null : <TestResult claude={testResult} />}
          {actionError === null ? null : (
            <Alert tone="error" data-slot="profile-action-error">
              {tError(actionError)}
            </Alert>
          )}
        </div>
      )}
      {confirmDelete && profileId !== null ? (
        <Alert
          tone="warning"
          data-slot="profile-delete-confirm"
          title={t('profiles.editor.deleteConfirm', { name: summary?.name ?? draft.name })}
          actions={
            <>
              <Button
                size="sm"
                variant="destructive"
                data-action="profile-delete-confirm"
                disabled={busy !== null}
                onClick={() => {
                  void run('delete', async () => {
                    await sendCommand(null, { name: 'profile.delete', profileId });
                    setConfirmDelete(false);
                    events.onDeleted(summary?.name ?? draft.name);
                  });
                }}
              >
                {busy === 'delete' ? <Spinner label={t('profiles.editor.deleting')} /> : <Trash2Icon aria-hidden />}
                {t('profiles.editor.deleteConfirmAction')}
              </Button>
              <Button
                size="sm"
                variant="outline"
                data-action="profile-delete-cancel"
                // R4W-24: "Cancel" takes the focus – a repeated Enter on "Delete…" deletes nothing.
                autoFocus
                onClick={() => {
                  setConfirmDelete(false);
                  deleteRef.current?.focus();
                }}
              >
                {t('common.cancel')}
              </Button>
            </>
          }
        />
      ) : null}

      {/* Sticks to the bottom edge of the settings panel (which has no bottom padding, V3-06). */}
      <div
        data-slot="profile-actions"
        className="bg-popover sticky bottom-0 -mx-1 grid gap-1.5 border-t px-1 pt-2 pb-4"
      >
        <div className="flex flex-wrap items-center gap-2">
          <Button
            type="submit"
            data-action="profile-save"
            disabled={busy !== null || counts.error > 0 || !dirty}
          >
            {busy === 'save' ? <Spinner label={t('profiles.editor.saving')} /> : <SaveIcon aria-hidden />}
            {busy === 'save' ? t('profiles.editor.saving') : t('profiles.editor.save')}
          </Button>
          {profileId === null ? (
            <Button variant="ghost" data-action="profile-discard" onClick={events.onDiscardNew}>
              {t('profiles.editor.discardNew')}
            </Button>
          ) : (
            <>
              <Button
                variant="outline"
                data-action="profile-default"
                disabled={busy !== null || isDefault || savedErrors > 0}
                onClick={() => {
                  void run('default', async () => {
                    await sendCommand(null, { name: 'profile.setDefault', profileId });
                    events.onDefaultSet(summary?.name ?? draft.name);
                  });
                }}
              >
                <StarIcon aria-hidden />
                {isDefault ? t('profiles.editor.isDefault') : t('profiles.editor.setDefault')}
              </Button>
              <Button
                variant="outline"
                data-action="profile-test"
                disabled={busy !== null}
                onClick={() => {
                  void run('test', async () => {
                    setTestResult(null);
                    const result = await sendCommand(null, { name: 'profile.test', profileId });
                    setTestResult(result.claude);
                  });
                }}
              >
                {busy === 'test' ? <Spinner label={t('profiles.editor.testing')} /> : <FlaskConicalIcon aria-hidden />}
                {busy === 'test' ? t('profiles.editor.testing') : t('profiles.editor.test')}
              </Button>
              <Button
                ref={deleteRef}
                variant="ghost"
                data-action="profile-delete"
                className="text-destructive hover:text-destructive ml-auto"
                disabled={busy !== null || deleteReason !== null}
                aria-describedby={deleteReason === null ? undefined : `${ids.name}-delete-reason`}
                onClick={() => {
                  setConfirmDelete(true);
                }}
              >
                <Trash2Icon aria-hidden />
                {t('profiles.editor.delete')}
              </Button>
            </>
          )}
        </div>
        <div className="text-muted-foreground grid gap-0.5 text-2xs">
          {counts.error > 0 ? (
            <span className="text-destructive flex items-center gap-1" data-slot="profile-save-blocked">
              <TriangleAlertIcon aria-hidden className="size-3" />
              {t('profiles.editor.saveBlocked')}
            </span>
          ) : null}
          {profileId !== null && dirty ? <span>{t('profiles.editor.testSavedOnly')}</span> : null}
          {deleteReason === null ? null : (
            <span id={`${ids.name}-delete-reason`} data-slot="profile-delete-reason">
              {deleteReason}
            </span>
          )}
        </div>
      </div>
    </form>
  );
}
