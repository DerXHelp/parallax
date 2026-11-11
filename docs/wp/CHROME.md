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

> Subagent, 11.11.2026, Branch `wp/chrome`. Status: fertig bis auf die Live-Prüfung durch den Nutzer
> (Checkliste 4.6). Chrome hier: 156.0.8078.76 (`C:\Program Files\Google\Chrome\Application`; ein
> Update auf 157.0.8103.40 liegt als `new_chrome.exe` bereit und greift beim nächsten Chrome-Neustart).

### 4.1 Umsetzung

| Bereich | Änderung |
|---|---|
| `src/server/lib/chrome.ts` (+ Test, ersetzt `edge.ts`) | `findChrome({regQuery, fs, env})`; `exeProductVersion(bytes)` / `readExeVersion(file)` – Produktversion aus der Versionsressource, ohne `chrome.exe` zu starten |
| `src/server/launcher/chromeWindow.ts` (+ Test, ersetzt `edgeWindow.ts`) | `chromeAppArgs`, `chromeProfileDir` (`<home>\chrome`), `CHROME_AUTOPLAY_POLICY`, `grantChromeNotifications`, `chromePreferencesFile`, `chromiumTime`, `locateChrome`, `openChromeWindow`; entfallen: `EDGE_DISABLED_FEATURES`, `edgeProfileSignedIn` |
| `src/server/launcher/launcher.ts` (+ Tests) | Deps `locateChrome`/`openChrome`/`allowNotifications`, Gründe `chrome_not_found`/`chrome_failed` (Exit 1 wie bisher), Ergebnis `chromePid`; kein Hinweis „Profil angemeldet“ mehr |
| `args.ts`, `main.ts`, `cli.test.ts`, `launcher.integration.test.ts` | Texte/Feldnamen |
| `src/server/claude/preflight.ts` (+ Test), `scripts/preflight.ts` | Zeilen `chrome` (Pfad, Version) und `chrome policies` statt `edge`/`edge policies` |
| `src/web/i18n/{en,de}.ts` | `chrome://settings/content/notifications`, „Chrome-Einstellungen“ |
| `src/web/**` (nur Kommentare/Testnamen) | `notifications/*`, `shell/{drop-guard,NotificationPermissionBanner}`, `state/presence.ts`, `index.html` |
| `playwright.config.ts`, `e2e/**` | Projekt `chrome`, `devices['Desktop Chrome']`, `channel: 'chrome'`, headless; Kommentare; `e2e/live` nutzt dieselbe Projektliste |
| Doku | `README.md` (Voraussetzungen, Starten, „Chrome-Profil“ inkl. altem `edge`-Ordner, Benachrichtigungen), `docs/architecture.md` (§1, §2, §2.2, §3.3, §5, §5.1 (h)/(i), §8, §9), READMEs `src/server`, `server/lib`, `server/claude`, `server/launcher`, `scripts`, `e2e`, `web/notifications`, `web/shell` |

### 4.2 Entscheidungen

1. **Fundreihenfolge:** App Paths `chrome.exe` HKCU (64) → HKLM (64) → HKLM (32), dann
   `%ProgramFiles%`, `%ProgramFiles(x86)%`, `%LOCALAPPDATA%` (je `Google\Chrome\Application\chrome.exe`).
   HKCU zuerst, weil Windows `chrome` (Ausführen-Dialog, ShellExecute) genauso auflöst – eine
   benutzerweise Installation, die der Nutzer startet, gewinnt; ein veralteter Eintrag (Datei fehlt)
   fällt durch. Bei den Ordnern zuerst die systemweite Installation (heutiger Standard), dann ältere
   x86-Installationen, zuletzt die benutzerweise. Nur absolute, existierende `.exe`, geprüft mit
   `@shared/paths`; nie PATH/cwd. Nur der Stable-Kanal (Beta/Dev/Canary nicht gesucht – Playwright
   `channel: 'chrome'` ist ebenfalls Stable).
