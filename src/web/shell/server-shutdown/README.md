# src/web/shell/server-shutdown – „Server beenden“ (WP-21)

Menüpunkt im Einstellungsmenü (`SettingsMenu.tsx`) und die ausdrücklich bestätigte Rückfrage
(A.10: nennt die arbeitenden und wartenden Sessions, WP-02 §7.5: aus den Summaries des Clients),
danach `server.shutdown`. Der Server bestätigt zuerst und schließt dann jede Verbindung mit 4503 –
`HostGate` zeigt „Parallax-Server beendet“.

| Datei | Inhalt |
| --- | --- |
| `ServerShutdownDialog.tsx` | `ServerShutdownDialog` (einmal neben dem Menü gemountet), `openServerShutdown`, `closeServerShutdown` |
| `impact.ts` | `shutdownImpact(entries, now)` → `{ working, waiting, idle }` (rein, über `deriveDisplayStatus`/`orderSessions`) |
| `i18n/en.ts`, `i18n/de.ts` | Texte (Namespace `serverShutdown`, `de: typeof en`) |
| `i18n/index.ts` | `useShutdownT`, `translateShutdown` – Übergang, bis der Koordinator den Namespace in `src/web/i18n/index.ts` registriert; danach `t('serverShutdown.…')` |
