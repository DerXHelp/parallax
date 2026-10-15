# Parallax

Lokale Mission-Control-App für viele parallele Claude-Code-Sessions unter Windows: ein Node-Server
auf `127.0.0.1` steuert je Session das installierte `claude` über das Claude Agent SDK, die Web-UI
läuft als Edge-App-Fenster. Status: im Aufbau (Phase 1, siehe `docs/progress.md`).

## Voraussetzungen
- **Node.js 26** (Minimum 22). `.node-version` enthält `26` für fnm, nvm-windows oder Volta.
- **pnpm 12.8.2**: einmalig `npm i -g pnpm@12.8.2`. `packageManager` und der Lockfile pinnen die
  Version; ein pnpm ≥ 10 lädt sie bei Abweichung selbst nach (`managePackageManagerVersions`, nicht
  separat getestet). Ein zu altes pnpm scheitert an `engines.pnpm: ">=12.8"`.
- Das installierte **`claude`**-CLI mit Login (Parallax liefert kein Claude-Binary mit).
- Microsoft Edge (für das App-Fenster und die E2E-Tests; Playwright lädt keine Browser).

## Installation und Start
```powershell
pnpm install          # bzw. pnpm install --frozen-lockfile
pnpm dev              # Server (FakeBackend, Port 4712) + Vite: http://127.0.0.1:5173
pnpm check            # typecheck + lint + test
pnpm build            # dist/web + dist/server.js
pnpm start            # Launcher: baut bei Bedarf, startet den Server unsichtbar, öffnet Edge
```
`pnpm dev` verbraucht keine Tokens (FakeBackend) und nutzt `.parallax-dev/` statt
`%LOCALAPPDATA%\Parallax`. Die Anmelde-Adresse `http://127.0.0.1:5173/#code=…` (10 min gültig)
steht beim Start im Server-Log; Vite leitet `/api` (auch den WebSocket) an Port 4712 weiter.
`tsx watch` startet den Server bei jeder Änderung neu (Sessions des FakeBackends enden dabei).
„Server beenden“ beendet im Dev-Modus nur den Server – `tsx watch` und Vite laufen weiter, bis
`Ctrl+C` oder die nächste Dateiänderung kommt. `pnpm dev:live` nutzt das echte `claude`; der
Vite-Dev-Server liefert die Seite ohne CSP aus und das Dev-Cookie gilt für jede Seite auf
`127.0.0.1:5173` – `dev:live` daher nur in einem eigenen Edge-Profil öffnen (z. B.
`msedge --user-data-dir=%TEMP%\px-dev-edge --disable-sync http://127.0.0.1:5173/#code=…`, R3-14).

Die SDK-Plattform-Binaries (~270 MB) werden per `ignoredOptionalDependencies` in
`pnpm-workspace.yaml` nicht installiert. Install-Skripte darf nur `esbuild` ausführen
(`allowBuilds`); die pnpm-Defaults `strictDepBuilds`, `minimumReleaseAge` (1 Tag) und
`blockExoticSubdeps` bleiben aktiv.

## Starten
Parallax läuft als unsichtbarer Hintergrund-Server mit Edge-App-Fenstern (ohne Installation):

```powershell
.\parallax.cmd                 # Doppelklick genügt; alternativ .\parallax.ps1 oder pnpm start
.\parallax.cmd --port=4800     # anderer Port (auch PARALLAX_PORT), Daten: --home=<dir> / PARALLAX_HOME
.\parallax.cmd --help          # alle Optionen
pnpm start --print-url         # Optionen direkt anhängen (pnpm reicht ein `--` wörtlich weiter)
```

- **Erster Start / nach `git pull`:** Der Launcher baut `dist/`, wenn es fehlt oder die Build-ID
  nicht zum Checkout passt (dauert beim ersten Mal etwa eine Minute), startet den Server
  unsichtbar im Hintergrund (`node dist/server.js`, Ausgabe in
  `%LOCALAPPDATA%\Parallax\logs\server.out.log`, Log `parallax.*.log`) und öffnet Edge als
  App-Fenster mit eigenem Profil (`%LOCALAPPDATA%\Parallax\edge`). Das Konsolenfenster schließt
  sich danach von selbst; bei einem Fehler bleibt es mit der Meldung offen.
