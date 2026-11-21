import { FolderGit2Icon, LoaderCircleIcon } from 'lucide-react';
import { useEffect, useId, useMemo, useState } from 'react';
import { LIMITS, LOCAL_HOST_ID, type HostId } from '@shared/common';
import {
  DEFAULT_PROJECT_SETTINGS,
  shellKindSchema,
  type HostState,
  type ProjectSettings,
  type ProjectSettingsMap,
  type ShellKind,
} from '@shared/model';
import type { PathRules } from '@shared/paths';
import { useT } from '@web/i18n';
import { effectiveShell, shellChoices } from '@web/lib/shells';
import {
  distinctRoots,
  foldersToResolve,
  knownProjectRoots,
  sortProjectRoots,
  type ProjectSource,
} from '@web/shell/new-session/project-roots';
import { projectKeyFor, projectSettingsFor } from '@web/shell/new-session/worktree-lib';
import { useConnectionStatus, useHostStates, useSummaries } from '@web/state/hooks';
import { sendHostCommand } from '@web/state/hosts';
import { Badge } from '@web/ui/badge';
import { Button } from '@web/ui/button';
import { Disclosure } from '@web/ui/disclosure';
import { Label } from '@web/ui/label';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@web/ui/select';
import { Switch } from '@web/ui/switch';
import { Textarea } from '@web/ui/textarea';
import { settingsHostOf } from '../lib/host-platform';
import type { SettingsEditor } from '../state/settings-editor';

export interface ProjectsSectionProps {
  editor: SettingsEditor;
  hostState: HostState | null;
  /**
   * The computer whose settings the page edits. Missing: the host whose state is `hostState`
   * (looked up in the store), else this computer.
   */
  hostId?: HostId;
}

/** Select value of "like the setting Console" (`ProjectSettings.shell: null`). */
const DEFAULT_SHELL = 'default';

/** The settings equal the defaults: the project is dropped from `settings.projects`. */
function isDefault(project: ProjectSettings): boolean {
  return (
    project.setup.trim() === '' &&
    project.teardown.trim() === '' &&
    project.shell === null &&
    !project.ports &&
    !project.worktreeDefault
  );
}

/**
 * The whole map with `root` replaced by `next` (an existing spelling of the key wins; defaults remove
 * the entry) – a `settings.update` replaces the field `projects` as a whole.
 */
export function withProject(
  projects: ProjectSettingsMap,
  root: string,
  next: ProjectSettings | null,
  rules: PathRules,
): ProjectSettingsMap {
  const key = projectKeyFor(projects, root, rules);
  const rest = Object.fromEntries(Object.entries(projects).filter(([name]) => name !== key));
  if (next === null || isDefault(next)) return rest;
  return { ...rest, [key]: next };
}

/** The host id of the page: given, else the host whose state object this is, else this computer. */
function useSettingsHostId(hostState: HostState | null, given: HostId | undefined): HostId {
  const states = useHostStates();
  if (given !== undefined) return given;
  const found = Object.entries(states).find(([, state]) => state === hostState);
  return found?.[0] ?? LOCAL_HOST_ID;
}

/** `shell.detect` of the computer (its installed shells); null until answered or when refused. */
function useDetectedShells(hostId: HostId, enabled: boolean): readonly ShellKind[] | null {
  const [answer, setAnswer] = useState<{ hostId: HostId; shells: readonly ShellKind[] | null } | null>(null);
  useEffect(() => {
    if (!enabled) return;
    let active = true;
    sendHostCommand(hostId, { name: 'shell.detect' }).then(
      (result) => {
        if (active) setAnswer({ hostId, shells: result.shells });
      },
      () => {
        if (active) setAnswer({ hostId, shells: null });
      },
    );
    return () => {
      active = false;
    };
  }, [hostId, enabled]);
  return answer?.hostId === hostId ? answer.shells : null;
}

