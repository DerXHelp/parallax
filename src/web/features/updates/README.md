# src/web/features/updates – Update-Oberfläche (WP-88a)

Auftrag: `docs/wp/WP-87.md` §2.3, Ergebnis und Abweichungen: `docs/wp/WP-88a.md`. Füllt die Slots `UpdateNotice` (Kopf
der Sidebar), `UpdateBanner` (ShellBanners) und `UpdatesSettings` (Einstellungen, Abschnitt `updates`); Zustand aus
`HostState.update`/`HostState.app` des **lokalen** Hosts (`useHostState()`), Befehle `update.*` über `sendCommand`,
Routen `/api/update/package`, `/api/changelog`, `/api/notices`. Namensraum `updates` (`i18n/{en,de}.ts`).

| Datei | Inhalt |
| --- | --- |
| `index.ts` | `UPDATES_SLOTS` (`UpdateNotice`, `UpdateBanner`, `UpdatesSettings`), alle drei als Lazy-Chunks; Hinweis und Banner prüfen vorher billig `HostState.update` (ohne Update wird nichts geladen). WP-89 verdrahtet sie in `App.tsx` |
| `UpdateNotice.tsx` | Dezenter Knopf „Parallax <v> verfügbar“ / „… bereit – neu starten“ bei `available`/`ready`, wenn die Version nicht `dismissedVersion` ist; Klick → `requestShell({kind:'settings', section:'updates'})`, Kreuz → `update.dismiss {what:'available'}`; `compact` (Leiste): nur Symbol, Text als Name und Tooltip |
| `UpdateBanner.tsx` | `failedUpdate` als Fehler-Streifen (`Banner tone="error"` = `role="alert"`): Text, `tError` + Zusatzzeile, Log-Pfad mit Kopierknopf; `justUpdated` als Erfolgs-Streifen „Aktualisiert auf <to>“ bzw. „Gewechselt auf <to> (vorher <from>)“ (`compareVersions`) mit „Was ist neu“; „Ausblenden“ → `update.dismiss` |
| `UpdatesSettings.tsx` | Abschnitt „Updates“: Version + Build-ID, Status (Live-Region) mit Fortschritt, Größe/Datum, „Was ist neu in <v>“; Knöpfe „Jetzt prüfen“, „Jetzt aktualisieren“ (Kommando `update.prepare`), „Neu starten“, „Aus Datei installieren…“ (verstecktes `<input type=file accept=.zip>`), „Zurück zu <p>“ (Hinweis bei `needsRestore`, gesperrt ohne `backupAt`); Schalter „Automatisch nach Updates suchen“ (`updateSettings({updates})`); Links „Was ist neu“, Lizenz, Drittkomponenten. Ohne Paket: „Entwicklungsstand <buildId> – Updates über git“ und nur „Was ist neu“ |
| `components/SwitchDialog.tsx` | Bestätigung von „Neu starten“/„Zurück zu“: betroffene Sessions des lokalen Hosts (`shutdownImpact` aus `shell/server-shutdown/impact.ts`), bei `needsRestore` Warnung mit Datum der Sicherung + Häkchen → `acceptDataLoss`; ohne Sicherung gesperrt; Fehler im Dialog |
| `components/WhatsNewDialog.tsx` | „Was ist neu“: `GET /api/changelog`, Abschnitte über den `Markdown`-Slot, Fehler mit „Erneut versuchen“ im Dialog |
| `components/NoticesDialog.tsx` | Lizenz/Drittkomponenten: `GET /api/notices`, `<pre>` in `ScrollArea` (fokussierbar), Fehler im Dialog |
| `components/UpdateErrorAlert.tsx` | `Alert` mit `tError` + Zusatzzeile aus `lib/error-detail.ts` |
| `lib/update-state.ts` | Reine Regeln: `updateNotice`, `hasUpdateBanner`, `isVersionBack`, `whatsNewSince`, `isUpdateBusy`, `isPackaged` |
| `lib/error-detail.ts` | `updateErrorDetail(error, t)`: eine übersetzte Zeile aus `reason`/`status`/`file`/`required`/`actual`/`version` der Update-Codes (und `VALIDATION_FAILED {reason: version \| data_loss_not_accepted}`); unbekannte Gründe → keine Zeile |
| `lib/api.ts` | `fetchChangelog`, `fetchNotices`, `uploadUpdatePackage` (zod für jede Antwort, `ErrorPayload` bzw. Code aus dem HTTP-Status, `CONNECTION_LOST`; Upload > `UPDATE_PACKAGE_MAX_BYTES` → `PAYLOAD_TOO_LARGE` ohne Senden); austauschbar per `setUpdateHttp` (Playground) |
| `state/use-request.ts` | `useRequest(key, load)`: ein GET je Schlüssel mit Abbruch und `retry` (Dialoge) |
| `testing.ts` | Fixtures (nie im Produktivcode): `PACKAGED_APP`, `CHECKOUT_APP`, `updateHostState`, `restartSessions`, `startUpdatesHost` (FakeHost als Host `local`) |
| `playground.tsx` | Demos `#playground=updates/<id>` (Abschnitt mit Auswahl der `SAMPLE_UPDATE_STATES`, Klon, Hinweis breit/Leiste, Banner); Anfragen aus einem Fake (kein Server hinter Vite) |
