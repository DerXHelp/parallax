/**
 * Texts of namespace `updates` (WP-88a; registered in src/web/i18n/dictionaries.ts). Same syntax as
 * the shell dictionaries (`{name}` placeholders, `{ one, other }` plurals); `de.ts` has exactly this
 * shape. The general error texts (`errors.UPDATE_*`) have no placeholders – `detail` adds one line
 * from the error's params (lib/error-detail.ts).
 */
export const en = {
  title: 'Updates',
  /** Head of the sidebar (slot `UpdateNotice`). */
  notice: {
    available: 'Parallax {version} available',
    ready: 'Parallax {version} ready – restart',
    dismiss: 'Hide this update hint',
  },
  /** Strip above the session area (slot `UpdateBanner`). */
  banner: {
    updated: 'Updated to Parallax {to}',
    /** `to` is older than `from` (a rollback or an older package). */
    changed: 'Switched to Parallax {to} (was {from})',
    failed: 'Update to Parallax {version} failed – back on {restoredTo}',
    log: 'Log file',
    copyLog: 'Copy log path',
    copied: 'Log path copied.',
    copyFailed: 'The log path could not be copied.',
  },
  /** Settings section `updates` (slot `UpdatesSettings`). */
  settings: {
    installed: 'Installed version',
    version: 'Parallax {version}',
    buildId: 'Build {buildId}',
    development: 'Development build {buildId} – updates via git',
    developmentHint: 'This copy runs from a checkout. Update it with git pull; the app has no update here.',
    lastChecked: 'Last checked {time}.',
    neverChecked: 'Not checked yet.',
    released: 'Released {date}',
    fromFile: 'From a file, built {date}',
    downgrade: 'This version is older than the installed {current}.',
    progress: 'Progress',
    checkNow: 'Check now',
    checking: 'Checking…',
    prepare: 'Prepare update',
    restart: 'Restart now',
    rollback: 'Back to {version}',
    rollbackLoss: 'Going back restores the backup of {date}: changes since then will be lost.',
    rollbackBlocked: 'Going back to {version} needs a backup, and there is none.',
    installFile: 'Install from file…',
    uploading: 'Uploading…',
    uploaded: 'Package received – it is being checked.',
    uploadFailed: 'The package could not be installed.',
    commandFailed: 'That did not work.',
    autoCheck: 'Check for updates automatically',
    autoCheckHint: 'At start and every 12 hours. Check now works either way.',
    autoCheckFailed: 'The setting could not be saved.',
    whatsNew: 'What’s new',
    whatsNewIn: 'What’s new in {version}',
    license: 'License',
    thirdParty: 'Third-party notices',
    links: 'About this version',
  },
  status: {
    idle: 'Parallax is up to date.',
    checking: 'Checking for updates…',
    available: 'Parallax {version} is available.',
    downloading: 'Downloading Parallax {version}…',
    preparing: 'Preparing Parallax {version}…',
    preparingFile: 'Checking the package…',
    ready: 'Parallax {version} is ready. Restart to switch.',
    readyFile: 'Parallax {version} from a file is ready. Restart to switch.',
    restarting: 'Parallax is restarting…',
    lastError: 'The last update step failed.',
  },
  /** Confirmation of "Restart now" / "Back to <version>". */
  confirm: {
    applyTitle: 'Restart Parallax now?',
    rollbackTitle: 'Go back to Parallax {version}?',
    description:
      'Parallax switches to {version} and restarts. Every Claude session of this server is stopped; this window reconnects by itself and the sessions can be resumed.',
    working: 'Working ({count})',
    waiting: 'Waiting for you ({count})',
    waitingHint:
      'Open permissions, questions and plans expire; a plan can be approved after the restart (“Resume”).',
    idle: {
      one: '{count} idle session (no running work) will be closed.',
      other: '{count} idle sessions (no running work) will be closed.',
    },
    nothingRunning: 'No session is running – nothing will be interrupted.',
    dataLossTitle: 'Changes since {date} will be lost',
    dataLossDescription:
      'Version {version} stores data differently. Parallax restores the backup made at that time; sessions, settings and profiles changed since then go back to that state.',
    dataLossAccept: 'I understand – restore the backup',
    noBackup: 'There is no backup for this switch, so it is not possible.',
    notConnected: 'Not connected to the server.',
    failed: 'The switch could not be started.',
    applyConfirm: 'Restart now',
    rollbackConfirm: 'Go back',
    restarting: 'Restarting…',
  },
  /** Dialog "What's new" (CHANGELOG.md sections, rendered as Markdown). */
  whatsNew: {
    title: 'What’s new',
    description: 'Changes in Parallax {version}',
    loading: 'Loading the release notes…',
    unreleased: 'Unreleased',
    section: 'Version {version}',
    sectionDated: 'Version {version} – {date}',
    empty: 'No notes for this version.',
    failed: 'The release notes could not be loaded.',
  },
  /** Dialog for LICENSE / THIRD_PARTY_NOTICES.md. */
  notices: {
    license: 'License',
    thirdParty: 'Third-party notices',
    licenseDescription: 'The license of Parallax.',
    thirdPartyDescription: 'Licenses of the components that come with Parallax.',
    loading: 'Loading…',
    failed: 'The file could not be loaded.',
  },
  /** One translated line from the params of an update error (lib/error-detail.ts). */
  detail: {
    check: {
      network: 'No connection to GitHub.',
      timeout: 'GitHub did not answer in time.',
      http: 'GitHub answered with HTTP {status}.',
      too_large: 'The release information is too large.',
      schema: 'The release information is not readable.',
      url: 'The release points to an unexpected address.',
    },
    download: {
      network: 'The connection broke off.',
      timeout: 'The download took too long.',
      http: 'The server answered with HTTP {status}.',
      size: 'The file has the wrong size.',
      hash: 'The file does not match its checksum.',
      disk: 'The file could not be written to disk.',
    },
    httpError: 'The server answered with an error.',
    signature: 'Affected file: {file}',
    package: {
      zip: 'The file is not a readable zip archive.',
      layout: 'The archive does not have the layout of a Parallax package.',
      files: 'Files in the package are missing or changed.',
      version: 'The version inside the package does not match.',
      same_version: 'This version is already installed.',
      too_large: 'The package is too large.',
    },
    busy: {
      checking: 'A check is running right now.',
      downloading: 'A download is running right now.',
      preparing: 'A preparation is running right now.',
      restarting: 'Parallax is restarting right now.',
      locked: 'An installer or another update is using the installation folder right now.',
    },
    nodeTooOld: 'Needs Node.js {required}; installed is {actual}.',
    downgradeBlocked:
      'Version {version} stores data differently, and there is no backup to go back to. Install it with install.cmd if you need it.',
    restart: {
      spawn: 'The switch could not be started.',
      handshake: 'The switch did not report back in time.',
      lock: 'Parallax did not release its data in time.',
      package: 'The prepared version is damaged.',
      backup: 'The backup before the switch failed.',
      port: 'The port was taken by another program.',
      timeout: 'The new version did not start in time.',
      exited: 'The new version stopped right after its start.',
      store_too_new: 'The data were written by a newer Parallax.',
    },
    version: 'The offered version changed in the meantime – check again.',
    dataLoss: 'Confirm first that changes since the backup will be lost.',
  },
};
