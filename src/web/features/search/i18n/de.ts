import type { en } from './en';

/** German texts of namespace `search` (same shape as en.ts). */
export const de: typeof en = {
  title: 'In Inhalten suchen',
  description: 'Durchsucht Prompts, Antworten, Titel, Turn-Fazits und Pläne aller Sessions.',
  input: 'Suchtext',
  placeholder: 'In allen Sessions suchen…',
  options: 'Suchoptionen',
  includeArchived: 'Archivierte einbeziehen',
  includeToolOutput: 'Werkzeugausgaben',
  results: 'Treffer',
  hintShort: 'Mindestens {min} Zeichen eingeben.',
  searching: 'Suche läuft…',
  empty: 'Keine Treffer.',
  unavailable: 'Kein verbundener Rechner kann Inhalte durchsuchen.',
  truncated: 'Nur die neuesten {max} Treffer je Rechner – den Text genauer fassen.',
  failed: 'Die Suche auf {host} ist fehlgeschlagen: {error}',
  thisComputer: 'diesem Rechner',
  hint: '↑↓ wählen · Enter öffnet die Session am Treffer · Esc schließt',
  kind: {
    prompt: 'Prompt',
    answer: 'Antwort',
    tool: 'Werkzeugausgabe',
    title: 'Titel',
    plan: 'Plan',
    summary: 'Fazit',
  },
  archived: 'Archiviert',
  hits: { one: '{count} Treffer', other: '{count} Treffer' },
  unknownSession: 'Session nicht in der Liste',
  shortcut: 'In den Inhalten aller Sessions suchen',
};
