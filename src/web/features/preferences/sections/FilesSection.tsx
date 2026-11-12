import { CircleCheckIcon, CircleXIcon, LoaderCircleIcon } from 'lucide-react';
import { useEffect, useId, useRef, useState } from 'react';
import { windowsPathsEqual } from '@shared/paths';
import {
  DEFAULT_PROGRAM_EXTENSIONS,
  EDITOR_PRESETS,
  editorPresetSchema,
  type EditorPreset,
  type EditorSettings,
} from '@shared/model';
import type { CommandResult } from '@shared/protocol';
import { useFormat, useT } from '@web/i18n';
import { cn } from '@web/lib/cn';
import { sendCommand } from '@web/state/hooks';
import { Badge } from '@web/ui/badge';
import { Button } from '@web/ui/button';
import { Input } from '@web/ui/input';
import { Label } from '@web/ui/label';
import { RadioGroup, RadioGroupItem } from '@web/ui/radio-group';
import { Textarea } from '@web/ui/textarea';
import { SettingField, SettingList } from '../components/SettingField';
import {
  EDITOR_ARGS_MAX,
  PREVIEW_TARGET,
  argLines,
  commandLinePreview,
  draftOf,
  editorIssues,
  editorOfDraft,
  hasIssues,
  sameEditor,
  type EditorDraft,
  type EditorIssue,
} from '../lib/editor';
import type { SettingsEditor } from '../state/settings-editor';

type DetectResult = CommandResult<'editor.detect'>;
type Detection = { status: 'loading' } | { status: 'done'; result: DetectResult } | { status: 'failed' };

/** The form: the chosen preset, a path per preset (switching keeps what was typed) and the arguments. */
interface EditorForm {
  preset: EditorPreset;
  paths: Readonly<Record<EditorPreset, string>>;
  args: string;
}

const EMPTY_PATHS: Readonly<Record<EditorPreset, string>> = {
  notepadpp: '',
  vscode: '',
  custom: '',
  system: '',
};

function formOfDraft(draft: EditorDraft): EditorForm {
  return {
    preset: draft.preset,
    paths: { ...EMPTY_PATHS, [draft.preset]: draft.executable },
    args: draft.args,
  };
}

function formOf(editor: EditorSettings): EditorForm {
  return formOfDraft(draftOf(editor));
}

function draftOfForm(form: EditorForm): EditorDraft {
  return { preset: form.preset, executable: form.paths[form.preset], args: form.args };
}

const LOADING: Detection = { status: 'loading' };

/** `editor.detect` on the local host, again whenever the saved editor changes. */
function useDetection(saved: EditorSettings): Detection {
  const key = `${saved.preset}\n${saved.executable ?? ''}`;
  const [answer, setAnswer] = useState<{ key: string; detection: Detection } | null>(null);
  useEffect(() => {
    let active = true;
    sendCommand(null, { name: 'editor.detect' }).then(
      (result) => {
        if (active) setAnswer({ key, detection: { status: 'done', result } });
      },
      () => {
        if (active) setAnswer({ key, detection: { status: 'failed' } });
      },
    );
    return () => {
      active = false;
    };
  }, [key]);
  // An answer for an older saved editor counts as "still looking".
  return answer?.key === key ? answer.detection : LOADING;
}

/** Found/not found of a preset (Notepad++, VS Code); nothing for the others. */
function DetectLine({ id, preset, detection }: { id: string; preset: EditorPreset; detection: Detection }) {
  const t = useT();
  if (preset !== 'notepadpp' && preset !== 'vscode') return null;
  let content;
  if (detection.status === 'loading') {
    content = (
      <>
        <LoaderCircleIcon aria-hidden className="size-3 shrink-0 motion-safe:animate-spin" />
        {t('preferences.files.detecting')}
      </>
    );
  } else if (detection.status === 'failed') {
    content = t('preferences.files.detectFailed');
  } else {
    const path = detection.result[preset];
    content =
      path === null ? (
        <>
          <CircleXIcon aria-hidden className="text-muted-foreground size-3 shrink-0" />
          {t('preferences.files.notFound')}
        </>
      ) : (
        <>
          <CircleCheckIcon aria-hidden className="text-success size-3 shrink-0" />
          <span className="min-w-0 break-all">{t('preferences.files.found', { path })}</span>
        </>
      );
  }
  return (
    <p
      id={id}
      data-slot="editor-detect"
      data-preset={preset}
      data-found={
        detection.status === 'done' ? (detection.result[preset] === null ? 'false' : 'true') : undefined
      }
      className="text-muted-foreground flex items-start gap-1 text-2xs leading-relaxed"
    >
      {content}
    </p>
  );
}

