# e2e – Playwright-Tests in Chrome (WP-20c, ADR-136)

E2E-Tests (`*.spec.ts`) mit `@playwright/test` im installierten Google Chrome (`channel: 'chrome'`,
headless, siehe `playwright.config.ts`). **Kein Browser-Download, kein Live-`claude`.** Die App läuft
als echter Server-Build (`dist/server.js`) mit dem FakeBackend (interaktives Szenario,
Schlüsselwörter `fake:permission`, `fake:question`, `fake:plan`, `fake:slow`, `fake:crash` … –
`docs/wp/WP-13a.md`; Phase 3 `fake:files`, `fake:background`, `fake:todo`, `fake:writes-lost`,
`fake:context-high` (Context dauerhaft 75 % – Hervorhebung „Empfohlen“ der Plan-Karte) –
`src/server/backend/fake/README.md`). Echte Fake-Dateien liegen unter `<home>\fake-files` des
Temp-Homes und verschwinden mit ihm.

```powershell
pnpm e2e                                   # alle Fälle (baut dist/ bei Bedarf), ohne e2e/live
pnpm e2e e2e/decisions.spec.ts             # eine Datei
pnpm e2e -g "plan:"                        # nach Titel
$env:PARALLAX_E2E_SKIP_BUILD='1'; pnpm e2e # ohne Build-Prüfung
```

