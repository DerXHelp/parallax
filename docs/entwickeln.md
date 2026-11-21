# Parallax entwickeln

Alles, was man für die Arbeit am Code braucht: Voraussetzungen, Befehle, Start aus dem Klon, die Trennung von der
produktiven Instanz, die Routine für `claude`-Updates und die README-Bilder. Wer Parallax nur benutzt, braucht diese
Seite nicht – Installation und Bedienung stehen in der [README](../README.md). Die Regeln für Beiträge (Ownership,
Contracts, Code-Regeln, Git) stehen in [`CLAUDE.md`](../CLAUDE.md), die Architektur in
[`architecture.md`](architecture.md).

## Voraussetzungen
- **Node.js 26.9 oder neuer** (`engines.node`; die Release-Prüfung läuft mit 26.9.0 und dem neuesten 26).
  `.node-version` enthält `26` für fnm, nvm-windows oder Volta – ein schon installiertes älteres 26.x vorher
  aktualisieren.
- **pnpm 12.17.0:** einmalig `npm i -g pnpm@12.17.0`. `packageManager` und der Lockfile pinnen die Version; ein
  pnpm ab 10 lädt sie bei Abweichung selbst nach (`managePackageManagerVersions`). Ein zu altes pnpm scheitert an
  `engines.pnpm`.
- Das installierte **`claude`** mit Anmeldung (Parallax bringt kein Claude-Binary mit).
- **Google Chrome** für das App-Fenster und die E2E-Tests (Playwright lädt keine Browser).

## Befehle
```powershell
pnpm install --frozen-lockfile   # Abhängigkeiten exakt nach Lockfile
pnpm dev                         # Server (FakeBackend, Port 4712) + Vite: http://127.0.0.1:5173
pnpm check                       # typecheck + lint + test – vor jedem Commit grün
pnpm build                       # dist/web + dist/server.js
pnpm e2e                         # Playwright in Chrome gegen den Server-Build mit FakeBackend
pnpm preflight                   # Umgebungscheck (Node, pnpm, claude, Chrome, Chrome-Richtlinien …)
```
Die vollständige Liste mit Einzelschritten, Release-Skripten und `public-check` steht in `CLAUDE.md` („Befehle“),
die Skripte selbst in [`scripts/README.md`](../scripts/README.md).

- `pnpm dev` verbraucht keine Tokens (FakeBackend) und nutzt `.parallax-dev/` statt `%LOCALAPPDATA%\Parallax`. Die
  Anmelde-Adresse `http://127.0.0.1:5173/#code=…` (10 Minuten gültig) steht beim Start im Server-Log; Vite leitet
  `/api` (auch den WebSocket) an Port 4712 weiter. `tsx watch` startet den Server bei jeder Änderung neu (Sessions des
  FakeBackends enden dabei). „Server beenden“ beendet im Dev-Modus nur den Server – `tsx watch` und Vite laufen
  weiter, bis `Ctrl+C` oder die nächste Dateiänderung kommt.
- `pnpm dev:live` nutzt das echte `claude`. Der Vite-Dev-Server liefert die Seite ohne CSP aus und das Dev-Cookie gilt
  für jede Seite auf `127.0.0.1:5173` – `dev:live` daher nur in einem eigenen Chrome-Profil öffnen, z. B. per Win+R
  `chrome --user-data-dir=%TEMP%\px-dev-chrome --disable-sync http://127.0.0.1:5173/#code=…`.
- `pnpm dev:web` startet nur Vite mit dem Playground (`#playground`, siehe unten); in einem Worktree mit eigenem Port
  per `PARALLAX_DEV_WEB_PORT`.
- Die Plattform-Binaries des Agent SDK (~270 MB) installiert pnpm nicht (`ignoredOptionalDependencies` in
  `pnpm-workspace.yaml`). Install-Skripte darf nur `esbuild` ausführen (`allowBuilds`); die pnpm-Vorgaben
  `strictDepBuilds`, `minimumReleaseAge` und `blockExoticSubdeps` bleiben aktiv. Neue Versionen von Abhängigkeiten
  nur, wenn sie älter als 14 Tage sind (`CLAUDE.md`, „Abhängigkeiten“).
- Unter Linux prüft `bash scripts/linux/run.sh -- <befehl>` einen Befehl im Container `parallax-linux:24.04`.

