# src/server/install – Installation (WP-86)

Auftrag: `docs/wp/WP-86.md`, Hintergrund `docs/wp/WP-83.md` §8. Der Installer (`dist/install.js`) setzt eine
Release-Version in den Stammordner `%LOCALAPPDATA%\Programs\Parallax` ein; die Module hier sind seine Bausteine.

## Agent SDK (`sdk.ts`, `npmrc.ts`; 86b)

Das Agent SDK ist proprietär und liegt nicht im Release-Zip. `provideSdk({ spec, target, cacheDir, tempDir, … })`
legt genau die Version aus `release.json` `sdk` nach `<versionsordner>\node_modules\@anthropic-ai\claude-agent-sdk`
und gibt die Quelle zurück (`cache` | `tarball` | `npm` | `download`).

- **Reihenfolge:**
  1. Cache `<root>\cache\anthropic-ai-claude-agent-sdk-<version>.tgz` – wird erneut geprüft, ein kaputter Eintrag
     wird gelöscht. Normalfall bei einem Update ohne SDK-Wechsel, ohne Netz.
  2. `--sdk-tarball <datei>` – ohne Rückfall: ein falscher Hash ist ein Fehler, die Datei des Nutzers bleibt liegen.
  3. npm neben Node: `node.exe <node-ordner>\node_modules\npm\bin\npm-cli.js pack <name>@<version>
     --pack-destination <root>\downloads\npm-… --json [--registry <url>]` über `runFile` (absolutes `node.exe`,
     ohne Shell, `windowsHide`, 5 min). npm wertet die ganze Konfiguration aus (Scope-Registries, Auth, `cafile`,
     Proxy). Fehlt npm oder scheitert es, folgt Schritt 4.
  4. Eigener Download: Registry aus `--registry` > `NPM_CONFIG_REGISTRY` > `.npmrc` (`@anthropic-ai:registry`, dann
     `registry`) > `https://registry.npmjs.org/`; Metadaten `GET <registry>/@anthropic-ai%2Fclaude-agent-sdk`,
     Tarball-URL aus `versions[<v>].dist.tarball`. Nur `https:` (`http:` nur für `127.0.0.1`/`localhost`), höchstens
     200 MB (Metadaten 64 MB), 5 min je Anfrage. Weiterleitungen folgt das Modul selbst: jede Station wird geprüft und
     bekommt nur die Anmeldung ihres eigenen Hosts.
- **Prüfung, für jeden Weg gleich:** Die Datei wird in eine Temp-Datei im Cache kopiert, dort per SHA-512 gegen die
  `integrity` geprüft und erst dann umbenannt. Entpackt wird die Cache-Datei mit
  `System32\tar.exe -x -z --strip-components=1`; danach muss `package.json` Name und Version der Spec tragen.
  Fehlschläge werfen `SdkError` mit einer Meldung für den Nutzer: was versucht wurde und der Hinweis auf
  `--sdk-tarball`. URLs in Meldungen und Logs ohne Anmeldedaten und ohne Query.
- **`npmrc.ts`:** `readNpmrc(env, readFile?)` liest `NPM_CONFIG_USERCONFIG` bzw. `%USERPROFILE%\.npmrc` (fehlt = leer;
  UNC-, Geräte- und relative Pfade werden nie angefasst) mit den Regeln von npm (`;`/`#`-Kommentare, Anführungszeichen,
  `${VAR}`/`${VAR?}`). `registryFor(scope, npmrc, env)`; `authFor(url, npmrc)` liefert den `Authorization`-Header aus
  `//host[:port][/pfad]/:_authToken`, `:_auth` oder `:username` + `:_password` – längster passender Präfix, nie ein
  anderer Host oder Port.
- **Tests** (`sdk.test.ts`, `npmrc.test.ts`): Fakes für `run` und `fetch`, Temp-Ordner, kleine echte Tarballs aus
  `tar.exe -c -z`; ein Test mit echtem `fetch` gegen einen Loopback-Server. Kein Netz, nie das echte Profil.

## Installer (86d)

