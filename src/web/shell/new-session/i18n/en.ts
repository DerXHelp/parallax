import type { EffortLevel } from '@shared/common';
import type { ProfileArgInvalidReason } from '@shared/errors';

/**
 * English texts of namespace `newSession` – WP-36 ("New session" dialog, folder browser, profile
 * choice and the shared profile status/finding texts). Same syntax as the shell dictionaries
 * (`{name}` placeholders, `{ one, other }` plurals); a namespace object never uses the key `other`.
 */
export const en = {
  title: 'New session',
  description: 'Choose the project folder and the profile. Claude starts with your first message.',
  cwd: {
    label: 'Project folder',
    placeholder: 'D:\\work\\my-project',
    /** WP-104: the placeholder for a folder on a Linux computer. */
    placeholderPosix: '/home/me/my-project',
    hint: 'Full path of an existing folder – type or paste it, or browse. There you can also create a new one.',
    browse: 'Browse…',
  },
  recent: {
    label: 'Recent projects',
  },
  profile: {
    label: 'Profile',
    none: 'No profile available',
    defaultBadge: 'Default',
    unusable: 'This profile cannot start sessions:',
    unusableShort: {
      one: '{count} error – cannot be used',
      other: '{count} errors – cannot be used',
    },
    defaults: 'Profile defaults: {list}',
    defaultModel: 'model {model}',
    defaultMode: 'mode {mode}',
    defaultEffort: 'effort {effort}',
  },
  efforts: {
    low: 'Low',
    medium: 'Medium',
    high: 'High',
    xhigh: 'Extra high',
    max: 'Max',
  } satisfies Record<EffortLevel, string>,
  submit: 'Create session',
  creating: 'Creating…',
  /** Claude Code of a profile (`ProfileSummary.claude`). */
  status: {
    checking: 'Checking Claude Code…',
    notFound: 'Claude Code not found',
    error: 'Claude Code could not be checked',
    tooOld: 'Claude Code {version} – too old, update it',
    loggedOut: 'Claude Code {version} – not signed in',
    authError: 'Claude Code {version} – sign-in unknown',
    ready: 'Claude Code {version}',
    readyPlan: 'Claude Code {version} · {plan}',
    readyNoVersion: 'Claude Code ready',
    /** WP-62: ready, but newer than the version tested with Parallax (a hint, not a warning). */
    untested: 'Claude Code {version} – newer than tested ({tested})',
    untestedPlan: 'Claude Code {version} · {plan} – newer than tested ({tested})',
  },
  /** Findings of the profile check (ProfileIssue): level word and details. Never env values. */
  issues: {
    levels: {
      error: 'Error:',
      warning: 'Warning:',
      info: 'Note:',
    },
    argInvalid: {
      missing_value: '{flag} needs a value – on the next line or as {flag}=value.',
      unexpected_value: '{flag} takes no value.',
      duplicate: '{flag} may appear only once.',
      invalid_value: 'The value of {flag} is not valid.',
      not_a_flag: 'This line is neither an argument nor the value of one: {flag}',
    } satisfies Record<ProfileArgInvalidReason, string>,
    argBlocked: '{flag} is controlled by Parallax itself.',
    argNotAllowed: '{flag} is not a known argument. Switch on “pass through unchecked” to allow it.',
    argPassedRaw: '{flag} is passed to Claude Code unchecked.',
    argResumeNoEffect: '{flag} only takes effect in new sessions, not in resumed ones.',
    bypass: '{flag} lets Claude Code act without asking for permission.',
    broadTools: 'Allowed without asking: {value}',
    configDir: 'Network, device and reserved paths cannot be used as config folder.',
    executable: {
      not_absolute: 'Enter a full path such as C:\\Users\\me\\.local\\bin\\claude.exe.',
      /** WP-104: the same on a Linux computer. */
      not_absolute_posix: 'Enter a full path such as /home/me/.local/bin/claude.',
      not_exe: 'The path must end in .exe.',
      unsafe: 'Network, device and reserved paths cannot be used.',
      not_found: 'There is no file at this path.',
    },
    envRef: 'The variable {name} (used in {key}) is not set on this computer.',
    envInvalid: 'The value of {key} cannot be set (it contains a NUL character).',
  },
  browser: {
    title: 'Choose a folder',
    description:
      'A click selects a folder, Enter or double-click opens it, Backspace goes up. “Choose this folder” takes the selected folder – or the open one when none is selected.',
    up: 'Up one level',
    newFolder: 'New folder',
    newFolderName: 'Name of the new folder in {path}',
    newFolderPlaceholder: 'Folder name',
    create: 'Create',
    nameIssues: {
      tooLong: 'The name is too long (at most {count} characters).',
      invalidChar: 'A folder name cannot contain \\ / : * ? " < > | or control characters.',
      dots: 'The name cannot be “.” or “..”.',
      trailingDot: 'The name cannot end with a dot.',
      reserved: 'Windows reserves this name (CON, NUL, COM1 …).',
    },
    location: 'Location',
    roots: 'This PC',
    showHidden: 'Show hidden folders',
    list: 'Folders in {path}',
    listRoots: 'Drives and user folder',
    kinds: {
      drive: 'Drive',
      home: 'User folder',
      directory: 'Folder',
      link: 'Link',
    },
    hidden: 'Hidden',
    empty: 'No subfolders.',
    emptyRoots: 'No drives found.',
    loading: 'Loading folders…',
    truncated: 'Only the first {count} folders are shown.',
    nothingChosen: 'Select or open a drive or folder to choose it.',
    choose: 'Choose this folder',
    /** WP-104: the texts that differ on a Linux computer (roots: `/`, home, mounted media). */
    posix: {
      roots: 'Computer',
      listRoots: 'Places',
      emptyRoots: 'No places found.',
      nothingChosen: 'Select or open a place or folder to choose it.',
      tooLong: 'The name is too long (at most {count} bytes).',
      invalidChar: 'A folder name cannot contain / or control characters.',
    },
  },
};