## Aus dem Klon starten
```powershell
.\parallax.cmd                   # Doppelklick genügt; alternativ .\parallax.ps1 oder pnpm start
.\parallax.cmd --port=4800       # anderer Port (auch PARALLAX_PORT); Daten: --home=<ordner> / PARALLAX_HOME
.\parallax.cmd --help            # alle Optionen
pnpm start --print-url           # Optionen direkt anhängen (pnpm reicht ein `--` wörtlich weiter)
```
- **Erster Start und nach `git pull`:** Der Launcher baut `dist/`, wenn es fehlt oder die Build-ID nicht zum Checkout
  passt (beim ersten Mal etwa eine Minute), startet den Server unsichtbar (`node dist/server.js`, Ausgabe in
  `<Datenordner>\logs\server.out.log`, Log `parallax.*.log`) und öffnet Chrome als App-Fenster. Das Konsolenfenster
  schließt sich danach; bei einem Fehler bleibt es mit der Meldung offen.
- **Läuft Parallax schon,** öffnet ein weiterer Start nur ein Fenster (`server.lock.json` + Health-Ping; ein
  verwaistes Lockfile nach einem Absturz wird ignoriert). Zwei Starts gleichzeitig ergeben trotzdem nur einen Server.
  Läuft der Server mit einem anderen Backend als angefordert, meldet der Launcher das als Fehler.
- **Neuer Build bei laufendem Server:** Der Server liefert die UI aus einer beim Start fixierten Kopie
  (`<Datenordner>\ui\<build>`); einen neuen Build übernimmt er erst nach „Server beenden…“ und einem neuen Start. Die
  Build-ID hängt nur an Build-Eingaben (Quellen, Configs, Lockfile). Launcher, `pnpm e2e` und `pnpm build` bauen einen
  Checkout nie gleichzeitig.
- **Exit-Codes** von `dist/server.js` (zeigt der Launcher an): 0 regulär beendet, 1 Fehler (auch ungültige Option),
  3 Daten einer neueren Parallax-Version, 4 Port belegt, 5 für diesen Datenordner läuft schon ein Server.
- **Weitere Optionen:** `--backend=fake` bzw. `PARALLAX_BACKEND=fake` (startet kein `claude`; **nur mit eigenem
  `--home`/`PARALLAX_HOME`**, auf `%LOCALAPPDATA%\Parallax` verweigert der Server den Start), `--no-build`,
  `--validate=log|throw|off` (Prüfung ausgehender Daten gegen den Contract, Standard `log`),
  `--toasts=native|off`.
- **Ausprobieren, ohne eigene Daten anzufassen** (PowerShell):
  `$env:PARALLAX_BACKEND='fake'; $env:PARALLAX_HOME="$env:TEMP\px-try"; pnpm start`.
- In `claude`-Sessions kommen von den `PARALLAX_*`-Variablen des Servers nur `PARALLAX=1` und `PARALLAX_ENTRY_ID`
  an – ein `pnpm test` oder `pnpm start` in einer Parallax-Session greift nie auf deren Datenordner zu.
- Startet ein Terminal den Launcher in einem Job-Objekt, das beim Schließen alle Prozesse beendet, endet auch der
  Server – im Zweifel `parallax.cmd` per Doppelklick starten.

## Produktiv nutzen und weiterentwickeln
- **Benutzt wird die Installation** aus einem Release; entwickelt wird auf Feature-Branches. Releases entstehen aus
  `main`, dem geprüften Stand (`CLAUDE.md`, „Git“). Autostart und „Klick öffnet die Session“ nur in der Installation
  einschalten: Verknüpfung und `parallax:`-Eintrag zeigen auf das Programm, aus dem der Server läuft.
- **Ohne Installation** geht es mit einem eigenen Klon: `git clone https://github.com/DerXHelp/parallax.git <ordner>`,
  darin `pnpm install --frozen-lockfile`, dann `parallax.cmd`. Aktualisieren: Zahnrad → „Server beenden…“, im Klon
  `git pull` und `pnpm install --frozen-lockfile`, dann `parallax.cmd` (baut selbst neu). Der Klon bleibt der
  Rückweg, falls die Installation hakt. Daten werden nur vorwärts migriert; eine ältere Version startet auf migrierten
  Daten nicht mehr (Exit-Code 3).
- **Getrennt:** Die produktive Instanz nutzt `%LOCALAPPDATA%\Parallax` und den Port aus den Einstellungen (Standard
  4711). Die Entwicklung nutzt `pnpm dev`/`pnpm dev:live` mit `.parallax-dev` und den Ports 4712/5173, die Tests
  Temp-Ordner und freie Ports. Nur ein Server auf `%LOCALAPPDATA%\Parallax` richtet Autostart und Protokoll-Handler
  ein.
