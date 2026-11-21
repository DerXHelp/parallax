import { CircleCheckIcon, CircleXIcon, LoaderCircleIcon } from 'lucide-react';
import { useEffect, useState } from 'react';
import {
  defaultShellFor,
  gitBashWindowSchema,
  shellKindSchema,
  type ConsoleSettings,
  type HostState,
  type ShellKind,
} from '@shared/model';
import { WIN32_PATHS } from '@shared/paths';
import { useT } from '@web/i18n';
import { effectiveShell, shellChoices } from '@web/lib/shells';
import { sendCommand } from '@web/state/hooks';
import { Badge } from '@web/ui/badge';
import { Input } from '@web/ui/input';
import { Label } from '@web/ui/label';
import { RadioGroup, RadioGroupItem } from '@web/ui/radio-group';
import { SettingField, SettingList } from '../components/SettingField';
import { settingsHostOf } from '../lib/host-platform';
import type { SettingsEditor } from '../state/settings-editor';

type Detection =
  | { status: 'loading' }
  | { status: 'done'; gitDir: string | null; shells: readonly ShellKind[] }
  | { status: 'failed' };
const LOADING: Detection = { status: 'loading' };

/** `shell.detect` on the local host (Git folder, installed shells), again whenever the saved Git folder changes. */
function useGitDetection(saved: string | null): Detection {
  const key = saved ?? '';
  const [answer, setAnswer] = useState<{ key: string; detection: Detection } | null>(null);
  useEffect(() => {
    let active = true;
    sendCommand(null, { name: 'shell.detect' }).then(
      (result) => {
        if (active) {
          setAnswer({ key, detection: { status: 'done', gitDir: result.gitDir, shells: result.shells } });
        }
      },
      () => {
        if (active) setAnswer({ key, detection: { status: 'failed' } });
      },
    );
    return () => {
      active = false;
    };
  }, [key]);
  return answer?.key === key ? answer.detection : LOADING;
}

function GitDetectLine({ id, detection }: { id: string; detection: Detection }) {
  const t = useT();
  let content;
  if (detection.status === 'loading') {
    content = (
      <>
        <LoaderCircleIcon aria-hidden className="size-3 shrink-0 motion-safe:animate-spin" />
        {t('preferences.console.detecting')}
      </>
    );
  } else if (detection.status === 'failed') {
    content = t('preferences.console.detectFailed');
  } else if (detection.gitDir === null) {
    content = (
      <>
        <CircleXIcon aria-hidden className="text-muted-foreground size-3 shrink-0" />
        {t('preferences.console.notFound')}
      </>
    );
  } else {
    content = (
      <>
        <CircleCheckIcon aria-hidden className="text-success size-3 shrink-0" />
        <span className="min-w-0 break-all">
          {t('preferences.console.found', { path: detection.gitDir })}
        </span>
      </>
    );
  }
  return (
    <p
      id={id}
      data-slot="git-detect"
      data-found={detection.status === 'done' ? String(detection.gitDir !== null) : undefined}
      className="text-muted-foreground flex items-start gap-1 text-2xs leading-relaxed"
    >
      {content}
    </p>
  );
}

/** The Git folder field: saved on blur or Enter when empty (= detected) or a safe absolute path. */
function GitDirField({
  id,
  describedBy,
  console: settings,
  save,
}: {
  id: string;
  describedBy: string | undefined;
  console: ConsoleSettings;
  save: (next: ConsoleSettings) => void;
}) {
  const t = useT();
  const saved = settings.gitDir ?? '';
  const [draft, setDraft] = useState<{ base: string; text: string }>({ base: saved, text: saved });
  // A change from elsewhere (another window) replaces an untouched draft.
  const text = draft.base === saved ? draft.text : saved;
  const trimmed = text.trim();
  // The Git folder exists only on Windows (the schema keeps it Windows-strict, WP-102).
  const invalid = trimmed !== '' && WIN32_PATHS.issue(trimmed) !== null;
  const commit = () => {
    if (invalid) return;
    const gitDir = trimmed === '' ? null : trimmed;
    if (gitDir !== settings.gitDir) save({ ...settings, gitDir });
  };
  return (
    <div className="grid gap-1">
      <Input
        id={id}
        aria-describedby={describedBy}
        aria-invalid={invalid || undefined}
        value={text}
        placeholder={t('preferences.console.gitDirPlaceholder')}
        spellCheck={false}
        onChange={(event) => {
          setDraft({ base: saved, text: event.target.value });
        }}
        onBlur={commit}
        onKeyDown={(event) => {
          if (event.key === 'Enter') commit();
        }}
      />
      {invalid ? (
        <p role="alert" className="text-destructive text-2xs">
          {t('preferences.console.gitDirInvalid')}
        </p>
      ) : null}
    </div>
  );
}

