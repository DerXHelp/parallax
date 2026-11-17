# WP-89e – E2E des Updates in der App

Teilpaket von WP-89 (Auftrag: `docs/wp/WP-87.md` §2.5 „E2E“, dazu §0 E1–E7, §1.7, §3, §4).
Branch `wp/89e` von `feature/releases`.

## 1. Ergebnis

`e2e/update.spec.ts` prüft das Update gegen echte Prozesse: eine Installationswurzel mit Version A, gestartet wie
`parallax.cmd`, ein lokaler Release-Server samt Fake-Registry, Chrome. Ein Worker, die Tests bauen aufeinander auf
(`test.describe.configure({ mode: 'serial' })`):

| # | Ablauf | Prüfungen |
|---|---|---|
| 1 | 404 auf `latest.json` → „Check now“ | „Parallax is up to date.“, „Last checked …“, kein Fehler, kein Hinweis in der Sidebar, Anfrage an `latest.json`; Version/Build von A. Schaltet die automatische Prüfung aus (gespeichert, `serverSettings`) – sie liefe sonst 60 s nach jedem Start dazwischen |
| 2 | Hinweis → Vorbereiten → Neu starten | Session mit Turn vorher; Hinweis „available“ → Abschnitt → „ready“ → Bestätigung; Banner „startet neu“ gesehen, Seite lädt neu, `update-done` (`forward`) „Updated to Parallax 9.9.1“, „What's new“ zeigt nur 9.9.1, `current.json` = `{9.9.1, previous 9.9.0}`, Marker verbraucht, `last-version.json` = Build von B, Session da, Abschnitt zeigt 9.9.1 und „Back to 9.9.0“, SDK aus dem Cache (keine Registry-Anfrage) |
| 3 | „Back to 9.9.0“ | Banner, Neuladen, `update-done` (`back`) „Switched to Parallax 9.9.0 (was 9.9.1)“, `current.json` = `{9.9.0, previous 9.9.1}`, Build von A, Session da |
| 4 | B-kaputt (9.9.2) | Vorbereiten, Neu starten; der Orchestrator geht zurück: `update-failed` „Update to Parallax 9.9.2 failed – back on 9.9.0“ mit „The new version stopped right after its start.“, Protokoll unter `<home>\logs` nennt 9.9.2, `current.json` **byte-gleich** zu vorher, Build von A, Einstellung (Auto-Prüfung aus) und Session zurück, Marker verbraucht |
| 5 | Upload einer Textdatei als `.zip` | `update-error` `UPDATE_INVALID_PACKAGE` mit „The file is not a readable zip archive.“, Status unverändert, `<root>\downloads` leer |
| 6 | Upload eines signierten Pakets mit falschem SDK-Hash (9.9.3) | `UPDATE_SDK_FAILED`, nichts unter `versions\9.9.3`, die Fake-Registry wurde gefragt (Metadaten + Tarball) |

Nach jedem Wechsel (`waitForRestart`): der nächste Server antwortet auf **demselben Port** (Lockfile mit anderer PID,
Health mit derselben `serverInstanceId`), der alte Serverprozess ist weg und unter ihm läuft kein Kind mehr, das nach
ihm gestartet ist (Orchestrator → neuer Server); sonst Abbruch mit Liste und Rückbau. Am Ende beendet sich der letzte
Server sauber (`requestShutdown` + `assertCleanExit`: Exit, Lockfile weg, keine Kinder, keine Fehlerzeilen).

