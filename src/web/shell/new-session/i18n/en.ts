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
    hint: 'Full path of an existing folder – type or paste it, or browse.',
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
      'Enter or double-click opens a folder, Backspace goes up. “Choose this folder” takes the folder that is open.',
    up: 'Up one level',
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
    nothingChosen: 'Open a drive or folder to choose it.',
    choose: 'Choose this folder',
  },
};
