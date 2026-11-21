/**
 * Texts of namespace `search` (WP-115; registered in src/web/i18n/dictionaries.ts). Same syntax as the
 * shell dictionaries (`{name}` placeholders, `{ one, other }` plurals), `de.ts` has exactly this shape.
 */
export const en = {
  title: 'Search in contents',
  description: 'Searches prompts, answers, titles, turn summaries and plans of all sessions.',
  input: 'Search text',
  placeholder: 'Search in all sessions…',
  options: 'Search options',
  includeArchived: 'Include archived',
  includeToolOutput: 'Tool output',
  results: 'Hits',
  hintShort: 'Type at least {min} characters.',
  searching: 'Searching…',
  empty: 'No hits.',
  unavailable: 'No connected computer can search contents.',
  truncated: 'Only the newest {max} hits per computer are listed – make the text more precise.',
  failed: 'The search on {host} failed: {error}',
  thisComputer: 'this computer',
  hint: '↑↓ choose · Enter opens the session at the hit · Esc closes',
  kind: {
    prompt: 'Prompt',
    answer: 'Answer',
    tool: 'Tool output',
    title: 'Title',
    plan: 'Plan',
    summary: 'Summary',
  },
  archived: 'Archived',
  hits: { one: '{count} hit', other: '{count} hits' },
  unknownSession: 'Session not in the list',
  /** Help of the shortcut (`?`). */
  shortcut: 'Search in the contents of all sessions',
};