### 1.1 Helfer (`e2e/support/`)
- **`update-packages.ts`** – Test-Builds je Version: `vite build --outDir <tmp>\dist\web` und
  `scripts/build-server.ts --update-test --out-dir=<tmp>\dist` mit `PARALLAX_BUILD_ID=<version>+e2e.<key>`, dann
  `checkBuild` (Banner von `server.js` und `web/build.json` = Build-ID) und Umbenennen. Cache unter
  `node_modules\.cache\parallax-update-e2e\<key>\<version>` (`key` = Hash der Build-ID des Checkouts; ältere Keys
  werden gelöscht), unter dem Build-Lock des Checkouts; `dist/` bleibt unberührt. Pakete wie `release-pack` ohne
  `node_modules` (`root/`-Dateien aus `packageRootFiles`, `CHANGELOG.md` mit den Testversionen, echte
  Schema-Hashes `storeSchemaHashes()`, `release.json` + `.sig` mit `makeTestKey`), Zip über `zipFolders`.
  Mini-SDK: Tarball nur mit `package/package.json` (System-`tar.exe`), Integrität per `sha512Integrity`.
- **`update-release-server.ts`** – `node:http` auf 127.0.0.1:0: `releases/latest/download/latest.json` + `.sig`
  (oder 404), `releases/download/v<v>/parallax-<v>-win.zip`, `…/CHANGELOG.md`; `offer()` schaltet je Test um.
  Dazu die Fake-Registry (`registry/@anthropic-ai%2Fclaude-agent-sdk` → Metadaten, Tarball). Jede Anfrage wird
  protokolliert.
- **`update-install.ts`** – Installation von A, Umgebung, freier Port, Start über `start.mjs`, `waitForRestart`,
  Rückbau (`killInstallation` beendet nur Prozesse, deren Startzeit passt – PIDs werden wiederverwendet),
  Orchestrator-Protokolle als Anhang.

## 2. Entscheidungen
1. **A wird im Testprozess installiert** (`stageVersion` mit `keys: [testKey.x]` + `switchVersion`), nicht über
   `install.js`: das Installer-Bundle prüft nur mit den Release-Schlüsseln seines eigenen Codes (kein Test-Schalter)
   und legt einen Startmenü-Eintrag an. Der Installer hat eigene Tests (WP-86/87p, `smoke.ts`); hier zählt der Weg
   ab einer installierten Wurzel. Das Staging von A füllt zugleich `<root>\cache` mit dem Mini-SDK.
2. **npm isoliert, ohne Netz:** Launcher, Server, Orchestrator und jeder spätere Server bekommen
   `NPM_CONFIG_OFFLINE=true`, eigenen Cache und eine leere Nutzer-/Global-Konfiguration. `npm pack` neben Node
   scheitert damit sofort, der SDK-Schritt fällt auf den eigenen Download aus `PARALLAX_TEST_REGISTRY` zurück
   (nur in Test 6 nötig, sonst greift der Cache). Dazu `NODE_ENV=test`, keine geerbten `PARALLAX*`/`VITEST*`,
   `PARALLAX_TOASTS=off`, `NO_PROXY` um `127.0.0.1,localhost` ergänzt (`--use-env-proxy` aus `PACKAGE_NODE_FLAGS`).
3. **Start wie `parallax.cmd`:** `node --use-system-ca --use-env-proxy <root>\start.mjs --print-url --backend=fake
   --toasts=off --system-integration=off --port=<fest> --home=<temp>` ohne Shell, Ausgabe in eine Datei (der
   abgelöste Server erbt die Handles), Anmeldung über die gedruckte URL in Chrome (`ParallaxApp.open` holt für jede
   neue Seite einen frischen Code über den Lock-Token). Der Port wird zu Beginn frei gewählt und bleibt fest – das
   Fenster verbindet sich nach dem Wechsel nur mit demselben Origin neu.

## 3. Stolpersteine
- `[data-slot="update-notice"]` gibt es zweimal: den Rahmen der Shell (`SidebarUpdateNotice`, immer da, per
  `empty:hidden` versteckt) und den Hinweis des Features. Die Spec nimmt `[data-slot="update-notice"][data-state]`.