| Datei | Inhalt |
| --- | --- |
| `main.ts` | Einstieg, gebündelt nach `dist/install.js` (`scripts/build-server.ts`) |
| `cli.ts` | Ablauf: Argumente, Node-Version, Neustart mit `PACKAGE_NODE_FLAGS`, Übergabe an eine vorhandene Installation, Sperre je Stammordner, Meldungen |
| `nodeDeps.ts` | echte Abhängigkeiten (SDK, Startmenü und Einträge aus `system/installation.ts`, laufender Server, Sperre, `node.exe` mit dieser Konsole) |
| `args.ts` | Kommandozeile: `--dir`, `--registry`, `--sdk-tarball`, `--use`, `--uninstall`, `--install` und `--install-root` (von `start.mjs`) |
| `install.ts` | `installPackage` (Signatur, Dateien, Staging, SDK, Umbenennen, Stammdateien, `current.json`, Startmenü, Aufräumen), `useVersion`; seit WP-87 aus den Teilen unten zusammengesetzt |
| `uninstall.ts` | Einträge entfernen, dann genau die Namen aus `rootEntries()` der Plattform; fremde Dateien bleiben, Daten bleiben |
| `versions.ts` | installierte Versionen, Version eines laufenden Servers (Build-ID), Aufräumen über `.trash-*` |
| `layout.ts` | Ordner und Dateinamen, `current.json`, `defaultInstallRoot`, Testsperre `assertNotRealUserFolder` |
| `templates.ts` | `start.mjs`, `parallax.cmd` und `install.cmd` (eine Quelle; `.cmd` mit CRLF); Linux: `parallax`, `install.sh` und der Befehl (POSIX-`sh`, LF) |
| `command.ts` | Linux: der Befehl `~/.local/bin/parallax` (Markierungszeile mit dem Stammordner; fremde Dateien bleiben) |
| `parallax.ico` | Symbol des Startmenü-Eintrags (aus `favicon.svg` gerendert, 16–256 px) |
| `testPackage.ts` | nur für Tests: kleines synthetisches Paket, signiert mit einem Test-Schlüssel (`rootFiles: true` liefert `root/` mit) |

- **Vertrauen:** Geprüft wird mit dem Code und den Schlüsseln, die gerade laufen. Startet `install.cmd` eines neuen
  Pakets und gibt es schon eine Installation, übergibt es an deren `start.mjs --install <paket>`; nur die erste
  Installation vertraut dem geladenen Installer (WP-83 §7). Andere Schlüssel gibt es nur über die Test-Naht `keys`,
  nie über die Kommandozeile.
- **Tests** nehmen nie die echten Ordner: `assertNotRealUserFolder` bricht in einem Testlauf ab, wenn der Stammordner
  oder das Startmenü in `%LOCALAPPDATA%\Programs\Parallax` bzw. im echten Startmenü läge. `templates.test.ts` startet
  `start.mjs` wirklich mit `node.exe`.

## Geteilt mit dem Update (WP-87, `docs/wp/WP-87.md` §1.9)

`installPackage` und `useVersion` verhalten sich wie in 86d; Update-Dienst (87a) und Orchestrator (87b) nutzen die
Teile einzeln.

- **`stageVersion(options, deps)`** → `{ release, bytes, dir, reused }`: Schritte 1–3 ohne Umschalten (Signatur,
  `minNode`, Dateien des Pakets, Kopie nach `versions\.staging-…`, Nachprüfung der Kopie, SDK, Umbenennen nach
  `versions\<v>`); ein intakter Versionsordner bleibt (`reused`). `signal` bricht zwischen Dateien und Schritten ab
  (der Staging-Ordner wird entfernt), `onProgress(step, done, total)` meldet je Datei: `check` (Dateien des Pakets),
  `copy` (kopierte und danach in der Kopie erneut geprüfte Dateien, `total` = doppelte Anzahl), `sdk` (0 bzw. 1 von 1).
  `deps` = `provideSdk`, `log`, `now`.
- **`switchVersion(root, version, { previous?, log })`** → `{ previous, before }`: Stammdateien und `current.json`;
  ohne `previous` wie der Installer (die bisherige Version, bzw. deren `previous`, wenn es schon `version` war).
  `before` ist der alte Inhalt von `current.json` (null = fehlte oder kaputt).
