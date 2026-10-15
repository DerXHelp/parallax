# WP-20c – E2E in Edge und Integrations-Fixes

> Welle 2, Teil von WP-20 (20a Server, 20b Web, 20c E2E). Worktree `.worktrees/wp-20c`, Branch
> `wp/20c`, Basis `main` = `3c2191a`, nach Aufforderung `git merge main` (`2c3fb70`, R2-Server-Fixes).
> Kein Live-`claude`, nur FakeBackend.

## Auftrag (sinngemäß)

- **Playwright-Infrastruktur** (`e2e/**`, `playwright.config.ts`): `channel: 'msedge'`, headless, kein
  Browser-Download; Global-Setup baut bei Bedarf, startet `dist/server.js` mit FakeBackend, Temp-Home,
  Port 0 (Port aus dem Lockfile), Einmal-Code über den Launcher-Endpunkt → `/#code=…`; Teardown über
  den Shutdown-Befehl mit Prüfung auf übrig gebliebene Kindprozesse; ein Server je Worker; optional
  ein Test über den echten Launcher.
- **E2E-Fälle (Phase-1-Verifikation):** Auth, Neue Session + Streaming, Permission einmal/immer/
  Ablehnung mit Begründung, AskUserQuestion, Plan revise → v2 → Umsetzen mit Modus, Ziel-Sperre,
  Stop, Warteschlange, Reload mit offener Karte, zwei Fenster, Benachrichtigungen, „Server beenden“,
  R2W-07 a–f, en/de und dark/light mit Screenshot.
- **Integrations-Bugs** an der Naht Server↔Web minimal beheben, je mit Test.
- **Nach `git merge main`:** SDK im Bundle lazy, `pnpm start -- --port=…`, Home-Lock verdrahten
  (`docs/wp/R2.md` „Umsetzung“), notierte Bugs in `src/server/{backend,sessions,launcher,lib,claude}`.
- `package.json` nur Script `e2e`; keine neuen Abhängigkeiten. Abnahme: `pnpm e2e` 3× grün (1× unter
  Vitest-Last), `pnpm check`, `pnpm build`, keine Prozesse übrig.

---

## Ergebnis

**Status:** fertig. Ergebnisse der Läufe: „Checks“ unten.

### Bedienung

```powershell
pnpm e2e                                   # baut dist/ bei Bedarf (Build-ID), dann alle Fälle
pnpm e2e e2e/windows.spec.ts               # eine Datei
$env:PARALLAX_E2E_SKIP_BUILD='1'; pnpm e2e # ohne Build-Prüfung (dist/ muss passen)
```

- Je Worker (3) ein Server `node dist/server.js --backend=fake --port=0 --home=%TEMP%\parallax-e2e-w<n>-…\home`
  mit `NODE_ENV=test` (Hub und Transkript-Store validieren ausgehende Werte mit `throw`), Edge headless
  mit eigenem Profil je Kontext. Ende: `server.shutdown` über einen Node-WS-Client → Close 4503 → Exit 0,
  Lockfile weg, PID tot, keine Kindprozesse (`childProcesses`, dreiwertig), **keine Zeile ≥ error im
  Server-Log** – sonst scheitert der Worker.
- Jeder Test: eine CSP-Verletzung (`securitypolicyviolation`, R2W-07 f) oder ein Seitenfehler
  (`pageerror`) lässt ihn scheitern; Konsolenfehler, WS-Frames (letzte 400) und das Server-Log werden
  bei einem Fehler als Dateien angehängt. Artefakte in `test-results/` (git-ignoriert), dort auch
  `server-w<n>.log` je Worker und die Screenshots des Smoke-Tests.
- Dauer: ≈ 4–5,5 min (3 Worker); längster Fall `loadEarlier` (40 Echo-Turns) ≈ 70 s.

### Fälle (24, alle grün)