- Die Einstellungsseite ist ein modaler Dialog: den Sidebar-Hinweis erst nach `Escape` anklicken.
- Das Banner „startet neu“ steht nur Sekunden, danach lädt die Seite neu. Ein Init-Script mit `MutationObserver`
  meldet es über `context.exposeFunction` (überlebt das Neuladen); `page.waitForEvent('load')` wird vor der
  Bestätigung angelegt.
- B-kaputt behält Banner und `web/build.json` passend zur eigenen Build-ID, sonst lehnt der Launcher das Paket schon
  als `package_damaged` ab und der Orchestrator-Rückweg wird nicht geprüft.
- Das 9.9.3-Paket enthält nur Stub-Dateien in `dist/`: das Staging scheitert am SDK-Schritt, bevor etwas läuft.
- Test 6 muss der letzte sein: ein falscher Hash entfernt den (passenden) SDK-Cache der Wurzel (`sdk.ts` Schritt 1).
- `assertCleanExit` passt nur für den letzten Server – nach einem Wechsel gibt es ein neues Lockfile; für die
  Zwischenstände prüft `waitForRestart` PID und Kinder selbst.
- `childProcesses` liefert nur direkte Kinder: der Orchestrator ist Kind des alten Servers, der neue Server Kind des
  Orchestrators (läuft nach dessen Ende ohne Elternprozess weiter).
- Wurzel und Pakete liegen unter `<repo>\test-results\update-e2e\`, damit die Bundles `<repo>\node_modules`
  auflösen; Playwright leert `test-results/` bei jedem Start, deshalb der Build-Cache unter `node_modules\.cache`.
  Nach einem Fehlschlag bleibt der Ordner zur Diagnose liegen (der nächste Lauf räumt ihn), das Temp-Home nicht.

## 4. Laufzeiten
Gemessen mit `pnpm exec playwright test e2e/update.spec.ts` (Priorität „niedriger als normal“, allein auf der
Maschine), Gesamtzeit inklusive Playwright-Start:

| Lauf | Gesamt | `beforeAll` | Tests 1–6 |
|---|---|---|---|
| warm (Build-Cache da), 5 Läufe nacheinander | 50–56 s | 6–7 s | 2,2–2,4 / 15–18 / 6–8 / 10–12 / 1,9–2,2 / 2,8–3,0 s |
| kalt (Build-Cache gelöscht, `dist/` da) | 54 s | 9 s (Test-Builds 2 s) | wie warm |
| allererster Lauf (Global-Setup baut `dist/`, Test-Builds kalt) | 71 s bis zum Abbruch in Test 1 | 43 s (Test-Builds 3 s) | – |

Sechs grüne Läufe in Folge (nach der Korrektur des Hinweis-Selektors), kein Flake. Der lange `beforeAll` im ersten
Lauf entfiel auf das Kopieren/Zippen der frisch gebauten Pakete (≈ 20 MB je Version; vermutlich Virenscanner und
kalter Dateicache), danach 5–8 s. Vite 8 baut die Web-UI je Version in ≈ 1 s.

## 5. Produktcode
Keine Änderung nötig – alle Abläufe liefen mit dem Stand von `feature/releases` (bis WP-89 Security-Fixes).

## 6. Offene Punkte
- `docs/wp/WP-87.md` §2.5 nennt `dist-e2e/` als Ausgabe des Test-Builds; die Spec baut über `--out-dir` in den
  Cache (siehe §1.1).
- Nicht abgedeckt: abgebrochener Download, `UPDATE_INVALID_SIGNATURE`, `UPDATE_DOWNGRADE_BLOCKED`,
  `UPDATE_NODE_TOO_OLD` und die Kompatibilitätsregeln §1.7 (Unit-Tests), der echte Installer.
  Die Live-Prüfung („Zurück zu …“ in beide Richtungen mit echten Releases) bleibt beim Koordinator.
- `pnpm e2e` nimmt die Spec mit (≈ 1 min zusätzlich, ein Worker von dreien).
