import type { en } from './en';

/** German texts of "Stop server" (WP-21; same shape as en.ts). */
export const de: typeof en = {
  menuItem: 'Server beenden…',
  title: 'Parallax-Server beenden?',
  description:
    'Alle Claude-Sessions dieses Servers werden gestoppt, und jedes Parallax-Fenster verliert die Verbindung. ' +
    'Starte Parallax danach neu – die Sessions lassen sich dann fortsetzen.',
  working: 'Arbeitet ({count})',
  waiting: 'Wartet auf dich ({count})',
  waitingHint:
    'Offene Freigaben, Fragen und Pläne verfallen; ein Plan lässt sich nach dem Neustart freigeben („Fortsetzen“).',
  idle: {
    one: '{count} Session im Leerlauf (ohne laufende Arbeit) wird geschlossen.',
    other: '{count} Sessions im Leerlauf (ohne laufende Arbeit) werden geschlossen.',
  },
  nothingRunning: 'Keine Session läuft – es wird nichts unterbrochen.',
  confirm: 'Server beenden',
  stopping: 'Wird beendet…',
  notConnected: 'Keine Verbindung zum Server – er ist eventuell schon beendet.',
  failed: 'Der Server konnte nicht beendet werden.',
  outdatedDescription:
    'Dabei werden auch alle Claude-Sessions dieses Servers gestoppt – nach dem Neustart lassen sie sich fortsetzen. Starte Parallax danach neu (parallax.cmd oder pnpm start).',
  manualHint:
    'Hilft das nicht: Beende den Parallax-Server (node.exe) im Task-Manager und starte Parallax neu.',
};