2. **Schalter** (`chromeAppArgs`): `--user-data-dir=<home>\chrome --no-first-run
   --no-default-browser-check --disable-sync --allow-browser-signin=false
   --autoplay-policy=no-user-gesture-required --app=<url>`. Begründung und Messung 4.3: Chrome meldet
   ein frisches Profil **nicht** implizit an (anders als Edge, ADR-060) – ein Pendant zu
   `edgeProfileSignedIn` und zu den `ms*`-Features entfällt. `--disable-sync` bleibt (Sync-Dienst aus,
   auch falls je ein Konto dazukäme); `--allow-browser-signin=false` ist Chromium-generisch, gemessen
   wirksam (`signin.allowed=false`, Account Consistency „None“) und verhindert, dass nach einem
   Google-Login auf einer aus Parallax geöffneten Seite eine Chrome-Anmeldung angeboten wird – reine
   Absicherung ohne Nebenwirkung auf das App-Fenster. Bewusst **nicht** gesetzt:
   `--disable-search-engine-choice-screen` (die Suchmaschinen-Auswahl erscheint nur in normalen
   Browserfenstern, nicht im App-Fenster; ein Test-Schalter ohne Not), keine Prefs außer der
   Benachrichtigungs-Freigabe (ADR-082, unverändert übernommen: `grantChromeNotifications`).
3. **Preflight „chrome policies“** (mandatory `HKLM`/`HKCU\SOFTWARE\Policies\Google\Chrome`, dazu die
   Listen-Unterschlüssel `URLBlocklist`, `NotificationsBlockedForUrls`): **warn** bei
   `BrowserSignin=2`, `ForceBrowserSignin=1` (Anmeldung erzwungen), `UserDataDir` (ersetzt das eigene
   Profil), `BrowserGuestModeEnforced=1`, `IncognitoModeAvailability=2` (nichts bleibt, keine
   Freigabe), `ProfilePickerOnStartupAvailability=2` (Profilauswahl erzwungen),
   `DefaultNotificationsSetting=2` bzw. `NotificationsBlockedForUrls` mit `127.0.0.1`/`*`/`http://*`
   (Richtlinie schlägt die Profil-Ausnahme → Windows-Toasts), `AutoplayAllowed=0` (Töne erst nach
   Klick), `URLBlocklist` mit `127.0.0.1`/`*`/`http://*` (Seite gesperrt); **info** für übrige
   Sign-in/Sync-Richtlinien (z. B. `SyncDisabled` – `--disable-sync` schaltet den Sync-Dienst
   unabhängig davon ab, Chrome kennt kein `ForceSync`); ohne relevante Richtlinie
   `OK chrome policies none`. Nicht aufgenommen: `CommandLineFlagSecurityWarningsEnabled` (keiner der
   Schalter steht auf Chromes Liste „nicht unterstützter“ Flags), `BrowserAddPersonEnabled` (nur die
   UI „Person hinzufügen“), `AutoplayAllowlist`/`URLAllowlist` (im Hinweistext erwähnt statt
   ausgewertet). Cloud-Richtlinien (Chrome Browser Cloud Management) stehen nicht in der Registry →
   Hinweis auf `chrome://policy`. Die Zeile `chrome` zeigt Pfad und Produktversion aus der
   Versionsressource (ein Start von `chrome.exe --version` würde unter Windows ein Fenster öffnen;
   der Ordnername bzw. `VisualElementsManifest.xml` zeigen bei ausstehendem Update schon die neue
   Version); unbekannte Version → `(version unknown)`, weiterhin `OK`.

### 4.3 Messung (headless, Temp-Profile, CDP)

Skript außerhalb des Repos: `chrome.exe` (156.0.8078.76) mit eigenem Temp-`--user-data-dir`,
`--headless --remote-debugging-port=0`, eigener PID (am Ende per `taskkill /PID … /T /F`, nie fremde
Chrome-Prozesse), lokaler HTTP-Server auf `127.0.0.1:<port>`; nach 20 s `chrome://signin-internals`,
`chrome://prefs-internals`, danach `Local State`/`Default\Preferences`; je Variante zwei Starts.

| Variante | Signin Status | Account Consistency | `signin.allowed` | `Local State` `user_name` | `Notification.permission` |
|---|---|---|---|---|---|
| nackt (`--user-data-dir` + URL) | Not Signed In (1./2. Start) | DICE | true | leer | `default` |
| Parallax ohne `--allow-browser-signin=false` | Not Signed In (1./2. Start) | DICE | true | leer | `granted` (Prefs-Freigabe) |
| Parallax (`chromeAppArgs`) | Not Signed In (1./2. Start) | **None** | **false** | leer | `granted` (Prefs-Freigabe) |