| Datei | Inhalt |
|---|---|
| `global-setup.ts` | baut `dist/` nur, wenn es fehlt oder die Build-ID nicht passt (wie der Launcher; Prüfung und Build unter dem Build-Lock des Checkouts, ADR-092); setzt für Runner und Worker ein eigenes Temp-`PARALLAX_HOME` und Port 0 und entfernt geerbte Server-Steuervariablen (`test/setup/home.ts`, WP22-07) |
| `support/server.ts` | Server je Worker: `node dist/server.js --backend=fake --port=0 --home=<tmp>`, bereit = Lockfile + Health, Anmelde-URL über `POST /api/launcher/code`, Ende über `server.shutdown` mit Prüfung (Exit 0, Lockfile weg, keine Kindprozesse, keine Fehlerzeilen im Log); `adoptE2eServer` für einen vom Launcher gestarteten Server; `reuse` startet einen neuen Server auf dem Home eines beendeten (Neustart-Fälle); `serverSettings` liest die **gespeicherten** Einstellungen (`host.state` eines frischen Node-Clients) – eine Einstellung gilt erst als gespeichert, wenn der Server sie hat, nicht schon bei der optimistischen Anzeige (R4W-27) |
| `support/fixtures.ts` | Fixtures `server` (Worker), `app` (angemeldete Seite), `newWindow()` (zweites Fenster, gleiches oder neues Profil); Worker-Option `ownServer` (WP-60: eine Datei mit `test.use({ ownServer: '<label>' })` bekommt einen eigenen Worker samt Server und Temp-Home); Diagnose: CSP-Verletzung oder Seitenfehler lässt den Test scheitern, WS-Frames + Server-Log als Artefakte |
| `support/app.ts` | Page-Objects (`ParallaxApp`, `SessionView`) über die Test-Attribute (`data-slot`, `data-action` …); Phase 2: Sidebar-Zeilen, Kontextmenü, Kopfzeilen-Menü, Einstellungsseite; Phase 3: `sidePanel`, `filePanel`, `panelButton`/`openPanel`/`panelTab`, `fileLink`, `openFile`. **Menüs:** einen Eintrag immer mit `chooseMenuItem` (bzw. `headerAction`/`rowAction`) wählen – es wartet, bis das Menü ganz weg ist; die Öffner (`headerMenu`, `rowMenu`, `openSettings`) starten erst, wenn kein Menü mehr da ist. Ein geschlossenes Radix-Menü bleibt während seiner Exit-Animation (150 ms) eine aktive Ebene und stört sonst den nächsten Schritt (FIX-E2E-EDGE157) |
| `support/presence.ts` | Init-Script `recordNotifications` (Fenster „im Hintergrund“ per `hasFocus`/`visibilityState`, Web Notifications und `AudioContext`-Oszillatoren aufgezeichnet, zuletzt **gesendete** Präsenz aus `clientHello`/`presence`-Frames), `setPresence` (wartet auf den gesendeten Präsenz-Frame statt fester Zeit, R4W-10), `toasts`, `tones`, `clickLastToast` |
| `support/dom.ts` | DOM-Typen für die Browser-Callbacks (tsconfig.tools.json kennt nur Node) und die Rekorder der Init-Scripts als `Window`-Felder (`declare global`, statt `as unknown as`, R4W-27) |
| `recovery.spec.ts` | WP-22 F5 (Absturz von `claude.exe` im Turn → `error`, nächster Prompt startet neu) und F3 (offene Plan-Karte bei „Server beenden“ → nach dem Neustart `needs-resume`, „Fortsetzen & umsetzen“) |
| `support/files.ts` | Phase 3 (WP-60): Beispieldateien je Viewer-Art (`writeSampleFiles`: Markdown, Text, PNG, PDF, Text > `fileTextBytes`), `logMessages` (`msg` der Server-Logzeilen, z. B. `file.open (fake): …` des aufzeichnenden Öffners), `rejectedRequests` (vom Guard abgelehnte Anfragen aus dem Server-Log – den Status einer CORS-blockierten Antwort sieht die Seite nicht), `recordTexts`/`seenTexts` (merkt jeden Text eines Selektors per `MutationObserver` – für Zustände, die nur Frames dauern, statt fester Wartezeit), `recordTextShown`/`textShownAt` (Zeitpunkt, zu dem ein Text zuerst erscheint – Zeitgrenzen der App ohne die Wiederholpause einer Assertion, FIX-R5-F6) |
| `phase3-*.spec.ts` | Phase-3-Verifikation (WP-60, Liste in `docs/wp/WP-60.md` §2; Fälle der Fix-Runde R5 in `docs/wp/FIX-R5-F6.md`): `files` (Viewer, Guard `/api/file` L16, UNC L15, „Dateien dieser Session“, Editor/Explorer, Pfade mit Leerzeichen/Umlauten V4-01), `plan` (Live-Datei, v1 → v2 mit Diff, frischer Kontext, gemerkte Wahl, Kopfzeile „Plan“; „Empfohlen“ bei 75 % Context mit `fake:context-high`), `tasks` (Hintergrund-Agent, Stopp je Task, Composer-Stopp, To-do-Leiste), `composer` (PDF/.xlsx, Paste-Chip, @-Picker mit und ohne git, Paste mit führendem `/` R5W-03, @-Picker-Rangfolge V4-03), `shell` (schmales Fenster, `fake:writes-lost`, Slot-Fehlergrenze, blockierter `FileLink`-Chunk R5W-02). Jede Datei läuft mit `test.use({ ownServer: '<label>' })` auf einem eigenen Server (eigener Worker, eigenes Temp-Home); die Viewer-Fälle 1600 px breit (Panel neben dem Transkript) |
| `wp63-feedback.spec.ts` | WP-63: „Aus Parallax entfernen“ (offene Session über das „…“-Menü → Übersicht; „Archiv aufräumen“ mit „Alle auswählen“; Ordner `entries\<id>` bleiben; nach Neustart weg) und kompaktes Transkript (`fake:steps`: zwei Gruppen, Fehlerzähler, auf/zu; `fake:images`: Galerie bei zugeklappter Gruppe, Lightbox ← →; `fake:limit-warning`: nur die Limit-Leiste; „Alle Schritte“ in den Einstellungen). Eigener Server je Test. Andere Specs, die einzelne Tool-Zeilen prüfen, öffnen die Gruppen vorher (`SessionView.expandSteps()`) |
| `wp64-remote-control.spec.ts` | WP-64 Remote Control (Fake-Bridge): Einschalten über das „…“-Menü → Symbol in Kopfzeile und Zeile; `fake:remote-prompt` mit Hinweis „From the Claude app“ und Antwort; `fake:remote-permission` → Karte verschwindet von selbst, „Answered in the Claude app“; `fake:remote-fail` → Warnzustand mit Fehlertext; Serverneustart → „verbindet beim Start“, nächster Prompt verbindet mit demselben Link (WP-65: „In der Claude-App öffnen“ über `link.open` – Server-Log `link.open (fake): …`, `window.open` bleibt unbenutzt). Der Leerlauf-Schlaf (mindestens 5 min) steht im Engine-Test. Eigener Server je Test |
| `wp65-overview.spec.ts` | WP-65: Zeile unter dem Namen (`fake:summary`: Parallax-Wörter, Fazit; mit Remote Control CLI-Satz und -Fazit; Kopfzeile), Limit-Leiste allein aus der Nutzungsabfrage (erste Runde 10 s nach dem Start) mit Reset-Tooltip, „Seit du zuletzt hier warst“ (Turn per Node-Client, während eine andere Session gezeigt wird: Turn, Dateien, Fazit, Sprung, Schließen), Auto-Titel / eigener Titel bleibt / „Titel neu erzeugen“, „In den Hintergrund“ und Strg+B (`fake:long-bash`). Eigener Server für die Datei (`ownServer`) |
| `phase2-*.spec.ts` | Phase-2-Verifikation (WP-40): Sessions parallel + Statuskette, Navigation, Neue Session + Profile, Composer, Lebenszyklus, Einstellungen – Liste in `docs/wp/WP-40.md` §2; Fälle der Fix-Runde R4 (Profil-Entwurf, Datei-Drop, Fokus nach Esc, `/vim` ohne Esc, Git-Branch) in `docs/wp/FIX-R4-F5.md` |
| `*.spec.ts` | Fälle Phase 1 (Liste in `docs/wp/WP-20c.md`); `notifications.spec.ts` mit Tönen (WP-40); `smoke.spec.ts` prüft zusätzlich, dass der Chunk `dictionary.de-*.js` erst nach dem Umschalten auf Deutsch geladen wird (ADR-153) |
| `live/` | **Live-Smoke gegen das installierte `claude`** (WP-22): nur mit `PARALLAX_LIVE=1` (siehe unten) |

