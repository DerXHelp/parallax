# src/web/features/terminal – Eingebettetes Terminal (WP-99b)

Owner: **WP-99b**. Auftrag: `docs/wp/WP-99.md` („Aufteilung“), Details und Stolpersteine: `docs/wp/WP-99b.md`,
Entscheidung ADR-239. Server: `src/server/terminal` (WP-99a), Protokoll v1: `src/shared/terminal.ts`.

Tab „Terminal“ des Seitenpanels (Slot `TerminalPanel`): cmd, PowerShell oder Git Bash im Ordner der Session, in
einer Pseudokonsole dieses Rechners, angezeigt mit xterm.js (nur DOM-Renderer). Bis zu 4 Terminals je Session; die
Shells laufen weiter, wenn das Panel schließt, beim Wiederöffnen spielt der Server den Verlauf neu ab.

## Exporte

| Datei | Export | Zweck |
| --- | --- | --- |
| `index.ts` | `TERMINAL_SLOTS` (`TerminalPanel`) | Der Koordinator spreizt es in `APP_SLOTS` (App.tsx). Lazy-Chunk; `index.ts` importiert nur React |
| `TerminalPanel.tsx` | `TerminalPanel` (`{ sessionKey }`, default) | Einstieg des Lazy-Chunks (Tests importieren ihn direkt) |

## Aufbau

| Pfad | Inhalt |
| --- | --- |
| `TerminalPanel.tsx` | Ein Socket je montiertem Panel (`state/controller.ts`), Zustände: verbinden, nicht verfügbar (`TERMINAL_UNAVAILABLE`), endgültig gescheitert (4404/4426), Leiste, „wird gestartet“, Leerzustand; Serverfehler inline (`Alert role="alert"`, `tError`) |
| `components/TerminalTabs.tsx` | Leiste der Terminals („cmd 1“, × schließt) mit „+“, darunter alle Ansichten (nur die aktive sichtbar). Klick auf einen Tab fokussiert das Terminal, Pfeiltasten wechseln nur |
| `components/AddTerminalMenu.tsx` | „+“: Shells, Standard der Einstellungen zuerst; an der Grenze sind die Shells deaktiviert, ein Hinweis nennt die Grenze |
| `components/TerminalView.tsx` | Ein Terminal: Engine im Host, Kontextmenü (Kopieren, Einfügen, Alles auswählen, Leeren, Screenreader-Modus, Neu starten, Schließen), Exit-Leiste; Esc-Handler (Esc bleibt im Terminal) |
| `components/ExitBar.tsx` | „Beendet mit Code n“ (bzw. „konnte nicht gestartet werden“), Neu starten, Schließen |
| `components/TerminalEmpty.tsx` | Nach dem Schließen aller Terminals: ein Knopf je Shell |
| `lib/engine.ts` | `TerminalEngine` (Adapter-Schnittstelle) und `createXtermEngine` (xterm + Fit-Addon + CSS) – nur im Lazy-Chunk |
| `lib/fake-engine.ts` | `FakeEngine`, `createFakeEngineFactory` für Tests (happy-dom kann xterm nicht layouten) |
| `lib/keys.ts` | Eigener Tasten-Handler: App-Kürzel und Zoom zurück an die App, Ctrl+C kopiert bei Auswahl, Ctrl+V über das native `paste` |
| `lib/theme.ts` | `--terminal-*`-Tokens → xterm `ITheme`, `watchTerminalTheme` (Klasse `dark` an `<html>`) |
| `lib/font.ts` | Berechnete Mono-Schrift und -Größe des Hosts (folgt dem Zoom); Warten auf die Schrift vor dem Öffnen |
| `lib/size.ts`, `lib/shells.ts` | Größe in den Protokollgrenzen; Shell-Texte und Reihenfolge |
| `state/socket.ts` | `TerminalConnection`: hello, zod für jeden Text-Frame (Unbekanntes gezählt und ignoriert), binäre Frames je Kanal, Reconnect mit `backoffDelay`, Re-Attach; austauschbare Socket-Fabrik |
| `state/terminals.ts` | Zustand-Store je `sessionKey` (Liste, aktives Terminal, Verfügbarkeit, letzter Fehler, Tab-Nummern), Screenreader-Modus (localStorage) |
| `state/controller.ts` | Ein montiertes Panel: Verbindung ↔ Store, automatisches erstes Terminal (einmal je Mount), open/close/restart |
| `state/view.ts` | `TerminalViewRuntime`: Engine öffnen, attach mit eingepasster Größe, Ausgabe schreiben, Resize (100 ms entprellt), Theme |
| `state/environment.ts` | `TerminalEnvironment` (Engine, Socket, Zwischenablage, Schrift) als Kontext – Tests setzen Fakes |
| `testing.ts` | `FakeTerminalServer`, `FakeTerminalSocket`, `fakeTerminalEnvironment`, Beispiel-Terminals |
| `i18n/` | Lazy-Namensraum (`useTerminalT`, `en.ts`, `de.ts`); nicht in `src/web/i18n/dictionaries.ts` registriert |

## Andocken (`data-slot`)

- `terminal-panel` (Wurzel), `terminal-view` mit `data-active="true"` für das aktive Terminal (Alt+T der Shell fokussiert
  dessen `.xterm-helper-textarea`), `data-terminal-id`, `data-state` (`running`/`exited`).
- `terminal-tab` (`data-terminal-id`), `terminal-tab-close`, `terminal-add` (Menüpunkte `data-choice=<shell>`),
  `terminal-empty` (Knöpfe `data-shell=<shell>`), `terminal-exit-bar`, `terminal-error`, `terminal-unavailable`,
  `terminal-failed`, `terminal-connecting`, `terminal-starting`, `terminal-reconnecting`, `terminal-screen`,
  `terminal-host`.

## Regeln

- xterm, seine CSS und die Texte nur im Lazy-Chunk: nie aus `index.ts` oder etwas, das es statisch importiert.
- Keine Imports aus anderen Features; Shell-Bausteine (`shell/shortcuts`, `shell/zoom-input`) sind erlaubt.
- Nur für Sessions dieses Rechners (die Shell zeigt den Tab nur bei `useTerminalAvailable`).
