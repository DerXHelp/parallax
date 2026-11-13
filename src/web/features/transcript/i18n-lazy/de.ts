import type { en } from './en';

export const de: typeof en = {
  group: {
    hookCount: '{count}× Hook',
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
};
