# src/web/shell/side-panel – Seitenpanel-Host (Phase 3)

Owner: **WP-54** (Gerüst aus WP-50 Teil 2). Design: `docs/wp/WP-50.md` §4.14 C, ADR-150.

Der Rahmen des Seitenpanels einer Session-Pane (aus dem Plan-Panel von WP-16 gehoben, Verhalten
gleich): `aside` neben dem Transkript (Breite `w-[min(42rem,45%)]`), Tab-Zeile mit Schließen,
Esc im Panel, Fokus-Rückgabe an den Auslöser; nicht modal, keine Fokusfalle. Die Tabs rendern die
Feature-Slots `PlanPanel`, `FilePanel`, `FilesPanel`, `TasksPanel` (`shell/slots.tsx`).

| Datei | Inhalt |
| --- | --- |
| `SidePanelHost.tsx` | `SidePanelHost({sessionKey})` (`data-side-panel`, `data-tab`): Handler der Anfragen `sidePanel` (`tab`, `null` schließt) und `openFile` (Viewer-Tab); Öffnen per Anfrage setzt den Fokus ins Panel, der Auslöser ist das zuvor fokussierte Element |
| `state.ts` | offener Tab je `sessionKey` (`useSidePanelTab`, `getSidePanelTab`, `openSidePanel`, `closeSidePanel` → Auslöser), Ziel des Viewer-Tabs (`useSidePanelFile`, `setSidePanelFile`), gemountete Hosts (`registerSidePanelHost`, `useSidePanelHostMounted`, `isSidePanelHostMounted` – ohne Host klappen Features inline auf, R2W-15), `resetSidePanelState` (Tests) |
| `i18n/en.ts`, `i18n/de.ts` | Namespace `sidePanel` (Tab-Namen, Schließen), statisch registriert in `src/web/i18n/index.ts` |

Features öffnen das Panel nur über `requestShell({kind: 'sidePanel' | 'openFile', …})` und lesen
höchstens den Zustand aus `state.ts` (Shell-Bausteine dürfen Features importieren, nie umgekehrt).
