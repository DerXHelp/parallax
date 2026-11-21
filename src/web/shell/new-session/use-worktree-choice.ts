import { useState } from 'react';
import type { HostId } from '@shared/common';
import type { GitWorktree, ProjectSettingsMap } from '@shared/model';
import type { PathRules } from '@shared/paths';
import type { SessionWorktreeRequest } from '@shared/protocol';
import { useRepoWorktrees, type RepoLookup } from './use-repo-worktrees';
import {
  anyWorktreeDefault,
  defaultWorktreeBranch,
  mainWorktreeBranch,
  pickableWorktrees,
  projectSettingsFor,
  refIssue,
  worktreeRequest,
  type RefIssue,
  type WorktreeMode,
} from './worktree-lib';

/**
 * WP-114 (ADR-250): the worktree choice of "New session" – optional and quiet: the switch shows only
 * for a folder inside a git repository on a computer whose server has the git service
 * (`HostState.features.git`). Its default is the project's `worktreeDefault` (`settings.projects`),
 * else off. What the user changes is kept per repository: another folder of the same repository
 * keeps it, another repository starts from its own defaults again. The branch suggestion
 * (`parallax/<short id>`) is made once per opening.
 */
export interface WorktreeChoice {
  lookup: RepoLookup;
  /** The repository root (`worktree.list`); null = no repository (yet). */
  repoRoot: string | null;
  on: boolean;
  setOn: (on: boolean) => void;
  mode: WorktreeMode;
  setMode: (mode: WorktreeMode) => void;
  branch: string;
  setBranch: (branch: string) => void;
  /** '' = the server's default (the branch of the main worktree). */
  base: string;
  setBase: (base: string) => void;
  /** The branch of the main worktree (the base shown first); null = detached/unknown. */
  mainBranch: string | null;
  /** `existing`: the chosen worktree folder; null = none chosen yet. */
  path: string | null;
  setPath: (path: string) => void;
  /** Worktrees one may pick (not the main one, not detached). */
  pickable: readonly GitWorktree[];
  branchIssue: RefIssue | null;
  baseIssue: RefIssue | null;
  /** `session.create.worktree`: undefined = no worktree; null = switched on but not valid yet. */
  request: SessionWorktreeRequest | null | undefined;
  /** "Create" waits: the repository check runs while some project starts in a worktree by default. */
  waiting: boolean;
}

interface RepoChoices {
  repoRoot: string;
  on?: boolean;
  mode?: WorktreeMode;
  base?: string;
  path?: string;
}

const NO_WORKTREES: readonly GitWorktree[] = Object.freeze([]);

export function useWorktreeChoice({
  hostId,
  cwd,
  enabled,
  projects,
  rules,
  delayMs,
}: {
  hostId: HostId;
  /** The folder of the form, trimmed. */
  cwd: string;
  /** The computer has the git service, is online and the folder is a valid absolute path. */
  enabled: boolean;
  projects: ProjectSettingsMap;
  rules: PathRules;
  delayMs?: number;
}): WorktreeChoice {
  const lookup = useRepoWorktrees(hostId, cwd, enabled, delayMs);
  const [branch, setBranch] = useState(defaultWorktreeBranch);
  const [choices, setChoices] = useState<RepoChoices | null>(null);
  const repoRoot = lookup.status === 'repo' ? lookup.repoRoot : null;
  const worktrees = lookup.status === 'repo' ? lookup.worktrees : NO_WORKTREES;
  const stored = repoRoot !== null && choices?.repoRoot === repoRoot ? choices : null;
  const pickable = pickableWorktrees(worktrees);
  const mainBranch = mainWorktreeBranch(worktrees);
  const projectDefault =
    repoRoot === null ? false : (projectSettingsFor(projects, repoRoot, rules)?.worktreeDefault ?? false);
  const on = repoRoot !== null && (stored?.on ?? projectDefault);
  const mode: WorktreeMode = stored?.mode === 'existing' && pickable.length > 0 ? 'existing' : 'new';
  const base = stored?.base ?? mainBranch ?? '';
  const storedPath = stored?.path ?? null;
  const path =
    storedPath !== null && pickable.some((worktree) => worktree.path === storedPath) ? storedPath : null;

  const update = (patch: Omit<RepoChoices, 'repoRoot'>) => {
    if (repoRoot === null) return;
    setChoices((previous) => ({ ...(previous?.repoRoot === repoRoot ? previous : { repoRoot }), ...patch }));
  };

  let request: SessionWorktreeRequest | null | undefined;
  if (!on) request = undefined;
  else request = worktreeRequest({ mode, branch, base, path });

  return {
    lookup,
    repoRoot,
    on,
    setOn: (next) => {
      update({ on: next });
    },
    mode,
    setMode: (next) => {
      update({ mode: next });
    },
    branch,
    setBranch,
    base,
    setBase: (next) => {
      update({ base: next });
    },
    mainBranch,
    path,
    setPath: (next) => {
      update({ path: next });
    },
    pickable,
    branchIssue: on && mode === 'new' ? refIssue(branch) : null,
    baseIssue: on && mode === 'new' ? refIssue(base, true) : null,
    request,
    waiting: lookup.status === 'loading' && anyWorktreeDefault(projects),
  };
}