/**
 * Console (WP-97, ADR-238): the default shell of the header button and Alt+K, the window of Git
 * Bash (mintty like the Start menu entry, or bash in the default terminal of Windows) and an own
 * folder of Git for Windows with the detection result (`shell.detect`). Saved at once like the
 * other choices; a patch replaces the whole `console` object. WP-104: the shells of this computer
 * (`shell.detect.shells`, before the answer `shellKindsFor` of its platform); the Git Bash options
 * only on Windows.
 */
export function ConsoleSection({
  editor,
  hostState,
}: {
  editor: SettingsEditor;
  hostState?: HostState | null;
}) {
  const t = useT();
  const { settings, save } = editor;
  const consoleSettings = settings.console;
  const saveConsole = (next: ConsoleSettings) => {
    save({ console: next });
  };
  const detection = useGitDetection(consoleSettings.gitDir);
  const { flavor } = settingsHostOf(hostState);
  const windows = flavor === 'win32';
  const shells = shellChoices(flavor, detection.status === 'done' ? detection.shells : null);
  const shown = effectiveShell(consoleSettings.defaultShell, flavor, shells);
  const defaultKind = defaultShellFor(flavor);
  return (
    <SettingList>
      <SettingField
        name="defaultShell"
        label={t('preferences.console.defaultShell')}
        description={t('preferences.console.defaultShellHint')}
        below={({ id, labelId, describedBy }) => (
          <RadioGroup
            aria-labelledby={labelId}
            aria-describedby={describedBy}
            value={shown}
            onValueChange={(value) => {
              const shell = shellKindSchema.safeParse(value);
              if (shell.success) saveConsole({ ...consoleSettings, defaultShell: shell.data });
            }}
            className="grid gap-2"
          >
            {shells.map((option) => (
              <div key={option} className="flex items-center gap-2">
                <RadioGroupItem id={`${id}-${option}`} value={option} />
                <Label htmlFor={`${id}-${option}`} className="font-normal">
                  {t(`preferences.console.shells.${option}`)}
                </Label>
                {option === defaultKind ? (
                  <Badge variant="outline">{t('preferences.console.defaultBadge')}</Badge>
                ) : null}
              </div>
            ))}
          </RadioGroup>
        )}
      />
      {windows ? (
        <>
          <SettingField
            name="gitBashWindow"
            label={t('preferences.console.gitBashWindow')}
            description={t('preferences.console.gitBashWindowHint')}
            below={({ id, labelId, describedBy }) => (
              <RadioGroup
                aria-labelledby={labelId}
                aria-describedby={describedBy}
                value={consoleSettings.gitBashWindow}
                onValueChange={(value) => {
                  const choice = gitBashWindowSchema.safeParse(value);
                  if (choice.success) saveConsole({ ...consoleSettings, gitBashWindow: choice.data });
                }}
                className="grid gap-2"
              >
                {gitBashWindowSchema.options.map((option) => (
                  <div key={option} className="flex items-center gap-2">
                    <RadioGroupItem id={`${id}-${option}`} value={option} />
                    <Label htmlFor={`${id}-${option}`} className="font-normal">
                      {t(`preferences.console.windows.${option}`)}
                    </Label>
                  </div>
                ))}
              </RadioGroup>
            )}
          />
          <SettingField
            name="gitDir"
            label={t('preferences.console.gitDir')}
            description={t('preferences.console.gitDirHint')}
            below={({ id, describedBy }) => (
              <div className="grid gap-1.5">
                <GitDirField id={id} describedBy={describedBy} console={consoleSettings} save={saveConsole} />
                <GitDetectLine id={`${id}-detect`} detection={detection} />
              </div>
            )}
            labelFor
          />
        </>
      ) : null}
      <p className="text-muted-foreground text-xs leading-relaxed">{t('preferences.console.environment')}</p>
    </SettingList>
  );
}
