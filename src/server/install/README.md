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
