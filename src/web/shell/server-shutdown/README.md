# src/web/shell/server-shutdown – „Server beenden“ (WP-21)

Menüpunkt im Einstellungsmenü (`SettingsMenu.tsx`) und die ausdrücklich bestätigte Rückfrage
(A.10: nennt die arbeitenden und wartenden Sessions, WP-02 §7.5: aus den Summaries des Clients),
danach `server.shutdown`. Der Server bestätigt zuerst und schließt dann jede Verbindung mit 4503 –
`HostGate` zeigt „Parallax-Server beendet“.

| Datei | Inhalt |
| --- | --- |
| `ServerShutdownDialog.tsx` | `ServerShutdownDialog` (einmal neben dem Menü gemountet; lädt den Inhalt erst beim Öffnen), `openServerShutdown`, `closeServerShutdown` |
| `ShutdownConfirmation.tsx` | WP-70: der Inhalt der Rückfrage (Sessions, Fehler, Bestätigen) als Lazy-Chunk – erst nach dem Klick im Menü gebraucht (Start-Chunk-Budget) |
| `impact.ts` | `shutdownImpact(entries, now)` → `{ working, waiting, idle }` (rein, über `deriveDisplayStatus`/`orderSessions`) |
| `i18n/en.ts`, `i18n/de.ts` | Texte des Namespace `serverShutdown` (`de: typeof en`), registriert in `src/web/i18n/dictionaries.ts` (en, statisch) bzw. `dictionary.de.ts` (de, Lazy-Chunk, ADR-153; vorher `index.ts`, WP-20b) – Aufruf `t('serverShutdown.<key>')` |