- **`restoreCurrent(root, before)`**: zuerst `current.json` (so geschrieben wie vom Installer, also byte-gleich zu
  einer Datei des Installers; `null` löscht sie), dann die Stammdateien dieser Version.
- **`verifyVersion(root, version, keys)`** → `ReleaseInfo`: Signatur der `release.json` des Versionsordners, ihre
  Version, jede gelistete Datei samt Hash (keine zu viel), Name und Version des Agent SDK; wirft `InstallError`.
- **`InstallError.reason`** (`INSTALL_ERROR_REASONS`): `signature`, `node`, `files`, `sdk`, `in_use`, `io` (Standard).
  `installErrorReason(error)` liefert sie für jeden Fehler: `SdkError` → `sdk`, alles andere ohne Grund → `io`.
- **Stammdateien aus dem Paket:** `scripts/release-pack.ts` legt `root/start.mjs` und `root/parallax.cmd`
  (`packageRootFiles(minNode)`) ins Paket, gelistet in `release.json` und damit signiert. `writeRootFiles` nimmt
  jede der beiden aus `versions\<v>\root\`, wenn sie dort liegt, sonst die Vorlage des laufenden Codes – nach einer
  Übergabe schreibt so die neue Version ihre eigenen Stammdateien.

## Linux (WP-108, Ablage nach WP-100 E7)

- **Ordner:** Programm `~/.local/lib/parallax` (`versions/<v>`, `current.json`, `start.mjs`, Startskript `parallax`,
  Symbol `parallax.svg`), Befehl `~/.local/bin/parallax`, Daten `$XDG_DATA_HOME/parallax` (`config.ts`). Die Namen je
  Plattform liefern `startCommandFile()`, `iconFile()`, `rootEntries()`, `defaultInstallRoot()`, `defaultBinDir()`;
  Pfade prüfen `installPathRules()` (POSIX: exakt, keine Pseudo-Dateisysteme).
- **Einstieg:** `sh install.sh` sucht `node` nur in absoluten `PATH`-Einträgen, prüft, dass es startet (fehlendes
  `libatomic1` auf minimalen Systemen) und mindestens `minNode` ist, und startet `dist/install.js` ohne Node-Flags.
  `cli.ts` nennt ein OpenSSL älter als 3.5 (`opensslNote`; „Mehrere Rechner“ braucht es, der offizielle Build bringt es).
- **Befehl** (`command.ts`): `ensureCommand` schreibt `~/.local/bin/parallax` (Modus 755), wenn er fehlt oder zum
  selben Stammordner gehört; ein Befehl einer anderen Installation, eine fremde Datei oder ein Link bleiben
  (`ok: false` mit Grund – gestartet wird dann über `<root>/parallax`). `removeCommand` entfernt nur den eigenen.
  `isOnPath` entscheidet die Meldung (Ubuntu nimmt `~/.local/bin` ab der nächsten Anmeldung in den `PATH`).
- **Stammdateien:** `writeRootFiles` schreibt `start.mjs`, das Startskript der Plattform (Linux mit Modus 755) und das
  Symbol der Plattform. Ein Paket trägt beide Plattformen (`root/parallax.cmd`, `root/parallax`, `install.cmd`,
  `install.sh`, `parallax.ico`, `parallax.svg`).
- **SDK:** npm des offiziellen Builds unter `<prefix>/lib/node_modules/npm/bin/npm-cli.js` (`npmCliPath`), Entpacken
  mit `/usr/bin/tar` (GNU, `--no-same-owner --no-same-permissions`, `tarTool`/`unpackArgs`). `npmrc.ts`: `$HOME/.npmrc`,
  `${VAR}` exakt, `npm_config_*` in jeder Schreibweise.
- **Deinstallation:** Menüeintrag, Autostart und `parallax:` über `system/installation.ts` (WP-106), der Befehl hier,
  der Benutzerdienst über `NodeInstallerOptions.removeService` (WP-107 verdrahtet ihn). Die Daten bleiben.
- **Tests:** eigene Ordner (`HOME` bzw. `--dir` im Testordner); `templates.test.ts` startet `parallax` und
  `install.sh` unter Linux wirklich mit `/bin/sh`.
