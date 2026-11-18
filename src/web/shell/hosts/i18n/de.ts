import type { en } from './en';

/** Deutsche Texte des Namensraums `hosts` (WP-80). */
export const de: typeof en = {
  thisComputer: 'Dieser Rechner',
  badge: {
    label: 'Rechner {name}',
  },
  status: {
    available: 'Verbunden',
    connecting: 'Verbinde…',
    unreachable: 'Nicht erreichbar',
    incompatible: 'Andere Version',
    revoked: 'Kopplung aufgehoben',
  },
  groupBy: {
    label: 'Gruppieren nach',
    host: 'Rechner',
    folder: 'Verzeichnis',
  },
  group: {
    label: 'Rechner {name}',
    count: { one: '{count} Session', other: '{count} Sessions' },
    waiting: { one: '{count} wartet', other: '{count} warten' },
    selectedInside: 'Enthält die gewählte Session',
    empty: 'Keine Sessions',
    newSession: 'Neue Session auf {name}…',
    expand: '{name} aufklappen',
    collapse: '{name} einklappen',
  },
  unavailable: {
    row: 'Rechner {name}: {status}',
    unreachable: '{name} ist nicht erreichbar. Die Sessions dort kommen wieder, sobald er erreichbar ist.',
    connecting: 'Verbinde mit {name}…',
    incompatible:
      'Parallax auf {name} hat eine andere Version ({version}). Parallax auf {name} auf {own} aktualisieren.',
    incompatibleUnknown:
      'Parallax auf {name} hat eine andere Version. Parallax auf {name} auf {own} aktualisieren.',
    revoked: 'Die Kopplung mit {name} wurde aufgehoben. Unter Einstellungen → Mehrere Rechner neu koppeln.',
    reconnect: 'Neu verbinden',
    settings: 'Mehrere Rechner…',
  },
  newSession: {
    host: 'Rechner',
    hostHint: 'Ordner, Profile und zuletzt genutzte Ordner kommen von diesem Rechner.',
    signInThere: 'Auf {name} selbst anmelden – die Anmeldung geht nicht von hier aus.',
    unavailable: '{name} ist gerade nicht nutzbar ({status}).',
  },
  session: {
    host: 'Läuft auf {name}',
  },
  indicator: {
    open: 'Mehrere Rechner – Einstellungen öffnen',
    shareListening: 'Freigeben: wartet auf Verbindungen',
    shareOff: 'Freigeben: nimmt keine Verbindungen an',
    shareConnected: 'Freigeben: {name} ist verbunden',
    shareError: 'Freigeben: Empfang fehlgeschlagen',
    rejected: { one: '{count} abgewiesener Versuch', other: '{count} abgewiesene Versuche' },
    controlAll: { one: '{count} Rechner verbunden', other: 'Alle {count} Rechner verbunden' },
    controlSome: '{connected} von {total} Rechnern verbunden',
    controlNone: 'Kein Rechner hinzugefügt',
  },
};
