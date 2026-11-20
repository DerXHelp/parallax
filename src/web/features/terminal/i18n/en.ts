/**
 * Lazy namespace of the embedded terminal (WP-99b): every text of the side panel tab "Terminal". Only
 * the lazy panel chunk imports it, so English and German come with that chunk, never with the start
 * chunk (pattern of WP-67 `useInfoT`). Keys without a namespace prefix: `tt('exit.restart')`. Error
 * codes (`TERMINAL_*`) are translated by `tError` from `src/web/i18n/errors.*`.
 */
export const en = {
  panel: {
    /** Accessible name of the panel region. */
    label: 'Terminals',
    connecting: 'Connecting to the terminal…',
    reconnecting: 'Connection to the terminal lost – reconnecting…',
    /** Close code 4404: `hello` named an entry this computer does not know. */
    entryNotFound: 'This session is not known on this computer.',
    /** Close code 4426: protocol version not supported. */
    protocol: 'The terminal service of this computer speaks another version. Reload the window.',
    /** `{shell}` = `shells.*`. */
    starting: 'Starting {shell}…',
    dismiss: 'Dismiss',
  },
  /** Menu texts of the shells (like the console button of the header). */
  shells: {
    cmd: 'Command Prompt (cmd)',
    powershell: 'PowerShell',
    gitbash: 'Git Bash',
  },
  /** Short shell names in the tabs. */
  short: {
    cmd: 'cmd',
    powershell: 'PowerShell',
    gitbash: 'Git Bash',
  },
  tabs: {
    label: 'Terminals of this session',
    /** `{shell}` = `short.*`, `{number}` counts per shell (cmd 1, cmd 2, PowerShell 1). */
    name: '{shell} {number}',
    /** Accessible name of the tab of an exited terminal. */
    exited: '{name} (exited)',
    close: 'Close {name}',
  },
  add: {
    label: 'New terminal',
    default: 'Default',
    limit: 'At most {max} terminals per session',
  },
  empty: {
    title: 'No terminal open',
    hint: 'Start a shell in the folder of this session.',
  },
  exit: {
    code: 'Exited with code {code}',
    unknown: 'Exited',
    failed: 'The shell could not be started.',
    restart: 'Restart',
    close: 'Close',
  },
  menu: {
    copy: 'Copy',
    paste: 'Paste',
    selectAll: 'Select all',
    clear: 'Clear',
    restart: 'Restart',
    close: 'Close terminal',
    screenReader: 'Screen reader mode',
    pasteFailed: 'Parallax may not read the clipboard here. Paste with Ctrl+V.',
  },
  view: {
    /** Accessible name of one terminal (`{name}` = `tabs.name`). */
    label: 'Terminal {name}',
  },
};
