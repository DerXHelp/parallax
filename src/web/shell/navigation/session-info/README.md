# src/web/shell/navigation/session-info – Reiter der Session-Info (WP-67)

Auftrag und Ergebnis: `docs/wp/WP-67.md`. Der Dialog selbst ist `../SessionInfoDialog.tsx` (Lazy-Chunk
aus `../NavigationLayer.tsx`); hier liegen seine Reiter. Jeder Reiter außer der Übersicht ist ein
eigener Lazy-Chunk und fragt den laufenden Claude-Code-Prozess erst beim Öffnen (`session.info`) – kein
Polling, kein Cache. Fehler zeigt der Reiter selbst (`Alert`), nie ein Toast. Status-Zeilen können
Kontodaten tragen: nichts davon wird gespeichert oder geloggt.

| Pfad | Inhalt |
| --- | --- |
| `OverviewTab.tsx` | Übersicht aus `detail.init` (der Dialog vor WP-67), ohne Anfrage |
| `use-session-info.ts` | `useSessionInfo(sessionKey, section)`: Laden, Aktualisieren, „Session starten“ (`session.resume`), Zustände `loading`/`ready`/`unavailable`/`notRunning`/`failed`; `errorDetail` |
| `SectionFrame.tsx` | Rahmen jedes Live-Reiters (Werkzeugleiste, „Aktualisieren“, Zustände), `InfoError`, `TruncatedNote`, `ExtraRows`, `SettingsErrors` |
| `McpTab.tsx` | MCP-Server mit Status, Bereich, Transport, Werkzeugen, Fehler; Neu verbinden, An/Aus (Rückfrage vor „Aus“) über `session.mcpAction` |
| `PermissionsTab.tsx` | Regeln nach Erlauben/Fragen/Verbieten und Quelle, Filter, Arbeitsverzeichnis, weitere Verzeichnisse |
| `SkillsTab.tsx` | Tabelle Name/Quelle/Tokens/Zustand (gesperrt durch), Summe, Sortierung nach Tokens, Skills/Plugins neu laden (`session.reload`) |
| `MemoryTab.tsx` | CLAUDE.md-Dateien mit Ebene, Pfad als `FileLink` (`verify`) + „Pfad kopieren“, Ordner, Erinnerungen, Schalter nur angezeigt |
| `HooksTab.tsx` | Hooks nach Event und Matcher, Befehl in Monospace, Policy-/Safe-/Bare-Mode-Hinweise |
| `StatusTab.tsx` | Zeilen von `/status` in ihren Abschnitten |
| `ExportTab.tsx` | Vorschau (≤ 20 000 Zeichen), Kopieren, Speichern per Browser-Download (`@web/lib/download`) |
| `tabs.ts`, `labels.ts` | Reiter-Reihenfolge, letzter Reiter (localStorage), Quellen-Namen, Filter |
| `i18n/{en,de,index}.ts` | Lazy-Namensraum (`useInfoT`, `translateFrom`) – kommt mit dem Dialog-Chunk, nie mit dem Start-Chunk |
| `*.test.tsx`, `i18n/i18n.test.ts` | Zustände des Rahmens, Wörterbuch-Parität und Nutzung; der ganze Dialog: `../session-info.test.tsx` |
