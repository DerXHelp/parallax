import type { en } from './en';

/** German texts of namespace `tasks` (same shape as en.ts). */
export const de: typeof en = {
  title: 'Aufgaben',
  kind: {
    agent: 'Agent',
    bash: 'Shell',
    workflow: 'Workflow',
  },
  status: {
    started: 'Gestartet',
    running: 'Läuft',
    pending: 'Wartet',
    completed: 'Fertig',
    failed: 'Fehlgeschlagen',
    stopped: 'Gestoppt',
    killed: 'Abgebrochen',
  },
  panel: {
    label: 'Aufgaben dieser Session',
    todos: 'Aufgabenliste',
    background: 'Hintergrund-Tasks',
    running: { one: '{count} läuft', other: '{count} laufen' },
    recent: { one: '{count} kürzlich beendet', other: '{count} kürzlich beendet' },
    stopAll: 'Alle stoppen',
    confirmTitle: { one: 'Laufenden Task stoppen?', other: 'Alle {count} laufenden Tasks stoppen?' },
    confirmText: 'Die Tasks werden nacheinander gestoppt; was sie bisher erledigt haben, bleibt erhalten.',
    confirmStop: 'Alle stoppen',
    cancel: 'Abbrechen',
    stoppingAll: 'Stoppe {done} von {total} …',
    empty: 'Keine Hintergrund-Tasks',
    emptyHint:
      'Agents und Shell-Befehle, die im Hintergrund laufen, erscheinen hier; beendete bleiben 10 Minuten sichtbar.',
  },
  row: {
    stop: 'Stoppen',
    stopLabel: '„{description}“ stoppen',
    stopping: 'Wird gestoppt…',
    runtime: 'Laufzeit {duration}',
    tokens: '{count} Tokens',
    toolUses: { one: '{count} Werkzeugaufruf', other: '{count} Werkzeugaufrufe' },
    output: 'Ausgabedatei:',
    ended: '{status} um {time}',
  },
  strip: {
    label: 'Aufgabenliste',
    progress: '{done} von {total} erledigt',
    openPanel: 'Aufgaben',
    openPanelLabel: 'Aufgaben im Seitenpanel anzeigen',
  },
  todo: {
    pending: 'Offen',
    in_progress: 'In Arbeit',
    completed: 'Erledigt',
  },
};
