/**
 * Texts of namespace `worktrees` (WP-114; registered in src/web/i18n/dictionaries.ts): the worktree
 * notice of a session (being created, setup running or failed) and the cleanup dialog when a worktree
 * session is archived or removed. Same syntax as the shell dictionaries (`{name}` placeholders,
 * `{ one, other }` plurals), `de.ts` has exactly this shape.
 */
export const en = {
  title: 'Worktree',
  /** The worktree of a session in short: its branch and – with a port block – its ports. */
  identity: {
    branch: 'Worktree {branch}',
    ports: 'ports {from}–{to}',
  },
  /** Slot `WorktreeNotice` below the pane banners (`SessionSummary.worktreeSetup`). */
  notice: {
    creating: 'Creating the worktree…',
    setup: 'The project’s setup command is running…',
    setupHint: 'Your first message can go once it is done.',
    failed: 'The setup command failed (exit code {code}).',
    stopped: 'The setup command was stopped.',
    failedHint: 'Look at its output, fix the cause or start the session anyway.',
    createFailed: 'The worktree could not be created.',
    createFailedHint: 'The transcript says why. Archive or remove the session and try again.',
    showOutput: 'Show output',
    startAnyway: 'Start anyway',
  },
  /** Slot `WorktreeCleanup`: archive or remove a session that runs in its own worktree. */
  cleanup: {
    titleArchive: 'Archive “{title}”?',
    titleRemove: 'Remove “{title}” from Parallax?',
    description: 'This session runs in a worktree of its own. Choose what happens to its folder and branch.',
    descriptionRemove:
      'The session disappears from Parallax; its Claude Code transcript stays on disk. Choose what happens to the worktree’s folder and branch.',
    facts: 'The worktree',
    folder: 'Folder: {folder}',
    checking: 'Checking for open work…',
    checkFailed: 'The worktree could not be checked.',
    dirty: { one: '{count} file with uncommitted changes', other: '{count} files with uncommitted changes' },
    clean: 'No uncommitted changes',
    unpushed: {
      one: '{count} commit that is in no remote branch',
      other: '{count} commits that are in no remote branch',
    },
    pushed: 'No commits that exist only here',
    merged: 'The branch is merged into {base}',
    notMerged: 'The branch is not merged into {base}',
    optionsLabel: 'What happens to the worktree',
    options: {
      keep: 'Keep the worktree',
      worktree: 'Delete the worktree, keep the branch',
      all: 'Delete the worktree and the branch',
    },
    optionHints: {
      keep: 'Folder and branch stay as they are – you can go on there later.',
      worktree: 'The folder goes; the commits stay on the branch.',
      all: 'Folder and branch go.',
    },
    confirmLoss: 'Yes, discard the open work ({list}).',
    lossFiles: { one: '{count} changed file', other: '{count} changed files' },
    lossCommits: { one: '{count} commit', other: '{count} commits' },
    teardown: 'The project’s teardown command runs first – visible in a terminal tab of the session.',
    steps: {
      close: 'Closing the session…',
      remove: 'Deleting the worktree…',
      archive: 'Archiving…',
      removeSession: 'Removing…',
    },
    dirtyError: 'The worktree has open work: {list}.',
    teardownFailed: 'The teardown command failed (exit code {code}).',
    teardownStopped: 'The teardown command was stopped.',
    deleteAnyway: 'Delete anyway',
    showOutput: 'Show output',
    worktreeGone: 'The worktree is deleted – only the session step is left.',
    cancel: 'Cancel',
    confirmArchive: 'Archive',
    confirmRemove: 'Remove',
  },
};