- Kein Konto im Token-Service, keine Accounts im Cookie-Jar, `account_info` leer, keine Sync-Daten.
- Die vorab geschriebene Ausnahme wird von einem frischen (minimale `Preferences`) und einem
  bestehenden Profil akzeptiert (`navigator.permissions.query` → `granted`).
- Nur die nackte Variante (ohne `--no-first-run`) legte einen Sign-in-Promo-Zähler am Avatar-Knopf an
  (`AvatarButtonSigninPromoShownCount: 1`) – das App-Fenster hat keinen Avatar-Knopf, Parallax startet
  mit `--no-first-run`. Geöffnete Seiten jeweils nur die App-URL (kein Willkommens-Tab).
- **Grenzen:** headless zeigt keine Dialoge/Infobars; `AudioContext` lief in allen Varianten sofort
  (headless erlaubt Autoplay ohnehin) – der Autoplay-Schalter ist hier nicht nachweisbar (ADR-120 in
  Edge gemessen, Chromium-generisch). Darstellung und Klick der Benachrichtigungen sind headless
  nicht messbar → Checkliste 4.6.

### 4.4 Testläufe

- `pnpm check`: grün – typecheck, lint, 216 Testdateien / 3814 Tests (nach den Prettier-Korrekturen erneut, s. u.).
- `pnpm build`: grün (`0.0.0+72ffcefd1a2e.dirty-…`).
- `pnpm e2e` (Chrome 156 headless, `channel: 'chrome'`, FakeBackend): zweimal **45/45** (je 2,9 min, 3 Worker), keine sichtbaren Fenster. Danach nur Formatierung (Prettier, Klammern, Kommentare) in `preflight.ts`, `preflight.test.ts`, `chrome.test.ts`; Unit-Tests und `pnpm check` danach erneut grün.
- `pnpm preflight --home=%TEMP%\px-chrome-preflight`: `OK chrome C:\Program Files\Google\Chrome\Application\chrome.exe, 156.0.8078.76`,
  `OK chrome policies none`, Ergebnis OK (die eine Warnung ist der Virenscanner); der Temp-Ordner
  wurde nicht angelegt.
- `grep -rniE "msedge|\bedge\b" src scripts e2e playwright.config.ts` – verbleibende, begründete Treffer:
  „long edge“/„bottom edge“ (Bildkante, UI-Kante); „Chrome/Edge senden kein Sec-Fetch-Site“
  (`http/origin*`, `http/testServer.ts`, `sync/hub.integration.test.ts` – gilt für beide); historische
  Beobachtungen mit WP-Verweis (`features/decisions/PermissionCard*` WP-20c, `Composer.test.tsx`
  „Chromium/Edge“, `index.html` WP22-09, `e2e/support/fixtures.ts`); Rückverweise auf ADR-136/ADR-060 in
  `lib/chrome.ts`, `launcher/chromeWindow*`; `msedge.exe` als Testpfad in `lib/process.test.ts` und
  `src/shared/paths.test.ts` (fremder Besitz, nur Beispielpfad); `sessions/nativeToasts.ts:4`
  (Kommentar „Edge app window“, fremder Besitz → 4.7).

### 4.5 Nicht geändert (bewusst)

- Das alte Profil `<home>\edge` wird weder gelesen noch gelöscht (README „Chrome-Profil“ nennt es).
- Kein Contract betroffen (`src/shared/**`, Ports unverändert); `LauncherResult.chromePid` und die
  Gründe `chrome_*` sind launcher-intern.

### 4.6 Nutzer-Checkliste (Live-Prüfung)

Mit der produktiven Instanz nach dem Merge (oder vorher mit eigenem Home:
`$env:PARALLAX_BACKEND='fake'; $env:PARALLAX_HOME="$env:TEMP\px-try-chrome"; pnpm start`):

1. `pnpm preflight`: `OK chrome …, <Version>` und `OK chrome policies none` (sonst Hinweis lesen).
2. **Fenster:** `parallax.cmd` öffnet ein Chrome-App-Fenster ohne Adressleiste; **kein**
   Anmelde-/Sync-Dialog, kein Willkommens-Tab, kein Balken „Chrome ist nicht Ihr Standardbrowser“,
   keine Suchmaschinen-Auswahl, kein Hinweis zu Werbe-Datenschutz, kein Balken zu einem
   „nicht unterstützten Befehlszeilen-Flag“. Eigenes Taskleisten-Symbol/-Gruppe, nicht mit dem normalen
   Chrome vermischt? Fenstergröße/-position beim zweiten Start übernommen?
