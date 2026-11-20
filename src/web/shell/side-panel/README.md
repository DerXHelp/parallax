# src/web/shell/side-panel – Seitenpanel-Host (Phase 3)

Owner: **WP-54** (Gerüst aus WP-50 Teil 2). Design: `docs/wp/WP-50.md` §4.14 C, ADR-150; Ergebnis:
`docs/wp/WP-54.md`.

Der Rahmen des Seitenpanels einer Session-Pane: `aside` neben dem Transkript, Tab-Zeile Plan ·
Datei (nur mit offener Datei) · Dateien · Aufgaben · Agent (WP-69, nur nach „Verlauf“ an einer Agent-Karte) mit Schließen, Esc im Panel, Fokus-Rückgabe an
den Auslöser; nicht modal, keine Fokusfalle. Die Tabs rendern die Feature-Slots `PlanPanel`,
`FilePanel`, `FilesPanel`, `TasksPanel`, WP-69 `SubagentPanel` (`shell/slots.tsx`). Breite per Splitter (`@web/ui/splitter`,
Pfeile ± 16 px, Home/End) zwischen 320 px und 70 % der Session-Fläche, neben dem Transkript höchstens so breit, dass
diesem 360 px bleiben. Erst unter 680 px Fläche (ResizeObserver) liegt das Panel als Overlay über dem Transkript
(ADR-240; bis dahin schon unter 1100 px). WP-93: „Breit“ neben „Schließen“ nimmt die größte
erlaubte Breite, bis der Splitter bewegt wird.

| Datei | Inhalt |
| --- | --- |
| `SidePanelHost.tsx` | `SidePanelHost({sessionKey})` – im Start-Chunk nur das Nötigste: Handler der Anfragen `sidePanel` (`tab`, `null` schließt), `openFile` (Viewer-Tab; gleiche Datei und Zeile → neu laden) und WP-69 `openSubagent` (Tab „Agent“ mit diesem Subagenten), Esc, Fokus (Öffnen per Anfrage fokussiert das Panel, auch wenn der Rahmen erst nachlädt: Callback-Ref), Registrierung; lädt den Rahmen lazy und beim Mounten vor |
| `SidePanelFrame.tsx` | Lazy-Chunk: der offene Rahmen (`aside`, `data-side-panel`, `data-tab`, `data-mode` `inline`/`overlay`) mit Splitter, Tabs, Verlauf (Zurück, Liste der letzten 10 Dateien), Breitenmessung (ResizeObserver) und Tab-Inhalt (`FilePanel` mit `key = revision`, WP-69 `SubagentPanel` mit `key = agentId`; Tab „Agent“ trägt den Titel des Subagenten); WP-74: × neben dem Datei- und dem Agent-Tab (`data-tab-close`, Geschwister des Triggers), die Tab-Leiste ohne Scrollbalken (`overflow-y-hidden`, `scrollbar-width: none`), der aktive Tab scrollt in den Blick |
| `state.ts` | offener Tab je `sessionKey` (`useSidePanelTab`, `getSidePanelTab`, `openSidePanel`, `closeSidePanel` → Auslöser), Ziel des Viewer-Tabs (`useSidePanelFile`, `getSidePanelFile`, `setSidePanelFile` – gleiche Datei in jeder Schreibweise: nur Zeile/Spalte bzw. `revision`; andere Datei → Verlauf), Verlauf (`useSidePanelHistory`, `goBackSidePanelFile`, max. `SIDE_PANEL_HISTORY_MAX` = 10), gemountete Hosts (`registerSidePanelHost`, `useSidePanelHostMounted`, `isSidePanelHostMounted` – ohne Host klappen Features inline auf, R2W-15), WP-69 Subagent des Tabs „Agent“ (`useSidePanelSubagent`, `getSidePanelSubagent`, `setSidePanelSubagent` – je Session einer, der zuletzt geöffnete), WP-93 `useSidePanelWide`/`setSidePanelWide` (je Session, nicht gespeichert), WP-74 `rememberSidePanelReturn` (der Tab, von dem aus Datei bzw. Agent geöffnet wurde) und `closeSidePanelItem` (schließt die Datei samt Verlauf bzw. den Agent; zurück zum gemerkten Tab, ohne ihn `null` → der Rahmen schließt das Panel), `resetSidePanelState` (Tests) |
| `width.ts` | Breite: `SIDE_PANEL_MIN_WIDTH`, `SIDE_PANEL_MAX_SHARE`, `SIDE_PANEL_OVERLAY_BELOW`, `defaultSidePanelWidth` (min(672 px, 45 %)), `clampSidePanelWidth`, `isSidePanelOverlay`; gespeichert je Fenster (`sessionStorage`, Vorgabe für neue Fenster in `localStorage`, beides in try/catch); WP-92: alle Werte in Layout-px – `SidePanelFrame` teilt die gemessene Fläche durch den Zoom und zeichnet die Breite mit ihm |
| `i18n/en.ts`, `i18n/de.ts` | Namespace `sidePanel` (Tab-Namen, Schließen, Breit, Breite, Verlauf), registriert in `src/web/i18n/dictionaries.ts` (en, statisch) bzw. `dictionary.de.ts` (de, Lazy-Chunk, ADR-153) |

Features öffnen das Panel nur über `requestShell({kind: 'sidePanel' | 'openFile' | 'openSubagent', …})` und lesen
höchstens den Zustand aus `state.ts` (Features dürfen Shell-Bausteine importieren, nie umgekehrt).