function issueText(t: ReturnType<typeof useT>, issue: EditorIssue): string {
  switch (issue) {
    case 'file_placeholder':
      return t('preferences.files.issues.file_placeholder', { placeholder: '{file}' });
    case 'too_many':
      return t('preferences.files.issues.too_many', { max: EDITOR_ARGS_MAX });
    default:
      return t(`preferences.files.issues.${issue}`);
  }
}

function FieldIssue({ id, issue }: { id: string; issue: EditorIssue | null }) {
  const t = useT();
  if (issue === null) return null;
  return (
    <p
      id={id}
      data-slot="editor-issue"
      data-issue={issue}
      className="text-destructive text-2xs leading-relaxed"
    >
      {issueText(t, issue)}
    </p>
  );
}

/**
 * Section "Files" (WP-58, ADR-144, user decision F3): the editor for "Open in editor" – Notepad++
 * (default), VS Code, an own program (.exe + argument lines with {file} {line} {col}, command line
 * preview) or the Windows default program (only for harmless file types). Shows what
 * `editor.detect` found. Choosing Notepad++, VS Code or the default program saves at once like the
 * other settings; paths and arguments are a form with "Save" – checked first with the server's
 * schema (issues at the field), then sent as `settings.update {editor}`.
 */
export function FilesSection({
  editor,
  initialDraft,
}: {
  editor: SettingsEditor;
  /** Playground: start with this (unsaved) form. */
  initialDraft?: EditorDraft;
}) {
  const t = useT();
  const format = useFormat();
  const id = useId();
  const stored = editor.settings.editor;
  const [form, setForm] = useState<EditorForm>(() =>
    initialDraft === undefined ? formOf(stored) : formOfDraft(initialDraft),
  );
  const [baseline, setBaseline] = useState(stored);
  const [attempted, setAttempted] = useState(false);
  const pathRef = useRef<HTMLInputElement | null>(null);
  const argsRef = useRef<HTMLTextAreaElement | null>(null);
  const detection = useDetection(stored);

  const draft = draftOfForm(form);
  const value = editorOfDraft(draft);
  const dirty = !sameEditor(value, stored);
  const issues = editorIssues(draft);

  // The stored editor changed (ack, rollback, another window): take it over unless the form holds
  // own unsaved changes.
  if (!sameEditor(baseline, stored)) {
    setBaseline(stored);
    if (sameEditor(editorOfDraft(draftOfForm(form)), baseline)) {
      setForm(formOf(stored));
      setAttempted(false);
    }
  }

  const choose = (preset: EditorPreset) => {
    const next: EditorForm = { ...form, preset };
    setForm(next);
    setAttempted(false);
    const nextDraft = draftOfForm(next);
    const nextValue = editorOfDraft(nextDraft);
    // A preset without a form of its own is saved at once; "own program" waits for "Save".
    const saveNow = preset !== 'custom' && !hasIssues(editorIssues(nextDraft));
    if (saveNow && !sameEditor(nextValue, stored)) editor.save({ editor: nextValue });
  };

  const submit = () => {
    if (hasIssues(issues)) {
      setAttempted(true);
      (issues.executable !== null ? pathRef.current : argsRef.current)?.focus();
      return;
    }
    setAttempted(false);
    editor.save({ editor: value });
  };

  const path = form.paths[form.preset];
  const showPathIssue = attempted || path.trim() !== '' ? issues.executable : null;
  const showArgsIssue = attempted || form.args.trim() !== '' ? issues.args : null;
  const custom = form.preset === 'custom';
  const pathId = `${id}-path`;
  const pathHintId = `${id}-path-hint`;
  const pathIssueId = `${id}-path-issue`;
  const pathStateId = `${id}-path-state`;
  const argsId = `${id}-args`;
  const argsHintId = `${id}-args-hint`;
  const argsIssueId = `${id}-args-issue`;
  const customCheck =
    detection.status === 'done' &&
    detection.result.custom !== null &&
    path.trim() !== '' &&
    windowsPathsEqual(detection.result.custom.executable, path.trim())
      ? detection.result.custom.exists
      : null;
  const preview =
    custom && issues.executable === null && path.trim() !== ''
      ? commandLinePreview(path.trim(), argLines(form.args))
      : null;

  return (
    <SettingList>
      <SettingField
        name="editor"
        label={t('preferences.files.editor')}
        description={t('preferences.files.editorHint')}
        below={({ id: fieldId, labelId, describedBy }) => (
          <div className="grid gap-4">
            <RadioGroup
              aria-labelledby={labelId}
              aria-describedby={describedBy}
              value={form.preset}
              onValueChange={(next) => {
                const preset = editorPresetSchema.safeParse(next);
                if (preset.success) choose(preset.data);
              }}
              className="grid gap-2.5"
            >
              {EDITOR_PRESETS.map((preset) => {
                const itemId = `${fieldId}-${preset}`;
                const detectId = `${itemId}-detect`;
                const detects = preset === 'notepadpp' || preset === 'vscode';
                return (
                  <div key={preset} data-preset={preset} className="flex items-start gap-2">
                    <RadioGroupItem
                      id={itemId}
                      value={preset}
                      aria-describedby={detects ? detectId : undefined}
                      className="mt-0.5"
                    />
                    <div className="grid min-w-0 gap-0.5">
                      <Label htmlFor={itemId} className="gap-1.5 font-normal">
                        {t(`preferences.files.presets.${preset}`)}
                        {preset === 'notepadpp' ? (
                          <Badge variant="outline">{t('preferences.files.defaultBadge')}</Badge>
                        ) : null}
                      </Label>
                      <DetectLine id={detectId} preset={preset} detection={detection} />
                    </div>
                  </div>
                );
              })}
            </RadioGroup>

            {form.preset === 'system' ? (
              <p data-slot="editor-system-hint" className="text-muted-foreground text-2xs leading-relaxed">
                {t('preferences.files.systemHint', { extensions: format.list(DEFAULT_PROGRAM_EXTENSIONS) })}
              </p>
            ) : (
              <div data-slot="editor-form" className="grid gap-3">
                <div className="grid gap-1">
                  <Label htmlFor={pathId}>
                    {custom ? t('preferences.files.path') : t('preferences.files.pathOptional')}
                  </Label>
                  <Input
                    ref={pathRef}
                    id={pathId}
                    value={path}
                    spellCheck={false}
                    autoComplete="off"
                    className="font-mono text-xs"
                    placeholder={t('preferences.files.pathPlaceholder')}
                    aria-invalid={showPathIssue === null ? undefined : true}
                    aria-describedby={[
                      pathHintId,
                      showPathIssue === null ? undefined : pathIssueId,
                      customCheck === null ? undefined : pathStateId,
                    ]
                      .filter(Boolean)
                      .join(' ')}
                    onChange={(event) => {
                      const next = event.target.value;
                      setForm((current) => ({
                        ...current,
                        paths: { ...current.paths, [current.preset]: next },
                      }));
                    }}
                  />
                  <p id={pathHintId} className="text-muted-foreground text-2xs leading-relaxed">
                    {custom ? t('preferences.files.customHint') : t('preferences.files.pathOptionalHint')}
                  </p>
                  <FieldIssue id={pathIssueId} issue={showPathIssue} />
                  {customCheck === null ? null : (
                    <p
                      id={pathStateId}
                      data-slot="editor-path-state"
                      className={cn('text-2xs', customCheck ? 'text-muted-foreground' : 'text-warning')}
                    >
                      {customCheck ? t('preferences.files.pathExists') : t('preferences.files.pathMissing')}
                    </p>
                  )}
                </div>
                {custom ? (
                  <div className="grid gap-1">
                    <Label htmlFor={argsId}>{t('preferences.files.args')}</Label>
                    <Textarea
                      ref={argsRef}
                      id={argsId}
                      value={form.args}
                      rows={3}
                      spellCheck={false}
                      className="max-h-40 font-mono text-xs"
                      aria-invalid={showArgsIssue === null ? undefined : true}
                      aria-describedby={showArgsIssue === null ? argsHintId : `${argsHintId} ${argsIssueId}`}
                      onChange={(event) => {
                        const next = event.target.value;
                        setForm((current) => ({ ...current, args: next }));
                      }}
                    />
                    <p id={argsHintId} className="text-muted-foreground text-2xs leading-relaxed">
                      {t('preferences.files.argsHint', { file: '{file}', line: '{line}', col: '{col}' })}
                    </p>
                    <FieldIssue id={argsIssueId} issue={showArgsIssue} />
                  </div>
                ) : null}
                {preview === null ? null : (
                  <div className="grid gap-1">
                    <p className="text-xs font-medium">{t('preferences.files.preview')}</p>
                    <code
                      data-slot="editor-preview"
                      className="bg-muted/60 rounded-md px-2 py-1.5 font-mono text-2xs break-all"
                    >
                      {preview}
                    </code>
                    <p className="text-muted-foreground text-2xs leading-relaxed">
                      {t('preferences.files.previewHint', {
                        sample: PREVIEW_TARGET.file,
                        line: PREVIEW_TARGET.line,
                        col: PREVIEW_TARGET.col,
                      })}
                    </p>
                  </div>
                )}
                <div className="flex items-center gap-3">
                  <Button size="sm" data-action="editor-save" disabled={!dirty} onClick={submit}>
                    {t('preferences.files.save')}
                  </Button>
                  {dirty ? (
                    <span data-slot="editor-unsaved" className="text-muted-foreground text-2xs">
                      {t('preferences.files.unsaved')}
                    </span>
                  ) : null}
                </div>
              </div>
            )}
          </div>
        )}
      />
    </SettingList>
  );
}
