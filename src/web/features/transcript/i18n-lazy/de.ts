import type { en } from './en';

export const de: typeof en = {
  group: {
    hookCount: '{count}× Hook',
    checkingPermission: 'prüft Berechtigung: {step}',
  },
  tool: {
    checkingPermission: 'Berechtigung wird geprüft…',
  },
  user: {
    renamed: 'Titel an Claude Code übergeben: {title}',
    renamedRemote: 'In der Claude-App umbenannt: {title}',
  },
  agent: {
    openTranscript: 'Verlauf',
    openTranscriptLabel: 'Verlauf des Agenten „{title}“ öffnen',
  },
  system: {
    hookBlockedTool: 'Hook {event} hat {tool} blockiert',
    hookBlocked: 'Hook {name} hat blockiert',
    hookFailed: 'Hook {name} ist fehlgeschlagen',
    hookFailedCode: 'Hook {name} ist fehlgeschlagen (Exit-Code {code})',
    hookOutput: 'Ausgabe',
    attachmentsMissing: {
      some: {
        one: '{count} von {sent} angehängten Dateien kam nicht an',
        other: '{count} von {sent} angehängten Dateien kamen nicht an',
      },
      all: {
        one: 'Die angehängte Datei kam nicht an',
        other: 'Keine der {count} angehängten Dateien kam an',
      },
      unknown: 'Angehängte Dateien kamen nicht an',
      detail: { one: 'Claude macht ohne sie weiter.', other: 'Claude macht ohne sie weiter.' },
    },
    peerHold: {
      held: 'Nachricht von {from} zurückgehalten',
      released: 'Zurückgehaltene Nachricht von {from} durchgelassen',
      dropped: 'Nachricht von {from} nicht zugestellt',
      unknownState: 'Nachricht von {from}: {state}',
      anotherSession: 'einer anderen Session',
      cause: {
        explicitSetting: 'so in deinen Einstellungen festgelegt',
        managedSetting: 'von verwalteten Einstellungen vorgegeben',
        repoSetting: 'in den Projekteinstellungen festgelegt',
        invalidSetting: 'die Einstellung ist ungültig',
        bypassDefault: 'Standard im Modus „Berechtigungen umgehen“',
        modeUnknown: 'Berechtigungsmodus des Absenders nicht erkannt',
        modeMismatch: 'der Absender nutzt einen anderen Berechtigungsmodus',
        noModeAsserted: 'der Absender nannte keinen Berechtigungsmodus',
      },
      outcome: {
        expired: 'abgelaufen',
        refused: 'abgelehnt',
        dropped: 'fallen gelassen',
        discarded: 'verworfen',
      },
    },
  },
  subagent: {
    label: 'Verlauf des Agenten „{title}“',
    running: 'Läuft – wird alle paar Sekunden aktualisiert',
    finished: 'Beendet',
    count: { one: '{count} Eintrag', other: '{count} Einträge' },
    loadEarlier: 'Frühere Einträge laden',
    empty: 'Der Verlauf ist noch leer.',
    failed: 'Der Verlauf konnte nicht geladen werden.',
    retry: 'Erneut versuchen',
    refresh: 'Aktualisieren',
  },
  reveal: {
    label: 'Suchtreffer',
    otherConversation: 'Suchtreffer aus einer früheren Konversation',
    notLoaded: 'Suchtreffer weiter zurück in dieser Konversation',
    close: 'Suchtreffer schließen',
  },
};
