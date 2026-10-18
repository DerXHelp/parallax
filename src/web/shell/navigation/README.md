# src/web/shell/navigation – Navigation (Phase 2)

Owner: **WP-35** (Fix-Runde R4: F2, `docs/wp/FIX-R4-F2.md`). Auftrag und Ergebnis: `docs/wp/WP-35.md`.

Bausteine von Sidebar (flach/gruppiert, zweizeilig, Archiv), Quick-Switcher (Strg+K),
Kontextmenüs, Inline-Umbenennen, Kopfzeilen-Menü (Frühere Unterhaltungen, Session-Info, externe
Konsole) und Abo-Limit-Anzeige. Handler des Anfragekanals (`../requests.ts`), registriert von
`NavigationLayer`, solange die Shell steht: `renameTitle`, `conversations`, `sessionInfo`,
`quickSwitcher` (Rückgabe `false` für unbekannte Sessions). Dialoge ohne Trigger geben den Fokus
beim Schließen zurück (`useReturnFocus` aus `src/web/lib/return-focus.ts`, R4W-04).

| Pfad | Inhalt |
| --- | --- |
| `i18n/{en,de}.ts` | Namensraum `navigation` (registriert in `src/web/i18n/index.ts`); dazu `notices.enableSounds` (Knopf des Hinweises „Töne aktivieren“, `notifications/delivery.ts`) |
| `NavigationLayer.tsx` | Anfrage-Handler, Kürzel Strg+K (auch in Textfeldern) und F2 (fokussierte Sidebar-Zeile, sonst gewählte Session – Kopfzeile vor Zeile), Dialoge |
| `SessionRow.tsx` | zweizeiliger Sidebar-Eintrag (Status, Titel, Pin, Zeit, Ungelesen / Pfad-Ende, ⎇ Branch, Modell-Kurzname, Context-Balken 70/85 %), Profilstreifen, Tooltip, Kontextmenü mit Namen (Rechtsklick, Umschalt+F10), „…“-Knopf bei Hover/Fokus, Inline-Umbenennen; im Archiv „Wiederherstellen“ (kein Tab-Stopp, R4W-13) |
| `PathTail.tsx` | Pfad-Ende einzeilig (WP41-02): `head` kürzt mit Ellipse (`data-slot="path-head"`), das letzte Segment (Projektordner, `path-last`, `shrink-0`) bleibt ganz – nur breiter als die ganze Box wird es selbst gekürzt; Text = `pathTail`. Genutzt von Sidebar-Zeile (`row-path`), Quick-Switcher (`switcher-path`) und Kopfzeile (`header-path`, `../SessionHeader.tsx`) |
| `handoff.ts` | Handoffs unterwegs (WP41-07): `openExternalConsole(sessionKey, entryId)` (`session.openExternal`, zählt die Session bis zur Antwort als „Handoff läuft“), `trackHandoff`, `useHandoffPending`, `isHandoffPending`, `resetHandoffs` (Tests); Menüs und Composer-Hinweis öffnen darüber, der Composer sendet in der Zeit nichts |
| `session-actions.tsx` | eine Definition der Session-Aktionen (`SIDEBAR_ACTIONS`, `HEADER_ACTIONS`, `sessionActions`, `SessionActionItems`), `runSessionCommand` (Ablehnung → `showErrorNotice`), `copyConsoleCommand`, `newSessionIn(cwd)`, `sessionMenuCloseAutoFocus(sessionKey, place)` (Umbenennen aus dem Menü; sonst Fokus nie auf `<body>`: Zeile bzw. „…“ der Kopfzeile, V3-04) |
| `rename.ts` | Zustand des Inline-Umbenennens: `startRename`, `startRenameAfterMenu`/`takePendingRename` (aus Menüs erst nach dem Schließen), `finishRename`, `useRenaming`, `useRenameHeader`, `renamePlaceFor` |
| `focus.ts` | `sessionFocusTarget(sessionKey, prefer)` – Rückfall-Ziel für den Fokus: „…“ der Kopfzeile bzw. Sidebar-Zeile (Umbenennen, Dialoge) |
| `RenameField.tsx` | Titelfeld: Enter speichert (`session.rename`, leer → `null`), Esc bricht ab, Verlassen speichert geänderte nicht-leere Titel |
| `sidebar-view.ts` | Ansicht `flat`/`grouped` (localStorage `parallax.sidebar.mode`) und Archiv-Ansicht: `useSidebarMode`, `setSidebarMode`, `useArchiveView`, `setArchiveView` |
| `SessionMenu.tsx` | „…“-Menü neben der Statuszeile der Kopfzeile (nicht in `[data-slot=session-header]`, ADR-042) |
| `QuickSwitcher.tsx` | Dialog mit `ui/command-list`: Fuzzy über Titel, Pfad-Ende, Branch, Profil (`fuzzyFilter` streng, Titel vor Profil); ohne Suche wartende zuerst, mit Suche nach Treffergüte (wartend nur bei Gleichstand, V3-03); Enter wählt und fokussiert das Eingabefeld der Session, Umschalt+Enter öffnet ein neues Fenster, Esc gibt den Fokus zurück |
| `ConversationsDialog.tsx` | Frühere Unterhaltungen (`session.switchConversation`); Ablehnung (SESSION_BUSY …) als `Alert role="alert"` im Dialog (ADR-126) |
| `SessionInfoDialog.tsx` | Session-Info (Modell, Modus, Ordner, Branch, CLI, Anmeldung, Session-ID, Profil, MCP-Server); bekannte Werte von `apiKeySource`/MCP-Status übersetzt, unbekannte roh (R4W-14) |
| `PaneBanners.tsx` | Pane-Banner „In externer Konsole geöffnet (seit HH:MM)“ + „Zurückholen“ und „Archiviert“ + „Wiederherstellen“ |
| `AccountLimits.tsx` | Abo-Limits unten in der Sidebar (5 h / Woche, „Reset um …“/„am …“) je **Konto** (WP41-05): Profile mit gleichem `configDir` (`windowsPathKey` aus `@shared/paths`; `null`/leer = Standardordner) bilden einen Block mit dem neuesten Bericht (`RateLimitInfo.at`), beschriftet mit allen Profilnamen des Kontos (`navigation.limits.profile`/`profiles`, nur bei mehreren Konten); Fenster verschwinden genau zum Reset (`useNowUntil`, R4W-06) |
| `profile-colors.ts` | `PROFILE_BG` (statische Klassen je Profilfarbe) |
| `navigation.test.tsx`, `pane.test.tsx`, `focus.test.tsx`, `limits.test.tsx`, `PathTail.test.tsx`, `handoff.test.ts` | Tests (ganze Shell mit Szenario `navigation`; Fokus, Ranking, Hinweise über Modals, Abo-Limits mit Fake-Timern und Konten; Pfad-Ende; Handoff-Zustand) |