| Datei | Fall | Status |
|---|---|---|
| `auth.spec.ts` | `#code=` wird sofort entfernt (Rest-Hash bleibt), Cookie HttpOnly/SameSite=Strict, Reload bleibt angemeldet | grün |
| | benutzter Code in fremdem Profil → „Nicht angemeldet“ + Fehlertext, `/` ohne Cookie → kein WebSocket | grün |
| | fremder Origin: Seite auf anderem Port im angemeldeten Profil → WS nur 1006 (Cookie wird mitgeschickt, Origin-Prüfung greift); WS mit fremdem Origin 403, ohne Cookie 401; `POST /api/auth` fremd/ohne Origin 403; Launcher-Code ohne/mit falschem Token 401 | grün |
| `session.spec.ts` | Neue Session (Dialog) → Fokus im Composer → erste Nachricht startet, Antwort streamt, Titel „Fake: …“ | grün |
| | Warteschlange: Nachricht während `fake:slow` → Badge „1 queued“ + graue Zeile, läuft danach | grün |
| | Stop-Knopf unterbricht, Text wächst nicht weiter | grün |
| | Esc im leeren Composer stoppt; Entwurf übersteht Reload und wird per Enter normal gesendet (R2W-07 e) | grün |
| `decisions.spec.ts` | Permission einmal → Tool-Ergebnis `fake-dir`, „Allowed“ | grün |
| | immer erlauben, Ziel Session (Default, ohne Warn-Badge) → „Allowed and remembered for this session“ | grün |
| | Ablehnen mit Begründung (Menü „▾“ → Formular, Fokus im Feld) → Begründung im Tool-Ergebnis | grün |
| | Write-Permission zeigt die Änderung, „Datei-Effekt“ im Fake: „The file fake-notes.txt was written.“ | grün |
| | AskUserQuestion: Option + Markdown-Vorschau → „You chose: Blue“ | grün |
| | Plan v1 → Feedback per Composer-Enter (Ziel-Sperre) → v2 → „▾“ Manual → „Implement · Manual“ → IMPLEMENTED, Kopfzeile „Manual“ | grün |
| `windows.spec.ts` | zwei Fenster (je eigenes Fenster/Profil): Antwort im zweiten → Karte im ersten weg + „granted in another window“; gleichzeitige Klicks → genau ein Ergebnis, beide Fenster gleich (R2W-07 d) | grün |
| | Ziel-Sperre: Entscheidung erscheint (anderes Fenster startet den Turn) während des Tippens → Enter reiht ein, Karte bleibt; Gegenprobe: Entscheidung vorher da → Enter = Ablehnung mit Text | grün |
| | Reload mit offener Frage-Karte → gleiche Karte wieder da, beantwortbar | grün |
| `transcript.spec.ts` | (a) Streaming klebt am Ende, Hochscrollen löst, „Jump to latest“ klebt wieder | grün |
| | (b) `loadEarlier` beim Hochscrollen hält die Leseposition (≤ 80 px), älteste Nachricht danach da | grün |
| | (c) Enter/Leertaste/Tippen auf fokussiertem „Allow once“ antworten nie; Strg+Enter im Composer nicht; Strg+Enter auf dem Knopf antwortet | grün |
| `notifications.spec.ts` | Fenster im Hintergrund: „needs permission“ und „done“ als Web Notification (Kontext mit Berechtigung, `Notification` per Init-Script aufgezeichnet, `tag` = Session), Titel „(1) Parallax“, Klick auf den Toast wählt die Session | grün |
| | Fenster im Fokus zeigt andere Session: In-App-Hinweis „– has a question“ mit „Show session“ → Auswahl | grün |
| `shutdown.spec.ts` | „Stop server…“ → Rückfrage nennt „Working (1)“/„Waiting for you (1)“, Fokus auf „Cancel“; Abbrechen lässt alles laufen; Bestätigen → „Parallax server stopped“ in beiden Fenstern, sauberes Ende (eigener Server) | grün |
| `smoke.spec.ts` | en/dark, en/light, de/light, de/dark mit Screenshot; Einstellungen vom Server, Reload behält de + dark, `<html lang="de">` (eigener Server) | grün |
| `launcher.spec.ts` | echter Launcher (`src/server/launcher/main.ts --print-url`, `PARALLAX_BACKEND=fake`, Temp-Home, Port 0): Build-Prüfung, detached Server, URL → Edge angemeldet, Session, „Server beenden“ → Prozess weg | grün |

R2W-07 (f) läuft in jedem Fall mit (Diagnose-Fixture); R2W-07 (e) = Esc + Entwurf.

### Gefundene und behobene Integrations-Bugs

