import type { en } from './en';

export const de: typeof en = {
  panel: {
    label: 'Terminals',
    connecting: 'Verbindung zum Terminal wird aufgebaut…',
    reconnecting: 'Verbindung zum Terminal unterbrochen – neuer Versuch…',
    entryNotFound: 'Diese Session ist auf diesem Rechner nicht bekannt.',
    protocol: 'Der Terminal-Dienst dieses Rechners spricht eine andere Version. Lade das Fenster neu.',
    starting: '{shell} wird gestartet…',
    dismiss: 'Ausblenden',
  },
  shells: {
    cmd: 'Eingabeaufforderung (cmd)',
    powershell: 'PowerShell',
    gitbash: 'Git Bash',
  },
  short: {
    cmd: 'cmd',
    powershell: 'PowerShell',
    gitbash: 'Git Bash',
  },
  tabs: {
    label: 'Terminals dieser Session',
    name: '{shell} {number}',
    exited: '{name} (beendet)',
    close: '{name} schließen',
  },
  add: {
    label: 'Neues Terminal',
    default: 'Standard',
    limit: 'Höchstens {max} Terminals je Session',
  },
  empty: {
    title: 'Kein Terminal offen',
    hint: 'Starte eine Shell im Ordner dieser Session.',
  },
  exit: {
    code: 'Beendet mit Code {code}',
    unknown: 'Beendet',
    failed: 'Die Shell konnte nicht gestartet werden.',
    restart: 'Neu starten',
    close: 'Schließen',
  },
  menu: {
    copy: 'Kopieren',
    paste: 'Einfügen',
    selectAll: 'Alles auswählen',
    clear: 'Leeren',
    restart: 'Neu starten',
    close: 'Terminal schließen',
    screenReader: 'Screenreader-Modus',
    pasteFailed: 'Parallax darf die Zwischenablage hier nicht lesen. Füge mit Strg+V ein.',
  },
  view: {
    label: 'Terminal {name}',
  },
};
