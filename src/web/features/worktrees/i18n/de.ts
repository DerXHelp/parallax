import type { en } from './en';

/** German texts of namespace `worktrees` (same shape as en.ts). */
export const de: typeof en = {
  title: 'Worktree',
  identity: {
    branch: 'Worktree {branch}',
    ports: 'Ports {from}–{to}',
  },
  notice: {
    creating: 'Worktree wird angelegt…',
    setup: 'Der Setup-Befehl des Projekts läuft…',
    setupHint: 'Deine erste Nachricht kann raus, sobald er fertig ist.',
    failed: 'Der Setup-Befehl ist fehlgeschlagen (Exit-Code {code}).',
    stopped: 'Der Setup-Befehl wurde abgebrochen.',
    failedHint: 'Sieh dir die Ausgabe an, behebe die Ursache oder starte die Session trotzdem.',
    createFailed: 'Der Worktree konnte nicht angelegt werden.',
    createFailedHint:
      'Der Grund steht im Verlauf. Archiviere oder entferne die Session und versuche es erneut.',
    showOutput: 'Ausgabe ansehen',
    startAnyway: 'Trotzdem starten',
  },
  cleanup: {
    titleArchive: '„{title}“ archivieren?',
    titleRemove: '„{title}“ aus Parallax entfernen?',
    description: 'Diese Session läuft in einem eigenen Worktree. Wähle, was mit Ordner und Branch passiert.',
    descriptionRemove:
      'Die Session verschwindet aus Parallax; ihr Claude-Code-Verlauf bleibt auf der Platte. Wähle, was mit Ordner und Branch des Worktrees passiert.',
    facts: 'Der Worktree',
    folder: 'Ordner: {folder}',
    checking: 'Offene Arbeit wird geprüft…',
    checkFailed: 'Der Worktree konnte nicht geprüft werden.',
    dirty: {
      one: '{count} Datei mit nicht committeten Änderungen',
      other: '{count} Dateien mit nicht committeten Änderungen',
    },
    clean: 'Keine nicht committeten Änderungen',
    unpushed: {
      one: '{count} Commit, der in keinem Remote-Branch ist',
      other: '{count} Commits, die in keinem Remote-Branch sind',
    },
    pushed: 'Keine Commits, die es nur hier gibt',
    merged: 'Der Branch ist in {base} enthalten',
    notMerged: 'Der Branch ist nicht in {base} enthalten',
    optionsLabel: 'Was mit dem Worktree passiert',
    options: {
      keep: 'Worktree behalten',
      worktree: 'Worktree löschen, Branch behalten',
      all: 'Worktree und Branch löschen',
    },
    optionHints: {
      keep: 'Ordner und Branch bleiben, wie sie sind – du kannst dort später weitermachen.',
      worktree: 'Der Ordner verschwindet; die Commits bleiben im Branch.',
      all: 'Ordner und Branch verschwinden.',
    },
    confirmLoss: 'Ja, die offene Arbeit verwerfen ({list}).',
    lossFiles: { one: '{count} geänderte Datei', other: '{count} geänderte Dateien' },
    lossCommits: { one: '{count} Commit', other: '{count} Commits' },
    teardown: 'Zuerst läuft der Teardown-Befehl des Projekts – sichtbar in einem Terminal-Tab der Session.',
    steps: {
      close: 'Session wird beendet…',
      remove: 'Worktree wird gelöscht…',
      archive: 'Wird archiviert…',
      removeSession: 'Wird entfernt…',
    },
    dirtyError: 'Der Worktree hat offene Arbeit: {list}.',
    teardownFailed: 'Der Teardown-Befehl ist fehlgeschlagen (Exit-Code {code}).',
    teardownStopped: 'Der Teardown-Befehl wurde abgebrochen.',
    deleteAnyway: 'Trotzdem löschen',
    showOutput: 'Ausgabe ansehen',
    worktreeGone: 'Der Worktree ist gelöscht – nur der Schritt für die Session fehlt noch.',
    cancel: 'Abbrechen',
    confirmArchive: 'Archivieren',
    confirmRemove: 'Entfernen',
  },
};
