# CHROME – App-Fenster in Google Chrome statt Microsoft Edge

> Koordinator, 11.11.2026. Nutzer-Entscheidung (ADR-136): **nur Chrome**, keine Umschaltung (keine
> Startoption, keine Einstellung), E2E-Tests in Chrome. Feature-Branch `feature/chrome` (von `main` =
> `d32d912`), Worktree `.worktrees/chrome`, Branch `wp/chrome`.

## 1. Ausgangslage

- Der Launcher öffnet das UI als Edge-App-Fenster (`--app=<url>`) mit eigenem Profil
  `<home>\edge` (`src/server/launcher/edgeWindow.ts`, `src/server/lib/edge.ts`, Aufrufer in
  `launcher/{launcher,main,args}.ts`). Edge-spezifisch: `findEdge`/`locateEdge`, Profilordner, die
  Anmelde-Sperren aus ADR-060 (`--allow-browser-signin=false`, `--disable-features=msImplicitSignin,…`),
  `edgeProfileSignedIn` (Hinweis „älteres Profil angemeldet“), `pnpm preflight` „edge policies“
  (`src/server/claude/preflight.ts`, `scripts/preflight.ts`), ein UI-Text mit
  `edge://settings/content/notifications` (`src/web/i18n/{en,de}.ts`), Playwright `channel: 'msedge'`
  (`playwright.config.ts`, `e2e/**`, `e2e/live/**`).
- Chromium-generisch und für Chrome zu übernehmen: App-Modus, eigenes `--user-data-dir`,
  `--autoplay-policy=no-user-gesture-required` (ADR-120), Benachrichtigungs-Freigabe für die eigene
  Origin über `<profil>\Default\Preferences` (ADR-082, `grantEdgeNotifications`, `chromiumTime`),
  `--disable-sync`, `--no-first-run` usw.
- Installiert hier: Chrome **156.0.8078.76** (`C:\Program Files\Google\Chrome\Application\chrome.exe`,
  `App Paths\chrome.exe` in HKLM). Chrome kann auch benutzerweise installiert sein
  (`%LOCALAPPDATA%\Google\Chrome\Application\chrome.exe`, `App Paths` in HKCU).

## 2. Auftrag

1. **Chrome finden** (ersetzt `findEdge`/`locateEdge`): Registry `App Paths\chrome.exe` (HKCU vor HKLM
   oder begründet anders), bekannte Installationsorte (Program Files, Program Files (x86),
   `%LOCALAPPDATA%`); nur absolute, existierende `.exe` (CLAUDE.md „Windows“, `resolveExecutable`-Regeln);
   nie über `PATH`/`cwd`. Ohne Chrome: klare Launcher-Fehlermeldung (Englisch, wie die übrigen
   Launcher-Meldungen) mit Hinweis auf Chrome-Installation bzw. `--print-url`; Exit-Code wie heute bei
   fehlendem Edge.
2. **App-Fenster in Chrome**: Profil `<home>\chrome` (`--user-data-dir`), App-Modus, Autoplay-Schalter,
   Benachrichtigungs-Freigabe in den Profil-Prefs, `--disable-sync`, `--no-first-run`,
   `--no-default-browser-check`; kein Anmelde-/Sync-Dialog, kein Willkommens-Tab, kein „Chrome ist nicht
   Standardbrowser“-Balken im App-Fenster. Prüfen (Chrome-Doku/Quellen, Messung im Temp-Profil per
   Playwright/CDP, **headless** bzw. ohne sichtbares Fenster), ob Chrome sich in einem frischen Profil
   implizit mit einem Konto anmeldet; nötige Schalter/Prefs begründet setzen. Edge-Schalter
   (`msImplicitSignin` …) und `edgeProfileSignedIn` entfallen; ein Chrome-Pendant nur, wenn es eine
   reale Anmeldung gibt.
3. **Edge vollständig entfernen** (Code, Tests, Texte, Doku-Stellen im eigenen Besitz). Das alte Profil
   `<home>\edge` wird **nicht** gelöscht; README nennt, dass es entfernt werden kann.
4. **Preflight**: „chrome policies“ statt „edge policies“ – relevante Richtlinien unter
   `HKLM`/`HKCU\SOFTWARE\Policies\Google\Chrome` (z. B. erzwungene Anmeldung `BrowserSignin=2`,
   `SyncDisabled=0`/erzwungener Sync, `DefaultNotificationsSetting`/`NotificationsBlockedForUrls`,
   `AutoplayAllowed=0`, `UserDataDir`, `CommandLineFlagSecurityWarningsEnabled`,
   `URLBlocklist` mit `127.0.0.1`, `BrowserAddPersonEnabled`/Profilauswahl beim Start) – Auswahl
   begründen; ohne relevante Richtlinie `OK chrome policies none`. Preflight prüft außerdem, ob Chrome
   gefunden wird (Version).