/**
 * The repositories of session folders (`worktree.list`, one after the other, a folder inside a root
 * found before is skipped). `scanning` until all are asked.
 */
function useResolvedRoots(
  hostId: HostId,
  folders: readonly string[],
  rules: PathRules,
  enabled: boolean,
): { roots: readonly string[]; scanning: boolean } {
  const foldersKey = folders.join('\n');
  const key = enabled && foldersKey !== '' ? `${hostId}\n${foldersKey}` : null;
  const [state, setState] = useState<{ key: string; roots: readonly string[]; done: boolean } | null>(null);
  useEffect(() => {
    if (key === null) return;
    const run = { active: true };
    const list = foldersKey.split('\n');
    const scan = async (): Promise<void> => {
      const found: string[] = [];
      for (const cwd of list) {
        if (found.some((root) => rules.isInside(cwd, root))) continue;
        try {
          const result = await sendHostCommand(hostId, { name: 'worktree.list', cwd });
          if (result.repoRoot !== null) found.push(result.repoRoot);
        } catch {
          // Not a repository any more (or gone): nothing to list.
        }
        if (!run.active) return;
        setState({ key, roots: [...found], done: false });
      }
      if (run.active) setState({ key, roots: found, done: true });
    };
    void scan();
    return () => {
      run.active = false;
    };
  }, [key, hostId, foldersKey, rules]);
  if (key === null) return { roots: [], scanning: false };
  if (state?.key !== key) return { roots: [], scanning: true };
  return { roots: state.roots, scanning: !state.done };
}

/** A command field saved on blur (a change from elsewhere replaces an untouched draft). */
function CommandField({
  id,
  describedBy,
  value,
  placeholder,
  onCommit,
}: {
  id: string;
  describedBy: string;
  value: string;
  placeholder: string;
  onCommit: (value: string) => void;
}) {
  const [draft, setDraft] = useState<{ base: string; text: string }>({ base: value, text: value });
  const text = draft.base === value ? draft.text : value;
  return (
    <Textarea
      id={id}
      aria-describedby={describedBy}
      value={text}
      rows={2}
      maxLength={LIMITS.projectCommandChars}
      spellCheck={false}
      autoComplete="off"
      placeholder={placeholder}
      className="max-h-40 min-h-10 font-mono text-xs"
      onChange={(event) => {
        setDraft({ base: value, text: event.target.value });
      }}
      onBlur={() => {
        if (text !== value) onCommit(text);
      }}
    />
  );
}