3. **Profilstatus:** bei laufendem Parallax per Win+R
   `chrome --user-data-dir=%LOCALAPPDATA%\Parallax\chrome chrome://signin-internals` (öffnet ein normales
   Fenster des Parallax-Profils): „Signin Status: Not Signed In“, „Account Consistency: None“; dort
   auch `chrome://policy` (keine Richtlinien) und `chrome://settings/content/notifications`
   (`http://127.0.0.1:<port>` erlaubt). Das eigene Chrome-Profil bleibt unberührt.
4. **Benachrichtigung + Klick:** Parallax-Fenster in den Hintergrund, eine Session auf Entscheidung
   warten lassen → Benachrichtigung erscheint. Notieren: Windows-Toast (Absender „Google Chrome“, im
   Benachrichtigungscenter) oder Chrome-eigenes Popup? Klick holt **das Parallax-Fenster** nach vorn und
   zeigt die Session (Risiko: ein Klick auf einen Chrome-Toast könnte statt des Parallax-Profils das
   normale Chrome-Profil öffnen). „Nicht stören“ an → Banner unterdrückt, Eintrag im Center?
5. **Ton ohne Klick:** Fenster über Autostart bzw. einen Klick auf einen Windows-Toast des Servers
   öffnen, **ohne** hineinzuklicken eine Benachrichtigung mit Ton auslösen → Ton hörbar, kein Hinweis
   „Töne aktivieren“.
6. **Autostart und `parallax:`:** nach der Windows-Anmeldung startet der Server (bei
   „Fenster öffnen“ ein Chrome-App-Fenster); Klick auf einen nativen Server-Toast öffnet über
   `parallax:` ein Chrome-App-Fenster mit der Session.
7. **Drag & Drop:** Screenshot aus dem Explorer in den Composer → Anhang; auf Transkript/Sidebar
   fallen lassen → abgewiesen, das Fenster navigiert nicht weg.
8. **„In neuem Fenster öffnen“:** zweites Chrome-App-Fenster, angemeldet, gleiche Session.
9. **Links** aus dem Transkript öffnen ein normales Chrome-Fenster **des Parallax-Profils** (nicht das
   eigene Chrome) – einmalige Chrome-Hinweise dort (z. B. Suchmaschinen-Auswahl) notieren.
10. **Altes Profil:** `%LOCALAPPDATA%\Parallax\edge` bleibt liegen und kann nach erfolgreicher Prüfung
    gelöscht werden.

### 4.7 Wünsche an den Koordinator

- **ADR-136 ergänzen** (oder Nachtrag): Messung 4.3 (keine implizite Anmeldung in Chrome 156,
  `--allow-browser-signin=false` wirksam), endgültige Schalterliste, Fundreihenfolge, Auswahl der
  Preflight-Richtlinien; in ADR-060 vermerken, dass `edgeProfileSignedIn` und die `ms*`-Features mit
  ADR-136 entfallen sind.
- **Fremde Dateien mit Edge-Text:** `parallax.cmd` (Z. 3) und `parallax.ps1` (Z. 2) – Kommentar
  „opens an Edge app window“; `src/server/sessions/nativeToasts.ts:4` – Kommentar „the Edge app
  window“. Die Testpfade `msedge.exe` in `src/server/lib/process.test.ts`/`src/shared/paths.test.ts`
  können bleiben.
- **CLAUDE.md:** bereits auf Chrome umgestellt (Zweck, Stack, `pnpm start`, `pnpm e2e`); keine
  weitere Stelle nötig.
- `docs/progress.md`: Paket CHROME, Contract unverändert; offene Live-Prüfung 4.6.
- Hinweis: Auf dem Rechner laufen verwaiste headless-Chrome-Prozesse vom 05.11.2026
  (`--user-data-dir=%TEMP%\playwright_chromiumdev_profile-*`, PIDs 53128, 32744, 63236) – nicht aus diesem
  Paket, daher nicht beendet. Alle eigenen Prozesse und Temp-Profile dieses Pakets sind beendet bzw.
  gelöscht.