- **Läuft Parallax schon,** öffnet ein weiterer Start nur ein zusätzliches Fenster (Erkennung über
  `server.lock.json` + Health-Ping; ein verwaistes Lockfile nach einem Absturz wird ignoriert).
  Ein Doppelklick startet trotzdem nur einen Server: der zweite Start wartet („… by another
  launcher - waiting for it“) und öffnet dann ein Fenster dieses Servers. Läuft der Server mit
  einem anderen Backend als angefordert (z. B. ein FakeBackend-Server, während `parallax.cmd`
  ohne Optionen das echte `claude` will), meldet der Launcher das als Fehler statt ein Fenster zu
  öffnen.
- **Neuer Build bei laufendem Server:** Ein laufender Server übernimmt einen neuen Build erst nach
  „Server beenden“ und erneutem Start. Er liefert die UI aus einer beim Start fixierten Kopie
  (`%LOCALAPPDATA%\Parallax\ui\<build>`); ein `pnpm build`/`pnpm e2e` im selben Checkout ändert
  also nichts an seinen Fenstern. Die Build-ID hängt nur an Build-Eingaben (Quellen, Configs,
  Lockfile) – ein reiner Doku-Commit erzwingt keinen Neubau.
- **Fenster schließen beendet den Server nicht** – die Sessions laufen weiter. Beenden über das
  Zahnrad-Menü → „Server beenden…“: Die Rückfrage nennt die arbeitenden und wartenden Sessions.
- **Fehlermeldungen:** Port belegt → `--port=<n>` wählen; „written by a newer Parallax“ (Exit-Code
  3) → Parallax aktualisieren (`git pull`, `pnpm install`), die Daten bleiben unverändert; Server
  startet nicht → Pfad der Logdatei steht in der Meldung; Edge nicht gefunden → Edge installieren
  oder `--print-url` (Adresse mit Einmal-Code, 60 s gültig) in einem Chromium-Browser öffnen.
- Exit-Codes von `dist/server.js` (zeigt der Launcher an): 0 regulär beendet, 1 Fehler (auch
  ungültige Option), 3 Daten einer neueren Parallax-Version, 4 Port belegt, 5 für dieses
  Datenverzeichnis läuft schon ein Server.
- Weitere Optionen: `--backend=fake` bzw. `PARALLAX_BACKEND=fake` (FakeBackend, startet kein
  `claude` – zum Ausprobieren und für Smoke-/E2E-Tests des echten Startpfads; **nur mit eigenem
  `--home`/`PARALLAX_HOME`**, auf `%LOCALAPPDATA%\Parallax` verweigert der Server den Start),
  `--no-build` (kein Build-Check), `--validate=log|throw|off` (Prüfung ausgehender Daten gegen den
  Contract; Default `log`: ungültige Werte werden geloggt, gezählt und verworfen). Für den
  produktiven Einsatz einen eigenen Checkout verwenden, damit Entwicklungs-Neustarts nicht die
  eigene Arbeit unterbrechen (Plan A.7).
- Ausprobieren ohne die eigenen Daten anzufassen (PowerShell):
  `$env:PARALLAX_BACKEND='fake'; $env:PARALLAX_HOME="$env:TEMP\px-try"; pnpm start`.
- Startet ein Terminal den Launcher in einem Job-Objekt, das beim Schließen alle Prozesse beendet,
  endet auch der Server – im Zweifel `parallax.cmd` per Doppelklick starten.

### Edge-Profil
Das App-Fenster nutzt ein eigenes Edge-Profil (`<Datenordner>\edge`), das sich **nie** mit dem
Microsoft-/Windows-Konto anmeldet und **nie** synchronisiert: Der Launcher startet Edge mit
`--disable-sync`, `--allow-browser-signin=false` und
`--disable-features=msImplicitSignin,…` (ohne diese Schalter meldet Edge ein frisches Profil
implizit mit dem Windows-Konto an und richtet Sync ein; ADR-060). Es werden keine Richtlinien,
keine Registry-Einträge und keine Admin-Rechte gebraucht. Prüfen lässt es sich in einem
Parallax-Fenster unter `edge://signin-internals` („Signin Status: Not Signed In“).

- Ein Profil, das eine ältere Parallax-Version schon angemeldet hat, bleibt angemeldet (Sync bleibt
  trotzdem aus); der Launcher weist darauf hin. Abmelden im Fenster („…“ → Einstellungen →
  Profile) oder alle Parallax-Fenster schließen und den Ordner `edge` löschen (nur
  Benachrichtigungs-Freigaben gehen verloren).