5. **UI-Text**: `chrome://settings/content/notifications` statt `edge://…` (en/de); weitere
   nutzersichtbare Edge-Erwähnungen suchen (`grep -i edge` in `src/web/**`, nicht „edge case“).
6. **Tests**: Unit-/Integrationstests anpassen (Fundorte, Argumente, Prefs, Fehlerfall ohne Chrome);
   Playwright `channel: 'chrome'` in `playwright.config.ts` und `e2e/live`; E2E-Texte/Kommentare.
7. **Doku**: README (Voraussetzungen, „Starten“, Abschnitt „Edge-Profil“ → „Chrome-Profil“,
   „Benachrichtigungen“ – Unterschied: Chrome-Benachrichtigungen gehen unter Windows vermutlich über
   das Windows-Benachrichtigungssystem; als „live zu prüfen“ kennzeichnen), `docs/architecture.md`
   (Edge-Stellen: §1, §2, §2.2, §3.3, §5, §5.1-Diagramme, §8 Persistenz-Layout `chrome/`, §9),
   Ordner-READMEs (`src/server/launcher`, `src/server/lib`, `src/server/claude`, `src/server`,
   `scripts`, `e2e`, `src/web/notifications`, `src/web/shell`, soweit Edge erwähnt).
8. **Nutzer-Checkliste** (Ergebnis §4): was der Nutzer live prüfen soll (Fenster öffnet als
   App-Fenster ohne Anmelde-/Willkommensdialog, Benachrichtigung + Klick, Ton ohne Klick, Autostart- und
   `parallax:`-Weg, Drag & Drop, „In neuem Fenster öffnen“, `chrome://signin-internals` bzw. Profilstatus).

**Besitz-Pfade (für dieses Paket freigegeben):** `src/server/launcher/**`, `src/server/lib/edge.ts`
(+ Test; umbenennen/ersetzen erlaubt, z. B. `lib/chrome.ts`), `src/server/lib/README.md`,
`src/server/claude/preflight{,.test}.ts`, `src/server/claude/README.md`, `scripts/preflight.ts`,
`scripts/README.md`, `src/server/README.md`, sonstige Server-Dateien nur, wenn sie Edge-Helfer
importieren (auflisten), `src/web/i18n/{en,de}.ts` (nur der Edge-Text), Kommentare mit Edge-Bezug in
`src/web/**` (nur Kommentare/Texte, keine Logik), `playwright.config.ts`, `e2e/**` (inkl. `e2e/live`,
nur Browser-Kanal/Texte), `README.md`, `docs/architecture.md`, diese Datei. **Tabu:** `src/shared/**`,
alle `ports.ts`, `backend/{types,fixture}.ts`, `package.json`, Lockfile, `pnpm-workspace.yaml`,
`CLAUDE.md`, `docs/decisions.md`, `docs/progress.md` (Koordinator). Contract-Bedarf → Bericht.

**Regeln:** `CLAUDE.md` vollständig. **Kein Live-`claude`** (FakeBackend reicht; kein Live-Smoke).
**Keine Desktop-Bedienung** per Skript und **keine sichtbaren Chrome-Fenster** auf dem Desktop des
Nutzers (Nutzer-Regel 18.10.2026): Playwright headless, Launcher-Tests mit Stubs bzw. `--print-url`;
Messungen an Chrome nur headless/CDP in Temp-Profilen. Nie das echte Chrome-Profil des Nutzers
(`%LOCALAPPDATA%\Google\Chrome\User Data`) oder `%LOCALAPPDATA%\Parallax` anfassen. Lange Läufe im
Hintergrund mit Ausgabe in Dateien; gestartete Prozesse am Ende beenden (nur eigene – der Nutzer hat
evtl. Chrome offen: nie `chrome.exe` pauschal beenden, nur per eigener PID/Prozessbaum).

## 3. Abnahme

- `pnpm check` und `pnpm build` grün; `grep -rniE "msedge|\bedge\b" src scripts e2e playwright.config.ts`
  ohne Edge-Treffer außer begründeten (z. B. „edge case“, historische Kommentare mit ADR-Verweis).
- `pnpm e2e` (Chrome, FakeBackend) zweimal 45/45 (bzw. Anzahl nennen).
- `pnpm preflight --home=<Temp>` zeigt Chrome samt Version und „chrome policies“.
- Ergebnis §4 vollständig: Entscheidungen (Fundreihenfolge, Schalter/Prefs mit Begründung bzw. Messung),
  Testläufe mit Zahlen, Nutzer-Checkliste, Wünsche an den Koordinator (ADR-Ergänzungen, CLAUDE.md-Stellen).

**Commit:** lokal auf `wp/chrome` (Deutsch, mehrere `-m`, kein Heredoc), nicht pushen, nicht mergen.
Bericht im Format aus `CLAUDE.md`.

## 4. Ergebnis

_(füllt der Subagent)_
