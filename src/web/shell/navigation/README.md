# src/web/shell/navigation – Navigation (Phase 2)

Owner: **WP-35**. Auftrag und Ergebnis: `docs/wp/WP-35.md`.

Bausteine von Sidebar (flach/gruppiert, zweizeilig, Archiv), Quick-Switcher (Strg+K),
Kontextmenüs, Inline-Umbenennen, Kopfzeilen-Menü (Frühere Unterhaltungen, Session-Info, externe
Konsole) und Abo-Limit-Anzeige. Handler des Anfragekanals (`../requests.ts`), registriert von
`NavigationLayer`, solange die Shell steht: `renameTitle`, `conversations`, `sessionInfo`,
`quickSwitcher` (Rückgabe `false` für unbekannte Sessions).

| Pfad | Inhalt |
| --- | --- |
| `i18n/{en,de}.ts` | Namensraum `navigation` (registriert in `src/web/i18n/index.ts`) |
| `NavigationLayer.tsx` | Anfrage-Handler, Kürzel Strg+K (auch in Textfeldern) und F2 (fokussierte Sidebar-Zeile, sonst gewählte Session – Kopfzeile vor Zeile), Dialoge |
| `SessionRow.tsx` | zweizeiliger Sidebar-Eintrag (Status, Titel, Pin, Zeit, Ungelesen / Pfad-Ende, ⎇ Branch, Modell-Kurzname, Context-Balken 70/85 %), Profilstreifen, Tooltip, Kontextmenü (Rechtsklick, Umschalt+F10), „…“-Knopf bei Hover/Fokus, Inline-Umbenennen; im Archiv „Wiederherstellen“ |
| `session-actions.tsx` | eine Definition der Session-Aktionen (`SIDEBAR_ACTIONS`, `HEADER_ACTIONS`, `sessionActions`, `SessionActionItems`), `runSessionCommand` (Ablehnung → `showErrorNotice`), `copyConsoleCommand`, `newSessionIn(cwd)`, `onSessionMenuCloseAutoFocus` |
| `rename.ts` | Zustand des Inline-Umbenennens: `startRename`, `startRenameAfterMenu`/`takePendingRename` (aus Menüs erst nach dem Schließen), `finishRename`, `useRenaming`, `useRenameHeader`, `renamePlaceFor` |
| `RenameField.tsx` | Titelfeld: Enter speichert (`session.rename`, leer → `null`), Esc bricht ab, Verlassen speichert geänderte nicht-leere Titel |
| `sidebar-view.ts` | Ansicht `flat`/`grouped` (localStorage `parallax.sidebar.mode`) und Archiv-Ansicht: `useSidebarMode`, `setSidebarMode`, `useArchiveView`, `setArchiveView` |
| `SessionMenu.tsx` | „…“-Menü neben der Statuszeile der Kopfzeile (nicht in `[data-slot=session-header]`, ADR-042) |
| `QuickSwitcher.tsx` | Dialog mit `ui/command-list`: Fuzzy über Titel, Pfad-Ende, Branch, Profil; wartende zuerst; Enter wählt, Umschalt+Enter öffnet ein neues Fenster |
| `ConversationsDialog.tsx` | Frühere Unterhaltungen (`session.switchConversation`, SESSION_BUSY als Warn-Hinweis) |
| `SessionInfoDialog.tsx` | Session-Info (Modell, Modus, Ordner, Branch, CLI, API-Key-Quelle, Session-ID, Profil, MCP-Server) |
| `PaneBanners.tsx` | Pane-Banner „In externer Konsole geöffnet (seit HH:MM)“ + „Zurückholen“ und „Archiviert“ + „Wiederherstellen“ |
| `AccountLimits.tsx` | Abo-Limits unten in der Sidebar (5 h / Woche je Profil, „zurückgesetzt um …“) |
| `profile-colors.ts` | `PROFILE_BG` (statische Klassen je Profilfarbe) |