| # | Fundort | Bug | Fix | Test |
|---|---|---|---|---|
| 1 | `web/features/decisions/components/card-shell.tsx` | Der Tastatur-Hinweis der Entscheidungskarte (`group-has-[:focus-visible]`) verschwand beim `pointerdown` auf einen Antwortknopf, wenn vorher ein anderes Element der Karte Tastatur-Fokus hatte (z. B. „▾“ nach dem Schließen seines Menüs – Radix gibt den Fokus programmatisch zurück): die Karte schrumpfte, die Knöpfe sprangen, `pointerup` traf ein anderes Element, **der Klick auf „Implement“ ging verloren** | Hinweis erscheint mit dem ersten Tastatur-Fokus **im DOM der Karte** und bleibt; Fokus portalierter Menüs zählt nicht (sonst wählte der Klick auf „▾“ den ersten Menüeintrag) | `PermissionCard.test.tsx` „keyboard hint never toggles…“, E2E Plan-Fall |
| 2 | `web/features/decisions/components/PermissionCard.tsx` | „Mit Begründung ablehnen…“: das Begründungsfeld verlor den Fokus – das schließende Menü (Exit-Animation) holte ihn beim `pointerleave` des Eintrags und gab ihn danach an „▾“ zurück; der Nutzer tippte ins Leere | `onCloseAutoFocus` verhindert die Rückgabe und fokussiert das Formularfeld, sobald das Menü weg ist | `PermissionCard.test.tsx` „reason field keeps the focus…“ (simuliert Exit-Animation + Fokusnahme), E2E Ablehnen-Fall |
| 3 | `server/sessions/broker.ts` | `decision.resolved` ging vor dem `item.upsert` mit dem Ergebnis am Tool-Call raus; kamen beide in verschiedenen Animation-Frames an, zeigte das andere Fenster „A decision is no longer open.“ statt „…granted in another window.“ (Flake im Zwei-Fenster-Fall) | erst `attachDecision` (Ergebnis), dann `decision.resolved` | `broker.test.ts` „outcome reaches the tool call BEFORE decision.resolved“, E2E Zwei-Fenster-Fall |
| 4 | `server/backend/sdkBackend.ts` (WP-20a Lücke 1) | esbuild hob den statischen SDK-Import an den Bundle-Anfang: `dist/server.js` lud das SDK bei jedem Start, auch mit `--backend=fake` | nur noch Typ-Importe; `loadAgentSdk()` lädt das SDK dynamisch, `compose.ts` ruft es vor `createSdkBackend()` | `app/bundle.test.ts` (esbuild wie `build-server.ts`: nur `import("…sdk")`, kein statisches `from`), `sdkBackend.test.ts` |
| 5 | `server/launcher/args.ts` (WP-20a Lücke 2) | `pnpm start -- --port=4800`: pnpm 12 reicht `--` durch, `loadConfig` lehnte es ab | `--` wird übersprungen | `args.test.ts` |

Umgebung, kein Bug: Kaspersky injiziert in jede Seite ein Skript von `*.kaspersky-labs.com`; die
Seiten-CSP blockiert es (richtig). Die Diagnose ignoriert genau diese Quelle (`FOREIGN_INJECTIONS`),
jede andere Verletzung lässt den Test scheitern.

### Home-Lock und Zugriffsprüfung (R2-05/R2-13, Anleitung `docs/wp/R2.md` „Umsetzung“)

- `main.ts`: `acquireHomeLock(config.home)` **vor** `initLogging` und vor dem ersten Store; `busy` →
  „Another Parallax server already uses <home>.“ als letzte stderr-Zeile, Exit 5; Fehler → Exit 1.
  Der Lock geht als `homeLock` an `startServer()`.
- `compose.ts`: nach `listen` im Hintergrund `logHomeAccess(home)` (Option `homeAccess`, `null` in
  den In-Process-Tests); Shutdown-Schritte `http → stores → homeAccess (auf die Prüfung warten, ihre
  PowerShell darf den Server nicht überleben) → lock → homeLock`; **kein** eigener `backend`-Schritt
  mehr (das macht `manager.shutdown()`, R2-06) – nur nach einem Startfehler vor dem Manager ruft die
  Aufräumfolge `backend.dispose()` selbst.
- Tests: `main.integration.test.ts` „exit code 5 when another process holds the home lock“ (Home bleibt
  leer – weder Log noch Store geöffnet), `compose.test.ts` (Reihenfolge `homeAccess` → `homeLock`
  nach dem Lockfile, Lock danach wieder frei, Zugriffsprüfung erst nach `listen`).

### Entscheidungen

1. **E2E gegen den gebauten Server** (`dist/server.js`), nicht gegen `pnpm dev`: prüft Bundle,
   statische Auslieferung, CSP und Origin wie in Produktion; Build nur bei veralteter Build-ID.
2. **Ein Server je Worker** (3 Worker); Fälle, die Einstellungen ändern oder den Server beenden,
   starten einen eigenen. Server mit `NODE_ENV=test` (Validierung `throw`) und Fehlerzeilen-Prüfung
   am Ende – Contract-Abweichungen an der Naht fallen auf.
3. **Zwei Fenster gleichzeitig = zwei Browser-Kontexte** (eigene Fenster): eine zweite Seite im
   selben Kontext, die nicht vorne lag, blieb in headless Edge unter Vitest-Last viele Sekunden
   stehen (kein Locator löste auf; Playwright schaltet Renderer-Backgrounding schon ab) – zwei
   Abnahmeläufe scheiterten daran. Kein App-Fehler: die App wendet Ops in verborgenen Fenstern per
   `setTimeout` an (`connection.ts`).
