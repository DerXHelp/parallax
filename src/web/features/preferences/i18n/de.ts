import type { en } from './en';

/** German texts of namespace `preferences` (same shape as en.ts). */
export const de: typeof en = {
  menuItem: 'Einstellungen…',
  title: 'Einstellungen',
  description: 'Änderungen gelten sofort und werden vom Parallax-Server gespeichert.',
  sections: {
    label: 'Bereiche der Einstellungen',
    general: 'Allgemein',
    notifications: 'Benachrichtigungen',
    sessions: 'Sessions',
    profiles: 'Profile',
    server: 'Server',
    about: 'Über',
    unsaved: 'ungespeicherte Änderungen',
  },
  closeConfirm: {
    title: 'Ungespeicherte Profiländerungen verwerfen?',
    description:
      'Im Profil-Editor gibt es Änderungen, die noch nicht gespeichert sind. Beim Schließen der Einstellungen gehen sie verloren.',
    keep: 'Weiter bearbeiten',
    discard: 'Verwerfen und schließen',
  },
  dismissError: 'Ausblenden',
  general: {
    languageHint: 'Sprache der App und der Windows-Benachrichtigungen.',
    themeHint: '„System“ folgt der Windows-Einstellung. Das Einstellungsmenü bietet dieselbe Schnellwahl.',
  },
  notifications: {
    events: 'Ereignisse',
    eventsHint:
      'Je Ereignis: eine Windows-Benachrichtigung und ein Ton. Parallax zeigt jede Benachrichtigung nur einmal.',
    columns: {
      event: 'Ereignis',
      toast: 'Windows-Benachrichtigung',
      sound: 'Ton',
    },
    kinds: {
      permission: 'Braucht Freigabe',
      question: 'Frage',
      plan: 'Plan prüfen',
      done: 'Fertig',
      error: 'Fehler',
      rate_limit: 'Limit erreicht',
    },
    toastFor: 'Windows-Benachrichtigung: {event}',
    soundFor: 'Ton: {event}',
    soundIdFor: 'Klang: {event}',
    previewFor: 'Klang für „{event}“ anhören',
    volume: 'Lautstärke',
    volumeValue: '{percent} %',
    doNotDisturb: 'Nicht stören',
    doNotDisturbHint:
      'Keine Windows-Benachrichtigungen und keine Töne. Hinweise im Fenster und die Anzahl im Fenstertitel bleiben.',
    focusedElsewhere: 'Ist ein Parallax-Fenster im Vordergrund und zeigt eine andere Session',
    focusedElsewhereInApp: 'Hinweis im Fenster zeigen',
    focusedElsewhereSystem: 'Windows-Benachrichtigung zeigen',
    doneMinSeconds: 'Mindestdauer für „Fertig“',
    doneMinSecondsHint:
      'Ist ein Parallax-Fenster im Vordergrund, wird „Fertig“ nur für Turns gemeldet, die mindestens so lange gedauert haben. Im Hintergrund zählt jeder fertige Turn.',
    seconds: 'Sekunden',
    openOnClick: 'Klick auf eine Windows-Benachrichtigung öffnet die Session',
    openOnClickHint:
      'Registriert den Linktyp „parallax:“ für deinen Windows-Benutzer; ein Klick öffnet die Session in einem neuen App-Fenster.',
  },
  sessions: {
    idleSleep: 'Untätige Sessions schlafen legen',
    idleSleepHint:
      'Beendet den Claude-Prozess einer Session, die so lange auf nichts gewartet hat; der nächste Prompt setzt sie fort. Eine Session, die ein Fenster im Vordergrund zeigt, schläft nie.',
    idleMinutes: 'Untätig bis zum Schlafen',
    minutes: 'Minuten',
    promptSuggestions: 'Prompt-Vorschläge',
    promptSuggestionsHint:
      'Claude schlägt den nächsten Prompt als grauen Text im Eingabefeld vor (Tab übernimmt ihn). Kostet einen zusätzlichen Request je Turn. Wirkt ab dem nächsten Start einer Session.',
  },
  server: {
    port: 'Port',
    portPlaceholder: '{port} (Standard)',
    portHint: 'Leer = Standardport {port}. Wirkt nach „Server beenden“ und einem Neustart von Parallax.',
    currentPort: 'Aktueller Port: {port}',
    autostart: 'Parallax beim Anmelden an Windows starten',
    autostartHint:
      'Startet den Server im Hintergrund; Windows-Benachrichtigungen funktionieren auch ohne Fenster.',
    openWindow: 'Beim Anmelden auch ein Fenster öffnen',
    openWindowNeedsAutostart: 'Nur, solange „Parallax beim Anmelden an Windows starten“ eingeschaltet ist.',
  },
  profiles: {
    unavailable: 'Der Profil-Editor ist in dieser Ansicht nicht verfügbar.',
  },
  systemIntegrationOff:
    'Nur beim installierten Parallax-Server verfügbar (Standard-Datenordner, echtes Claude Code, kein Entwicklungsmodus).',
  validation: {
    range: 'Gib eine ganze Zahl von {min} bis {max} ein.',
    rangeOrEmpty: 'Lass das Feld leer oder gib eine ganze Zahl von {min} bis {max} ein.',
  },
  sounds: {
    names: {
      chime: 'Glockenspiel',
      ping: 'Ping',
      pop: 'Plopp',
      bell: 'Glocke',
      alert: 'Warnton',
    },
    locked:
      'Töne aktivieren: Klicke irgendwo in dieses Fenster oder drücke eine Taste – Browser spielen Töne erst danach ab.',
  },
};
