# WP-88a – Update-Oberfläche (`src/web/features/updates/**`)

Branch `wp/88a` von `feature/releases` (nach WP-87-0, `902663c`). Auftrag: `docs/wp/WP-87.md` §2.3 (Contracts §1.1–§1.6,
Web-Gerüst §1.8). Besitz: `src/web/features/updates/**` und diese Datei.

## 1. Ergebnis

| Teil | Umsetzung |
|---|---|
| Slots | `UPDATES_SLOTS` in `index.ts`: `UpdateNotice`, `UpdateBanner`, `UpdatesSettings`, je ein Lazy-Chunk. Hinweis und Banner prüfen vorher billig `HostState.update` (`updateNotice`, `hasUpdateBanner`), ein Fenster ohne Update lädt nichts. `App.tsx` bleibt unverändert (WP-89). |
| `UpdateNotice` | Dezenter Ghost-Knopf (Stil wie „neuer als geprüft“: gedämpfter Text, Akzent nur am Symbol) „Parallax <v> verfügbar“ / „Parallax <v> bereit – neu starten“ bei `available`/`ready` mit `available.version ≠ dismissedVersion`; Klick → `requestShell({kind:'settings', section:'updates'})`; Kreuz → `update.dismiss {what:'available'}` (Fehler als Hinweis über `showErrorNotice`). `compact`: nur Symbol (`IconButton`, Tooltip rechts, Name = Text) mit Punkt, ohne Kreuz. |
| `UpdateBanner` | `failedUpdate`: Fehler-Streifen mit `role="alert"` – „Update auf Parallax <v> fehlgeschlagen – zurück auf <restoredTo>“, `tError`, Zusatzzeile, Log-Pfad (`select-text`) mit `CopyButton` (Hinweis „kopiert“), „Ausblenden“ → `update.dismiss failedUpdate`. `justUpdated`: Erfolgs-Streifen „Aktualisiert auf Parallax <to>“ bzw. „Gewechselt auf Parallax <to> (vorher <from>)“ bei `compareVersions(to, from) < 0`; „Was ist neu“ mit `since = from` (nur vorwärts, sonst eigener Abschnitt); „Ausblenden“ → `update.dismiss justUpdated`. |
| `UpdatesSettings` | Installierte Version + Build-ID (`HostState.app`, ältere Hosts: `serverVersion`); Statuszeile als Live-Region (`role="status"`) mit Drehsymbol bzw. Fortschritt (`Progress` + Prozent); Größe/Datum des Angebots, Hinweis bei `downgrade`, „Was ist neu in <v>“, „Zuletzt geprüft …“. Knöpfe je Status (Tabelle §2). Fehler des Hosts (`update.error`, Ton nach `errorSpec().severity`, „Ausblenden“ → `update.dismiss error`), abgelehnte Befehle und Upload-Fehler zeigt der Abschnitt selbst. Schalter „Automatisch nach Updates suchen“ → `updateSettings({updates: {...updates, check}})` (optimistisch, Fehler inline). Links „Was ist neu“, Lizenz, Drittkomponenten. Klon/`pnpm dev` (`status: 'unsupported'` oder `app.packaged` false): „Entwicklungsstand <buildId> – Updates über git“ und nur „Was ist neu“. |
| Dialoge | `SwitchDialog` (Bestätigung „Neu starten“/„Zurück zu“, s. §3), `WhatsNewDialog` (`GET /api/changelog`, Abschnitte über den `Markdown`-Slot, Datum in UTC formatiert), `NoticesDialog` (`GET /api/notices`, `<pre>` in `ScrollArea`, fokussierbar zum Scrollen per Tastatur). Jeder Dialog zeigt seine Fehler selbst (`Alert` Ton `error` = `role="alert"`, bei GET mit „Erneut versuchen“). |
| HTTP | `lib/api.ts`: jede Antwort per zod (`changelogResponseSchema`, `noticesResponseSchema`, `updatePackageResponseSchema`); Fehlerantwort als `ErrorPayload`, sonst Code aus dem Status (401, 404 → `FILE_NOT_FOUND`, 413, 415, sonst `INTERNAL_ERROR {status}`); Netzfehler `CONNECTION_LOST`; ungültige Antwort `INVALID_MESSAGE`. Upload: Rohdaten, immer `Content-Type: application/zip`, `credentials: same-origin`. |
| Zusatzzeile | `lib/error-detail.ts`: `reason` von `UPDATE_CHECK_FAILED`/`UPDATE_DOWNLOAD_FAILED` (bei `http` mit `status`, ohne Status ein neutraler Satz), `file` (`UPDATE_INVALID_SIGNATURE`), `reason` (`UPDATE_INVALID_PACKAGE`), `status` (`UPDATE_BUSY`), `required`/`actual` (`UPDATE_NODE_TOO_OLD`), `version` (`UPDATE_DOWNGRADE_BLOCKED`), alle `UPDATE_RESTART_FAILED_REASONS`, dazu `VALIDATION_FAILED {reason: version \| data_loss_not_accepted}` (§1.3). Unbekannte Werte ergeben keine Zeile, nie einen Rohwert. |
| i18n | Namensraum `updates` (en/de, gleiche Form), übernommen aus dem Gerüst. |
| Playground | `playground.tsx` (per `import.meta.glob` gefunden, keine fremde Datei nötig): Abschnitt mit Auswahl aller `SAMPLE_UPDATE_STATES` (Szenario `overview`, damit „Neu starten“ Sessions nennt), Klon, Hinweis breit/Leiste, Banner. Kein Server hinter Vite: die Anfragen kommen aus einem Fake über `setUpdateHttp`; „Aus Datei“ prüft dort kurz und bietet 1.0.0-rc.4 an. `slots` setzt die echten Komponenten in die Shell-Demos. |