4. **Präsenz für Benachrichtigungen per Init-Script** (`document.hasFocus`/`visibilityState`
   überschrieben, `Notification` umhüllt und aufgezeichnet): headless Edge meldet jede Seite als
   fokussiert und sichtbar; die Server-Kanalwahl und die Web-Zustellung laufen echt.

### Abweichungen / Hinweise

- `e2e/support/dom.ts` bindet `lib.dom` per `/// <reference lib="dom" />` ein (tsconfig.tools.json
  kennt nur Node; dort läuft das ganze Tools-Projekt dann mit DOM-Typen – `tsc -b` grün). Wunsch an den
  Koordinator: eigenes `e2e/tsconfig.json` mit `lib: ["ES2024", "DOM"]` (Root-Config, nicht meine).
- E2E importiert Server-Helfer (`launcher/client`, `launcher/lockFile`, `lib/process`,
  `http/testServer`) und `@shared/http` – wie `scripts/`; keine Kopien.
- Der FakeBackend schreibt keine Dateien: „Datei-Effekt“ = Tool-Ergebnis/Antwort des Fakes; die echte
  Datei prüft WP-22.
- `package.json`: Script `e2e` = `playwright test` (ohne `--pass-with-no-tests`); gebaut wird im
  Global-Setup.

### Follow-ups

- **V2 (Verifier):** `pnpm e2e` unter Last wiederholen; Server-Logs `test-results/server-w*.log`
  (nur erwartete `request rejected` aus dem Auth-Fall); Fix 1 betrifft jede Karte – Tastaturbedienung
  (Tab in die Leiste) in Edge per Hand gegenprüfen.
- **WP-22 (live):** echte Datei nach Allow (`hello.txt`/`test.txt`), Permission „immer“ fragt beim
  zweiten Mal nicht mehr (CLI-Regel), Toast als echte Windows-Benachrichtigung im App-Fenster
  (Berechtigung per Klick), Home-Lock: zweiter `pnpm start` auf demselben Home → Exit 5 → Fenster beim
  Gewinner; Kaspersky/Virenscanner-Injektion in das App-Fenster (CSP blockiert) beobachten.
- Koordinator: `docs/progress.md` Sammelliste (20c erledigt), WP-21.md (`pnpm start -- --port` geht
  jetzt), WP-20a.md Lücken 1/2 erledigt, Wunsch `e2e/tsconfig.json`.

### Checks

- **`pnpm e2e` auf dem Endstand 3× grün:** 24/24 in 3,9 min, **24/24 in 5,1 min parallel zu
  `pnpm exec vitest run`** (139 Dateien / 2543 Tests grün, lief über fast die ganze Dauer), 24/24
  in 3,7 min. Davor: weitere grüne Volläufe (u. a. 1× parallel zu `pnpm check`); zwei Läufe unter
  Vitest-Last scheiterten an der Hintergrund-Seite (Entscheidung 3, behoben, danach die
  Mehrfenster-Dateien 2× wiederholt unter Last grün).
- `pnpm check` grün (`tsc -b`, ESLint ohne Warnungen, Vitest 139 Dateien / 2543 Tests), 2× (nach dem
  Merge und auf dem Endstand); `pnpm build` grün (`index` 225,8 kB, `dist/server.js` ohne statischen
  SDK-Import).
- Gegenproben: Unit-Tests zu Bug 1, 2, 4 und 5 scheitern ohne den Fix; Bug 3 per E2E (Flake) und
  Reihenfolge-Test.
- Keine übrig gebliebenen Prozesse (CIM-Abfrage nach `parallax-e2e`/`wp-20c`/Playwright-Profilen),
  keine Temp-Ordner `parallax-e2e-*`; im Haupt-Checkout keine Änderung.

### Stolpersteine

- PowerShell `Get-Content`/`Set-Content` ohne `-Encoding` zerstörte UTF-8 (`§`, `–`, BOM) – Datei
  aus Git wiederhergestellt, Änderungen nur noch mit dem Edit-Werkzeug.
- Playwright-Attachments mit `body` landen nicht als Datei in `test-results/` – Anhänge über
  `testInfo.outputPath()` schreiben.
- Die WS-Frame-Ereignisse einer gestauten Hintergrund-Seite kamen verspätet bzw. gar nicht – erst
  der Trace (`trace.zip`, Zeitstempel der Aktionen) zeigte, dass der Locator 15 s nichts fand und das
  `server.shutdown` erst aus dem `afterEach` kam.
