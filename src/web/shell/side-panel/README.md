# src/web/shell/side-panel – Seitenpanel-Host (Phase 3)

Owner: **WP-54** (Gerüst aus WP-50 Teil 2). Design: `docs/wp/WP-50.md` §4.14 C, ADR-150; Ergebnis:
`docs/wp/WP-54.md`.

Der Rahmen des Seitenpanels einer Session-Pane: `aside` neben dem Transkript, Tab-Zeile Plan ·
Datei (nur mit offener Datei) · Dateien · Aufgaben mit Schließen, Esc im Panel, Fokus-Rückgabe an
den Auslöser; nicht modal, keine Fokusfalle. Die Tabs rendern die Feature-Slots `PlanPanel`,
`FilePanel`, `FilesPanel`, `TasksPanel` (`shell/slots.tsx`). Breite per Splitter (`@web/ui/splitter`,
Pfeile ± 16 px, Home/End) zwischen 320 px und 70 % der Session-Fläche; unter 1100 px Fläche
(ResizeObserver) liegt das Panel als Overlay über dem Transkript.

| Datei | Inhalt |
| --- | --- |
| `SidePanelHost.tsx` | `SidePanelHost({sessionKey})` – im Start-Chunk nur das Nötigste: Handler der Anfragen `sidePanel` (`tab`, `null` schließt) und `openFile` (Viewer-Tab; gleiche Datei und Zeile → neu laden), Esc, Fokus (Öffnen per Anfrage fokussiert das Panel, auch wenn der Rahmen erst nachlädt: Callback-Ref), Registrierung; lädt den Rahmen lazy und beim Mounten vor |
| `SidePanelFrame.tsx` | Lazy-Chunk: der offene Rahmen (`aside`, `data-side-panel`, `data-tab`, `data-mode` `inline`/`overlay`) mit Splitter, Tabs, Verlauf (Zurück, Liste der letzten 10 Dateien), Breitenmessung (ResizeObserver) und Tab-Inhalt (`FilePanel` mit `key = revision`) |
| `state.ts` | offener Tab je `sessionKey` (`useSidePanelTab`, `getSidePanelTab`, `openSidePanel`, `closeSidePanel` → Auslöser), Ziel des Viewer-Tabs (`useSidePanelFile`, `getSidePanelFile`, `setSidePanelFile` – gleiche Datei in jeder Schreibweise: nur Zeile/Spalte bzw. `revision`; andere Datei → Verlauf), Verlauf (`useSidePanelHistory`, `goBackSidePanelFile`, max. `SIDE_PANEL_HISTORY_MAX` = 10), gemountete Hosts (`registerSidePanelHost`, `useSidePanelHostMounted`, `isSidePanelHostMounted` – ohne Host klappen Features inline auf, R2W-15), `resetSidePanelState` (Tests) |
| `width.ts` | Breite: `SIDE_PANEL_MIN_WIDTH`, `SIDE_PANEL_MAX_SHARE`, `SIDE_PANEL_OVERLAY_BELOW`, `defaultSidePanelWidth` (min(672 px, 45 %)), `clampSidePanelWidth`, `isSidePanelOverlay`; gespeichert je Fenster (`sessionStorage`, Vorgabe für neue Fenster in `localStorage`, beides in try/catch) |
| `i18n/en.ts`, `i18n/de.ts` | Namespace `sidePanel` (Tab-Namen, Schließen, Breite, Verlauf), registriert in `src/web/i18n/dictionaries.ts` (en, statisch) bzw. `dictionary.de.ts` (de, Lazy-Chunk, ADR-153) |

Features öffnen das Panel nur über `requestShell({kind: 'sidePanel' | 'openFile', …})` und lesen
höchstens den Zustand aus `state.ts` (Features dürfen Shell-Bausteine importieren, nie umgekehrt).