- **Regel im Entwicklungs-Repo:** nie `parallax.cmd` oder `pnpm start` ohne eigenes `--home`/`PARALLAX_HOME`. Sonst
  baut der Launcher den Entwicklungsstand, migriert womöglich die echten Daten und biegt Autostart und
  Protokoll-Handler auf das Repo um.
- Claude-Sessions, die Parallax weiterentwickeln, dürfen in der produktiven Instanz laufen (Arbeitsordner = Repo);
  Neustarts der Entwicklung betreffen sie nicht. Gemeinsam bleiben nur das installierte `claude` und `~/.claude` – ein
  CLI-Update betrifft beide.

## `claude`-Updates
- `claude` aktualisiert sich selbst, oft mehrmals pro Woche. Parallax kennt die zuletzt geprüfte Version
  (CLI-Profil `src/server/claude/cli-profile.json`). Ist die installierte neuer, zeigen Kopfzeile und Profilstatus
  einen dezenten Hinweis („Claude Code <v> ist neuer als die mit Parallax geprüfte Version <t>“), `pnpm preflight`
  eine Warnung. Parallax läuft trotzdem normal weiter.
- **Routine:** In einer Claude-Session im Repo `/claude-update` aufrufen (Projekt-Skill). Er führt `pnpm cli-check`
  aus (live, Haiku, Abo-Anmeldung, höchstens 0,05 USD, etwa 2 Minuten), vergleicht mit dem Profil und übernimmt es bei
  grünem Ergebnis nach `main`. Abweichungen, die mehr als kleine Anpassungen brauchen, legt er zur Entscheidung vor.
  Danach in der produktiven Instanz das nächste Release installieren – der Hinweis verschwindet nach dem Neustart.
- Geprüfte Versionen: [`cli-updates.md`](cli-updates.md); SDK-Upgrade: [`sdk-upgrade.md`](sdk-upgrade.md).

## Chrome-Profil im Detail
- Der Launcher startet Chrome mit eigenem Profil (`<Datenordner>\chrome`), `--disable-sync` und
  `--allow-browser-signin=false`: Das Profil meldet sich nie bei einem Google-Konto an, auch nicht nach einem
  Google-Login auf einer aus Parallax geöffneten Seite. Prüfen lässt sich das in einem Fenster des Parallax-Profils
  unter `chrome://signin-internals` („Signin Status: Not Signed In“); Strg+T öffnet dort einen normalen Tab.
- Benachrichtigungen erlaubt der Launcher vor jedem Fenster für `http://127.0.0.1:<port>` nur in diesem Profil
  (`<Datenordner>\chrome\Default\Preferences`, keine Richtlinie). Ohne offenes Fenster zeigt der Server eine
  Windows-Benachrichtigung über einen PowerShell-Helfer; nach drei Fehlern in Folge pausiert der Helfer (1 Minute,
  dann länger, höchstens 15 Minuten).
- Ein altes Profil `<Datenordner>\edge` früherer Versionen nutzt Parallax nicht mehr; es kann gelöscht werden.
- `pnpm preflight` warnt bei Chrome-Richtlinien in der Registry (`HKLM`/`HKCU\SOFTWARE\Policies\Google\Chrome`);
  Cloud-Richtlinien zeigt nur `chrome://policy`.

## Playground und README-Bilder
- `pnpm dev:web` und dann `http://127.0.0.1:5173/#playground` zeigt alle Demos der Oberfläche über einen FakeHost,
  ohne Server. `#playground=<id>&bare` zeigt eine Demo fensterfüllend.
- Die README-Bilder entstehen aus den Showcase-Demos (`src/web/playground/showcase/`, erfundene Projekte, feste Uhr):
  ```powershell
  pnpm exec tsx --tsconfig tsconfig.tools.json scripts/screenshots.ts
  pnpm exec tsx --tsconfig tsconfig.tools.json scripts/screenshots.ts '--only=overview,review' '--theme=light'
  ```
  In PowerShell die Optionen mit Komma in Anführungszeichen setzen, sonst wird daraus eine Liste.
  Das Skript startet Vite und ein headless Chrome (1440 × 900, Faktor 2) und schreibt
  `docs/screenshots/<name>-<light|dark>.png` für `overview`, `plan`, `review`, `files` und `search`. Es ist ein
  schwerer Lauf: nicht parallel zu `pnpm check`, `pnpm e2e` oder `pnpm build` starten.