function ProjectRow({
  root,
  name,
  project,
  configured,
  shells,
  defaultShellLabel,
  onSave,
  onReset,
}: {
  root: string;
  /** The repository's folder name. */
  name: string;
  project: ProjectSettings;
  configured: boolean;
  shells: readonly ShellKind[];
  defaultShellLabel: string;
  onSave: (next: ProjectSettings) => void;
  onReset: () => void;
}) {
  const t = useT();
  const id = useId();
  const badges: string[] = [];
  if (project.setup.trim() !== '') badges.push(t('preferences.projects.badges.setup'));
  if (project.teardown.trim() !== '') badges.push(t('preferences.projects.badges.teardown'));
  if (project.ports) badges.push(t('preferences.projects.badges.ports'));
  if (project.worktreeDefault) badges.push(t('preferences.projects.badges.worktreeDefault'));
  const shellValue = project.shell ?? DEFAULT_SHELL;
  return (
    <li data-project={root} className="rounded-md border px-2 py-1.5">
      <Disclosure
        header={
          <span className="flex min-w-0 flex-1 flex-wrap items-center gap-x-2 gap-y-0.5">
            <FolderGit2Icon aria-hidden className="text-muted-foreground size-3.5 shrink-0" />
            <span className="text-xs font-medium">{name}</span>
            <span className="text-muted-foreground min-w-0 truncate font-mono text-2xs" title={root}>
              {root}
            </span>
            {badges.map((badge) => (
              <Badge key={badge} variant="outline">
                {badge}
              </Badge>
            ))}
          </span>
        }
        contentClassName="grid gap-3 px-1 pt-2.5 pb-1"
      >
        <div className="grid gap-1">
          <Label htmlFor={`${id}-setup`}>{t('preferences.projects.setup')}</Label>
          <CommandField
            id={`${id}-setup`}
            describedBy={`${id}-setup-hint`}
            value={project.setup}
            placeholder={t('preferences.projects.setupPlaceholder')}
            onCommit={(setup) => {
              onSave({ ...project, setup });
            }}
          />
          <p id={`${id}-setup-hint`} className="text-muted-foreground text-2xs leading-relaxed">
            {t('preferences.projects.setupHint')}
          </p>
        </div>
        <div className="grid gap-1">
          <Label htmlFor={`${id}-teardown`}>{t('preferences.projects.teardown')}</Label>
          <CommandField
            id={`${id}-teardown`}
            describedBy={`${id}-teardown-hint`}
            value={project.teardown}
            placeholder={t('preferences.projects.teardownPlaceholder')}
            onCommit={(teardown) => {
              onSave({ ...project, teardown });
            }}
          />
          <p id={`${id}-teardown-hint`} className="text-muted-foreground text-2xs leading-relaxed">
            {t('preferences.projects.teardownHint')}
          </p>
        </div>
        <div className="flex flex-wrap items-center justify-between gap-2">
          <Label htmlFor={`${id}-shell`}>{t('preferences.projects.shell')}</Label>
          <Select
            value={shellValue}
            onValueChange={(value) => {
              if (value === DEFAULT_SHELL) {
                onSave({ ...project, shell: null });
                return;
              }
              const shell = shellKindSchema.safeParse(value);
              if (shell.success) onSave({ ...project, shell: shell.data });
            }}
          >
            <SelectTrigger id={`${id}-shell`} data-action="project-shell" className="w-56 justify-between">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value={DEFAULT_SHELL}>{defaultShellLabel}</SelectItem>
              {shells.map((shell) => (
                <SelectItem key={shell} value={shell}>
                  {t(`preferences.console.shells.${shell}`)}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
        <div className="flex items-start justify-between gap-4">
          <div className="grid gap-0.5">
            <Label htmlFor={`${id}-ports`}>{t('preferences.projects.ports')}</Label>
            <p id={`${id}-ports-hint`} className="text-muted-foreground text-2xs leading-relaxed">
              {t('preferences.projects.portsHint')}
            </p>
          </div>
          <Switch
            id={`${id}-ports`}
            aria-describedby={`${id}-ports-hint`}
            checked={project.ports}
            onCheckedChange={(ports) => {
              onSave({ ...project, ports });
            }}
          />
        </div>
        <div className="flex items-start justify-between gap-4">
          <div className="grid gap-0.5">
            <Label htmlFor={`${id}-worktree`}>{t('preferences.projects.worktreeDefault')}</Label>
            <p id={`${id}-worktree-hint`} className="text-muted-foreground text-2xs leading-relaxed">
              {t('preferences.projects.worktreeDefaultHint')}
            </p>
          </div>
          <Switch
            id={`${id}-worktree`}
            aria-describedby={`${id}-worktree-hint`}
            checked={project.worktreeDefault}
            onCheckedChange={(worktreeDefault) => {
              onSave({ ...project, worktreeDefault });
            }}
          />
        </div>
        {configured ? (
          <div>
            <Button variant="ghost" size="sm" data-action="project-reset" onClick={onReset}>
              {t('preferences.projects.reset')}
            </Button>
          </div>
        ) : null}
      </Disclosure>
    </li>
  );
}

/**
 * Section "Projects" (WP-114, ADR-250/251): per git repository the setup and teardown commands of new
 * worktrees, their shell (default: the setting "Console"), the port block (`PARALLAX_WORKTREE_PORT`)
 * and whether "New session" starts in a worktree by default – all optional, explained at the top.
 * The list: the projects of `settings.projects`, the repositories of worktree sessions and – asked
 * from git one after the other (`worktree.list`) – of the other session folders of this computer.
 * Also for another computer at the level "Manage" (the commands run there). Commands are saved on
 * blur, switches and the shell at once; every save replaces the whole field `projects`, a project
 * back at the defaults leaves the map. Without the git service of the host: only a hint.
 */
export function ProjectsSection({ editor, hostState, hostId: givenHostId }: ProjectsSectionProps) {
  const t = useT();
  const hostId = useSettingsHostId(hostState, givenHostId);
  const { settings, save } = editor;
  const { flavor, rules } = settingsHostOf(hostState);
  const gitService = hostState?.features.git === true;
  const online = useConnectionStatus(hostId) === 'open';
  const entries = useSummaries();
  const sessions = useMemo<ProjectSource[]>(
    () =>
      entries
        .filter((entry) => entry.hostId === hostId)
        .map(({ summary }) => ({
          cwd: summary.cwd,
          worktree: summary.worktree,
          lastActivityAt: summary.lastActivityAt,
        })),
    [entries, hostId],
  );
  const projects = settings.projects;
  // Cheap per render (at most a few hundred sessions); `useResolvedRoots` keys on the folder text.
  const known = knownProjectRoots(Object.keys(projects), sessions, rules);
  const folders = foldersToResolve(sessions, known, rules);
  const resolved = useResolvedRoots(hostId, folders, rules, gitService && online);
  const roots = sortProjectRoots(distinctRoots([...known, ...resolved.roots], rules), rules);
  const detected = useDetectedShells(hostId, gitService && online);
  const shells = shellChoices(flavor, detected);
  const consoleShell = effectiveShell(settings.console.defaultShell, flavor, shells);
  const defaultShellLabel = t('preferences.projects.shellDefault', {
    shell: t(`preferences.console.shells.${consoleShell}`),
  });

  if (!gitService) {
    return (
      <p data-slot="projects-unavailable" className="text-muted-foreground text-xs">
        {t('preferences.projects.unavailable')}
      </p>
    );
  }

  const saveProject = (root: string, next: ProjectSettings | null) => {
    save({ projects: withProject(settings.projects, root, next, rules) });
  };

  return (
    <div className="grid gap-4" data-slot="projects-section">
      <div className="text-muted-foreground grid gap-1.5 text-xs leading-relaxed">
        <p>{t('preferences.projects.intro')}</p>
        <p>{t('preferences.projects.commandsNote')}</p>
        <p>{t('preferences.projects.portsNote')}</p>
      </div>
      {resolved.scanning ? (
        <p data-slot="projects-scanning" className="text-muted-foreground flex items-center gap-1.5 text-2xs">
          <LoaderCircleIcon aria-hidden className="size-3 shrink-0 motion-safe:animate-spin" />
          {t('preferences.projects.scanning')}
        </p>
      ) : null}
      {roots.length === 0 && !resolved.scanning ? (
        <p data-slot="projects-empty" className="text-muted-foreground text-xs">
          {t('preferences.projects.empty')}
        </p>
      ) : null}
      {roots.length === 0 ? null : (
        <ul aria-label={t('preferences.projects.list')} className="grid gap-1.5">
          {roots.map((root) => {
            const stored = projectSettingsFor(projects, root, rules);
            return (
              <ProjectRow
                key={rules.key(root)}
                root={root}
                name={rules.baseName(root) || root}
                project={stored ?? DEFAULT_PROJECT_SETTINGS}
                configured={stored !== null}
                shells={shells}
                defaultShellLabel={defaultShellLabel}
                onSave={(next) => {
                  saveProject(root, next);
                }}
                onReset={() => {
                  saveProject(root, null);
                }}
              />
            );
          })}
        </ul>
      )}
    </div>
  );
}