Artefakte (Screenshots, Traces, `server-w<n>.log`) landen in `test-results/` (git-ignoriert). Tests,
die Einstellungen ändern oder den Server beenden, starten einen eigenen Server.

## `e2e/live/` – Live-Smoke (nur mit Freigabe)

```powershell
$env:PARALLAX_LIVE='1'; pnpm e2e e2e/live      # ≈ 1,5 min, ≈ 0,01 USD (Haiku)
```

- Ohne `PARALLAX_LIVE=1` ignoriert `playwright.config.ts` den Ordner (`testIgnore`), zusätzlich
  überspringt sich die Datei selbst – `pnpm e2e` ruft nie das echte `claude` auf.
- `live.spec.ts` + `support/live.ts`: echter Server-Build mit `--backend=sdk`, Temp-Home, Port 0,
  `--validate=log`, `--toasts=off`, `ANTHROPIC_MODEL=haiku`; startet nicht, wenn
  `ANTHROPIC_API_KEY`/`_AUTH_TOKEN`/`_BASE_URL` gesetzt sind; prüft nach dem ersten Turn
  `apiKeySource: none` und Haiku, Budget je Prompt `PARALLAX_LIVE_BUDGET_USD` (Default 0,50).
- Abläufe: CLI-Version, Permission „Einmal erlauben“ → echte Datei, AskUserQuestion, Stop, Reload
  mit offener Karte, keine Validierungs-Drops, sauberes Ende. Artefakte `test-results/server-live.log`,
  `live-cost.txt`, `live-run.json` (Kosten + Temp-Wurzel für den Rückbau von `pnpm cli-check`, WP-62;
  dort liegt der Ausgabeordner unter `test-results/cli-check/<zeit>-smoke/`). Nur mit Nutzer-Freigabe
  ausführen (Abo-Login, Kosten; Dauerfreigabe nur über `pnpm cli-check`) – Ablauf und Einordnung:
  `docs/sdk-upgrade.md` Schritt 7 und „Stufe 1“.