## 2. Knöpfe je Status (Installation)

| Status | Neu starten | Vorbereiten | Jetzt prüfen | Aus Datei | Zurück zu <p> |
|---|---|---|---|---|---|
| `idle` | – | – | aktiv | aktiv | aktiv¹ |
| `checking` | – | – | gesperrt („Prüfe…“) | gesperrt | gesperrt¹ |
| `available` | – | aktiv | aktiv | aktiv | aktiv¹ |
| `downloading`, `preparing` | – | – | gesperrt | gesperrt | gesperrt¹ |
| `ready` | aktiv | – | aktiv | aktiv | aktiv¹ |
| `restarting` | – | – | gesperrt | gesperrt | gesperrt¹ |

¹ nur mit `previous`; bei `needsRestore` ohne `backupAt` immer gesperrt, mit Begründung darunter. Zusätzlich gesperrt
während eines eigenen Befehls oder Uploads und ohne Verbindung. „Aus Datei“ nur in `idle`/`available`/`ready` (wie der
Dienst, §2.1).

## 3. Entscheidungen und Abweichungen

1. **Fehler-Streifen statt Kasten:** `failedUpdate` nutzt `Banner tone="error"` aus `@web/ui/alert` (rendert
   `role="alert"`), nicht den gerahmten `Alert` – passend zu den übrigen Streifen in `ShellBanners`. Die Semantik
   (`role="alert"`) ist die geforderte.
2. **Eine Bestätigung für beide Wechsel:** Auch „Zurück zu <p>“ startet den Server neu und beendet Sessions, daher zeigt
   `SwitchDialog` für `update.apply` und `update.rollback` die betroffenen Sessions (`shutdownImpact`, nur Host `local`).
   Die Datenverlust-Warnung mit Häkchen kommt immer, wenn das Ziel `needsRestore` hat – auch bei `update.apply`
   (älteres Paket aus Datei), denn der Contract verlangt dort ebenso `acceptDataLoss` (§1.3). Ohne `backupAt` ist der
   Wechsel gesperrt. Das Ack schließt den Dialog; danach übernimmt die Shell (4504, WP-88b).
3. **Upload-Hinweis „Paket empfangen – wird geprüft“** bleibt nach dem 202, bis der Host das Paket anbietet (`ready`),
   ein *anderer* Fehler als vor dem Upload kommt oder die gesehene Prüfung (`preparing`) vorbei ist. Fehler werden nach
   Code und Parametern verglichen, nie als Objekt (jeder `host.state` wird neu geparst; Test vorhanden). Während dieser
   Prüfung sagt die Statuszeile „Prüfe das Paket…“, auch wenn `available` noch das GitHub-Angebot trägt.
4. **Client-Grenze:** Ein Paket über `UPDATE_PACKAGE_MAX_BYTES` wird gar nicht erst gesendet (`PAYLOAD_TOO_LARGE`).
5. **Doppelte Fehler:** Lehnt der Host einen Befehl ab und steht derselbe Fehler (Code + Parameter) in `update.error`,
   zeigt der Abschnitt nur den des Hosts.
6. **Klon:** ohne Schalter „Automatisch suchen“ und ohne Lizenz/Drittkomponenten (Auftrag: „nur Was ist neu“; im Klon
   fehlen die Hinweise ohnehin oft, §1.4 404).
7. **Austauschbare Anfragen** (`setUpdateHttp`) nur für den Playground, wie `setAttachmentUploader` im Composer; Tests
   mocken `fetch` direkt.

## 4. Für andere Pakete (nicht selbst geändert)

- **WP-89 (`App.tsx`):** die drei Slots wie die übrigen Lazy-Slots in `bounded(...)` hüllen, z. B.
  `UpdateNotice: bounded(UPDATES_SLOTS.UpdateNotice, (p) => p.compact)`, `UpdateBanner: bounded(UPDATES_SLOTS.UpdateBanner)`,
  `UpdatesSettings: bounded(UPDATES_SLOTS.UpdatesSettings)`.
- **Koordinator (`eslint.config.js`):** `updates` fehlt in `FEATURES`; damit greifen für den Ordner weder die
  Feature-Grenze noch `noStoreWriters`. Der Code hält beides ein (Tests lesen den Store wie andere Feature-Tests).
  `src/web/features/README.md` könnte `updates/` nennen.
- **WP-88b (`Sidebar.tsx`):** Der breite Hinweis ist eine Zeile `flex min-w-0` (Knopf `h-6` + Kreuz), passt unter den
  Kopf oder in ihn; der schmale ist ein `IconButton size="icon"` (wie „Sitzungen zeigen“ der Leiste).
- **Annahmen an WP-87a:** Upload-Fehler kommen als `ErrorPayload` mit HTTP-Status; nach dem 202 meldet der Dienst
  `preparing`. Die UI bleibt richtig, wenn er `error` dabei löscht oder behält.

## 5. Checks

- `pnpm exec vitest run src/web/features/updates src/web/i18n src/web/playground/playground.test.tsx`: grün
  (`features/updates`: 8 Dateien, 80 Tests).
- `pnpm exec eslint src/web/features/updates`: 0 Funde; `prettier --write` auf den Ordner.
- `pnpm exec tsc -b` (einmal): zwei Typfehler in Tests (nullbare Felder der Samples) gefunden und mit Guards behoben;
  nicht erneut gestartet (Auftrag: höchstens ein Lauf).
- `scripts/public-check.ts`: 0 Funde.
