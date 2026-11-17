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
| `install.ts` | `installPackage` (Signatur, Dateien, Staging, SDK, Umbenennen, Stammdateien, `current.json`, Startmenü, Aufräumen), `useVersion` |
| `uninstall.ts` | Einträge entfernen, dann genau die Namen aus `ROOT_ENTRIES`; fremde Dateien bleiben, Daten bleiben |
| `versions.ts` | installierte Versionen, Version eines laufenden Servers (Build-ID), Aufräumen über `.trash-*` |
| `layout.ts` | Ordner und Dateinamen, `current.json`, `defaultInstallRoot`, Testsperre `assertNotRealUserFolder` |
| `templates.ts` | `start.mjs`, `parallax.cmd` und `install.cmd` (eine Quelle; `.cmd` mit CRLF) |
| `parallax.ico` | Symbol des Startmenü-Eintrags (aus `favicon.svg` gerendert, 16–256 px) |
| `testPackage.ts` | nur für Tests: kleines synthetisches Paket, signiert mit einem Test-Schlüssel |

- **Vertrauen:** Geprüft wird mit dem Code und den Schlüsseln, die gerade laufen. Startet `install.cmd` eines neuen
  Pakets und gibt es schon eine Installation, übergibt es an deren `start.mjs --install <paket>`; nur die erste
  Installation vertraut dem geladenen Installer (WP-83 §7). Andere Schlüssel gibt es nur über die Test-Naht `keys`,
  nie über die Kommandozeile.
- **Tests** nehmen nie die echten Ordner: `assertNotRealUserFolder` bricht in einem Testlauf ab, wenn der Stammordner
  oder das Startmenü in `%LOCALAPPDATA%\Programs\Parallax` bzw. im echten Startmenü läge. `templates.test.ts` startet
  `start.mjs` wirklich mit `node.exe`.
