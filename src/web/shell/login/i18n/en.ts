/**
 * Lazy namespace of the sign-in dialog (WP-70): the texts come with the dialog's lazy chunk, never
 * with the start chunk (start-chunk budget; pattern of WP-67 `useInfoT`). The button "Sign in"
 * itself is `navigation.actions.signIn` (start chunk). Keys without a namespace prefix:
 * `lt('waiting')`.
 */
export const en = {
  title: 'Sign in · {profile}',
  description: 'Signs in Claude Code for this profile – like /login in a terminal.',
  starting: 'Starting the sign-in…',
  waiting: 'The sign-in page is open in your browser – waiting for it to finish…',
  openAgain: 'Open link again',
  copy: 'Copy link',
  copied: 'Link copied.',
  copyFailed: 'The link could not be copied.',
  codeLabel: 'Paste code',
  codeHint: 'If the browser shows a code, paste it here.',
  codePlaceholder: 'Code from the browser',
  submit: 'Sign in',
  verifying: 'Checking the code…',
  done: 'Signed in ({plan})',
  doneNoPlan: 'Signed in',
  doneHint: 'New turns use the new sign-in.',
  failed: 'The sign-in did not work',
  refused: 'Parallax could not do this',
  retry: 'Try again',
  cancel: 'Cancel',
  close: 'Close',
};