- **Firmenrechner:** Edge-Richtlinien (Gruppenrichtlinie/Intune, `HKLM`/`HKCU\SOFTWARE\Policies\
  Microsoft\Edge`) gehen Kommandozeilenschaltern vor – z. B. `BrowserSignin=2` (Anmeldung
  erzwingen), `ForceSync`, `ImplicitSignInEnabled=1`, `FeatureFlagOverridesControl=0` (ignoriert
  `--disable-features`) oder `UserDataDir`. `pnpm preflight` warnt bei solchen Richtlinien
  (Prüfung „edge policies“); dann nach dem ersten Start `edge://signin-internals` und
  `edge://policy` im Parallax-Fenster ansehen.

## Andere Registry / Firmen-Nexus
Im Projekt ist **keine Registry** eingetragen; der Lockfile enthält keine Tarball-URLs und
funktioniert mit npmjs und einem Nexus-Mirror gleichermaßen.

- **Dauerhaft** in `~/.npmrc` (pnpm 11+ liest daraus nur Registry- und Auth-Einstellungen):
  ```ini
  registry=https://nexus.example.com/repository/npm-all/
  //nexus.example.com/repository/npm-all/:_authToken=<token>
  cafile=C:\Pfad\zum\firmen-ca.pem
  https-proxy=http://proxy.example.com:8080
  ```
  Hinweis: `_auth` (Basic-Auth) wird von pnpm 11+ in `~/.npmrc` eventuell ignoriert; dann im
  globalen pnpm-`config.yaml` setzen oder per Umgebungsvariable `pnpm_config__auth`.
- **Ad hoc:** `pnpm install --registry https://nexus.example.com/repository/npm-all/`
- **Per Umgebung:** `$env:pnpm_config_registry = 'https://nexus.example.com/…'`
  (`npm_config_*` wird von pnpm 11+ nicht mehr gelesen).
- Kontrolle: `pnpm config get registry` (zeigt später auch `pnpm preflight`).
- Liefert der Nexus kein `time`-Feld, greift `minimumReleaseAge` eventuell nicht.
- Das Nachladen der gepinnten pnpm-Version holt `pnpm`/`@pnpm/exe.*` aus derselben Registry.
  Blockiert AppLocker/WDAC die native `pnpm.exe`, ist pnpm 11.28 der Fallback.
- **In den Claude-Sessions:** Parallax entfernt `npm_*`/`PNPM_*`/`NODE_OPTIONS` aus der Umgebung
  gestarteter `claude`-Prozesse (Laufzustand von `pnpm run`), behält sie aber, wenn sie **dauerhaft**
  als Benutzer- oder Systemvariable gesetzt sind (Registry `HKCU\Environment` bzw.
  `HKLM\…\Session Manager\Environment`, z. B. über „Umgebungsvariablen bearbeiten“) und denselben
  Wert haben – so erreicht eine Firmen-Registry wie `NPM_CONFIG_REGISTRY` auch `npm`/`pnpm` in den
  Sessions (ADR-021).

## Virenscanner mit Web-Traffic-Scan (z. B. Kaspersky)
Manche Virenscanner filtern auch lokalen HTTP-Verkehr auf `http://127.0.0.1`. Kasperskys
Web-Anti-Virus wurde dabei beobachtet, wie er ein eigenes Skript in die Parallax-Seite einschleust,
die Content-Security-Policy des Servers um seine Domain erweitert und die vollständige Seiten-URL
samt Einmal-Code (`#code=…`) an sein Skript übergibt (Befund V1-08). Das weicht das
Sicherheitsmodell auf (fremdes Skript im App-Fenster, Code für bis zu 60 s lesbar) und stört
außerdem Netzwerk-Prüfungen der Tests.

**Empfehlung:** `127.0.0.1` bzw. den Parallax-Port (Standard `4711`, Dev `4712`/`5173`) vom
Web-Traffic-Scan ausnehmen – bei Kaspersky als vertrauenswürdige Adresse in den Netzwerk- bzw.
Web-Anti-Virus-Einstellungen, oder dort „Skript in Datenverkehr einbetten“ abschalten
(Bezeichnungen je nach Version). `pnpm preflight` weist auf erkannte Produkte mit
Web-Traffic-Scan hin (Windows-Sicherheitscenter, ohne Admin-Rechte; Kaspersky, ESET, Bitdefender,
Avast, AVG).

## Dokumentation
- `CLAUDE.md` – Regeln, Befehle, Ordner-Ownership.
- `docs/plan.md` – abgestimmter Gesamtplan.
- `docs/progress.md`, `docs/decisions.md`, `docs/architecture.md`, `docs/wp/`.
