# Entscheidungen (ADRs)

Kurze Architektur-Entscheidungen. **Nur anhängen**, nichts umschreiben. Wird eine Entscheidung
revidiert, kommt ein neuer Eintrag, der auf den alten verweist.

Format: `ADR-NNN – Titel` · Datum · WP · Kontext → Entscheidung → Folgen.

---

## ADR-001 – ESLint 9 statt ESLint 10
- **Datum/WP:** 15.10.2026, WP-00
- **Kontext:** ESLint 10.12 ist `latest`, aber `eslint-plugin-react` 7.37.5 (nötig für
  `react/jsx-no-literals`, „kein UI-String ohne `t()`“) unterstützt laut Peer-Range nur bis
  ESLint `^9.7`. Ein Ersatz mit gleichwertiger Regel existiert nicht.
- **Entscheidung:** `eslint@^9.39.5` und `@eslint/js@^9.39.5` (Dist-Tag `maintenance`), Flat Config
  über `defineConfig` aus `eslint/config`.
- **Folgen:** Kein Peer-Konflikt. Upgrade auf ESLint 10, sobald `eslint-plugin-react` es unterstützt.

## ADR-002 – TypeScript 6.0 statt 7.0
- **Datum/WP:** 15.10.2026, WP-00
- **Kontext:** TypeScript 7.0.2 (native) ist `latest`, `typescript-eslint` 8.71.2 verlangt aber
  `typescript >=4.8.4 <6.1.0`.
- **Entscheidung:** `typescript@~6.0.3`.
- **Folgen:** Upgrade auf TS 7, sobald `typescript-eslint` es unterstützt (Typecheck-Zeiten sinken dann).

## ADR-003 – TS-Projektreferenzen: shared composite, Rest `noEmit` mit `rootDir` als Importgrenze
- **Datum/WP:** 15.10.2026, WP-00
- **Kontext:** „Web darf nie Server-Code importieren“ soll auch der Compiler erzwingen, ohne dass
  Server und Web Deklarationen erzeugen müssen (TS2742-Probleme mit pnpm).
- **Entscheidung:** `src/shared` ist `composite` (`emitDeclarationOnly` nach `.tsbuild/shared`).
  `src/server`, `src/web` und `tsconfig.tools.json` sind `noEmit`, referenzieren `src/shared` und
  setzen `rootDir: "."`. Ein Import über die eigene Grenze hinweg ergibt TS6059. Root-`tsconfig.json`
  ist eine Solution-Datei; `pnpm typecheck` = `tsc -b`. Zusätzlich ESLint `no-restricted-imports`.
- **Folgen:** Skripte (`tsconfig.tools.json`) dürfen Server-Module importieren (z. B. Preflight).
  Aliase: `@shared/*` überall, `@web/*` nur im Web; tsconfig, Vite, Vitest und esbuild konsistent
  (`repo.config.ts`).

## ADR-004 – Server-Bundle mit esbuild, npm-Pakete extern
- **Datum/WP:** 15.10.2026, WP-00
- **Kontext:** `dist/server.js` soll direkt mit `node` startbar sein. pino-Transports (Worker-Threads)
  und das Agent SDK vertragen kein Bundling.
- **Entscheidung:** `scripts/build-server.ts` (esbuild-API): ESM, `platform: node`, `target: node22`,
  `packages: 'external'`, Alias nur `@shared`. Eigener Code und `src/shared` werden gebündelt.
- **Folgen:** `pnpm start` braucht ein installiertes `node_modules` (ist bei `git clone` +
  `pnpm install` gegeben).

## ADR-005 – Vitest-Projekte `node` und `web` mit happy-dom
- **Datum/WP:** 15.10.2026, WP-00
- **Kontext:** Komponenten-Tests (WP-14/15/16) brauchen ein DOM; spätere Pakete dürfen
  `package.json` nicht ändern.
- **Entscheidung:** Vitest 5 mit `test.projects`: `node` (server, shared, scripts, test) und `web`
  (`happy-dom`, `@testing-library/react`, `@testing-library/dom`, `@testing-library/user-event`).
  happy-dom statt jsdom: schlanker, keine Build-Skripte. Keine Vitest-Globals.
  `globalSetup` setzt `PARALLAX_HOME=<tmp>` und `PARALLAX_PORT=0`, falls nicht gesetzt.
- **Folgen:** Falls happy-dom für Radix/virtua nicht reicht, jsdom über den Koordinator nachziehen.

## ADR-006 – Dev-Konventionen: Ports, Home, CLI-Flags
- **Datum/WP:** 15.10.2026, WP-00
- **Kontext:** Dev-Läufe dürfen weder das produktive Parallax (Default-Port 4711) noch
  `%LOCALAPPDATA%\Parallax` berühren (Review A.7).
- **Entscheidung:** `pnpm dev` startet den Server mit `--dev --backend=fake --port=4712
  --home=.parallax-dev` (ignoriert), Vite auf `127.0.0.1:5173` mit Proxy `/api` (HTTP + WS) auf 4712.
  Alle Server-Routen inkl. WebSocket liegen unter `/api/` (z. B. `/api/ws`). Die Flags `--dev`,
  `--backend`, `--port`, `--host`, `--home` sind die Schnittstelle für die Config in WP-10
  (Vorrang: Flags > Env `PARALLAX_*` > Settings > Defaults). Konstanten in `repo.config.ts`.
- **Folgen:** WP-10 übernimmt die Flags in seine zod-validierte Config; im Dev-Modus ist die
  Vite-Origin `http://127.0.0.1:5173` zusätzlich erlaubt.

## ADR-007 – Theme-Tokens nach shadcn-Konvention, Dark per Default
- **Datum/WP:** 15.10.2026, WP-00
- **Kontext:** Dark ist Default, Light und System sind wählbar; shadcn-Komponenten nutzen
  `dark:`-Varianten.
- **Entscheidung:** Light-Tokens in `:root`, Dark-Tokens in `.dark`,
  `@custom-variant dark (&:is(.dark *))`; `index.html` setzt `class="dark"` auf `<html>`.
  Zusätzliche Tokens: `success`, `warning`, `info`, `status-{working,waiting,done,error,idle}`.
  Fonts: Inter Variable (UI) und JetBrains Mono Variable (Code), lokal über @fontsource-variable.
- **Folgen:** WP-14 schaltet nur die Klasse `dark` auf `<html>` um (System über `matchMedia`).

## ADR-008 – `@anthropic-ai/sdk` als direkte Abhängigkeit, `@types/node` auf Node 22
- **Datum/WP:** 15.10.2026, WP-00
- **Kontext:** Das Agent SDK hat die Peers `@anthropic-ai/sdk`, `@modelcontextprotocol/sdk` und
  `zod`. Mit pnpm sind automatisch installierte Peers aus dem eigenen Code nicht importierbar.
  `engines.node` ist `>=22`.
- **Entscheidung:** `@anthropic-ai/sdk` direkt (Typen für den Normalizer, z. B. Content-Blocks);
  `@modelcontextprotocol/sdk` bleibt automatisch installierter Peer. `@types/node@^22`, damit
  der Code auf der Untergrenze läuft (Standard bleibt Node 26).
- **Folgen:** SDK-Upgrades prüfen auch die Peer-Ranges (`docs/sdk-upgrade.md`, später).

## ADR-009 – Markdown ist von Prettier ausgenommen
- **Datum/WP:** 15.10.2026, WP-00
- **Kontext:** `docs/plan.md` muss eine exakte Kopie bleiben; Doku wird von Hand gepflegt.
- **Entscheidung:** `.prettierignore` enthält `**/*.md`, außerdem Fixtures (`*.jsonl`) und Lockfile.
- **Folgen:** Markdown-Formatierung ist Konvention, kein Check.

## ADR-010 – SDK-Fixture-Format v1 (JSONL mit Header und Event-Kinds)
- **Datum/WP:** 15.10.2026, WP-01
- **Kontext:** Normalizer-Snapshots (WP-12) und FakeBackend (WP-13) brauchen echte, abspielbare
  SDK-Streams inklusive Permission-Entscheidungen, Eingaben und Control-Aufrufen – ohne persönliche Daten.
- **Entscheidung:** Eine Datei pro Szenario `test/fixtures/sdk/<szenario>.jsonl`: Zeile 1 Header
  `{fixtureVersion:1, scenario, description, sdkVersion, cliVersion, recordedAt, options}`, danach
  `{seq (1…n lückenlos), tMs, kind, payload}` mit `kind` ∈ `message` (SDKMessage unverändert),
  `canUseTool`, `decision`, `input`, `control`, `call`, `stderr`, `error`, `abort`, `mark`, `spawn`,
  `exit`, `process`. Validierung per zod (`scripts/record/format.ts`). Bereinigung mit Platzhaltern
  (`<HOME>`, `<SCRATCH>`, `<USER>`, `<EMAIL>`, `<ORG>`, `<TOKEN>` …); gestreamte Blöcke werden als Ganzes
  bereinigt und neu auf die Deltas verteilt. Rohaufzeichnungen nur in `.recordings/` (ignoriert).
- **Folgen:** Konsumenten ignorieren unbekannte Kinds/Typen. Formatänderungen erhöhen `fixtureVersion`.
  Details: `docs/sdk-findings.md`, Abschnitt „Fixture-Format“.

## ADR-011 – Recorder-Guards für Live-Läufe
- **Datum/WP:** 15.10.2026, WP-01
- **Kontext:** Live-Aufrufe sind nur mit Freigabe und nur über den Abo-Login erlaubt; andere Subagenten
  dürfen nicht versehentlich Tokens verbrauchen.
- **Entscheidung:** `pnpm record` startet ein Live-`claude` nur mit `PARALLAX_LIVE=1`, nach erfolgreichem
  `claude auth status` (`claude.ai`/`firstParty`) und – außer für `auth-probe` – nur nach einem
  erfolgreichen Auth-Probe. Abbruch und Blockade-Flag (`.recordings/spike-state.json`, Aufhebung nur mit
  `--unblock`) bei `apiKeySource ≠ none`, Auth-/Billing-Fehlern, `credits_required`, `rejected`,
  `startup_failure_reason`; Abbruch bei > 2 USD geschätztem Gesamtverbrauch aller Spike-Läufe.
  Env ohne `ANTHROPIC_API_KEY`/`_AUTH_TOKEN`/`_BASE_URL`. Modell immer `haiku`.
- **Folgen:** Neu-Aufzeichnungen (z. B. nach SDK-Upgrade) laufen mit denselben Guards; das Budget gilt
  pro lokalem `spike-state.json` und muss bei einer neuen Freigabe bewusst zurückgesetzt werden.

## ADR-012 – „Regel merken“: vier Ziele, Default `session`, der Server baut `updatedPermissions`
- **Datum/WP:** 15.10.2026, WP-02 (Entscheidung des Koordinators)
- **Kontext:** Die CLI schlägt in `canUseTool.suggestions` `addRules` (meist Ziel `localSettings`),
  `addDirectories` und fast immer `setMode acceptEdits` vor. Ungefiltert zurückgegeben schaltet das die
  Session in `acceptEdits` und schreibt Regeln ins Repo; Regeln verhindern Rückfragen zudem nicht
  immer (`blockedPath`, F.3). Der Plan („Permission-Karten“) sieht die Ziele session/local/project/user vor.
- **Entscheidung:** Der Contract bildet alle vier Ziele ab (`RULE_DESTINATIONS = ['session',
  'localSettings', 'projectSettings', 'userSettings']`, `permissionOffer.ruleDestinations`,
  `permissionResponse.remember`). UI-Default ist `session`; `projectSettings` (schreibt ins Repo) und
  `userSettings` (global) kennzeichnet die UI deutlich (WP-16). Der Client sendet nur die **Absicht**
  (`remember: <Ziel> | null`, `acceptEdits: boolean`); der Server baut `updatedPermissions` selbst aus
  den gespeicherten `suggestions` (`addRules`/`addDirectories` mit dem gewählten Ziel, `setMode
  acceptEdits` nur bei `acceptEdits: true` und immer mit `destination: 'session'`). Ziel nicht im
  Angebot → `DECISION_OPTION_UNAVAILABLE`. Keine Option verspricht „nie wieder fragen“.
- **Folgen:** XSS oder Fehler im Client können keine Regeln/Modi einschleusen, die die CLI nicht
  vorgeschlagen hat. `cliArg` ist kein wählbares Ziel. Abbildung tabellengetestet in WP-13.

## ADR-013 – Build-ID per `define` in Web- und Server-Bundle
- **Datum/WP:** 15.10.2026, WP-02 (Freigabe des Koordinators für die Root-Configs)
- **Kontext:** Eine neue `buildId` im `hello` soll offene Fenster nach `git pull` neu laden (A.2).
  Web (Vite) und Server (esbuild) werden in getrennten Prozessen gebaut und brauchen denselben Wert.
- **Entscheidung:** `resolveBuildId()` in `repo.config.ts`: `PARALLAX_BUILD_ID` (falls gesetzt), sonst
  `<package.version>+<git-Kurzhash>`, bei unsauberem Arbeitsbaum zusätzlich `.dirty-<8 Hex>` (SHA-256
  über `git status --porcelain` und `git diff HEAD`). Deterministisch, daher in beiden Builds gleich.
  `vite.config.ts` (nur `vite build`) und `scripts/build-server.ts` setzen `define
  __PARALLAX_BUILD_ID__`; `src/shared/build.ts` liest es als `BUILD_ID`, ohne Bundle (Vite-Dev-Server,
  tsx, Vitest) gilt `'dev'`. Das Server-Bundle trägt die ID zusätzlich in der ersten Zeile.
- **Folgen:** Kein Zeitstempel, also kein Reload bei identischem Stand. Unversionierte neue Dateien
  ändern die ID nur über ihren Namen in `git status`. Ohne git: `<version>+nogit`.

## ADR-014 – Design-Schritte über einen General-Purpose-Agenten in Planer-Rolle
- **Datum/WP:** 15.10.2026, Koordinator (WP-02, gilt auch für WP-13)
- **Kontext:** Die Umsetzungsstrategie sieht für die schwierigsten Pakete einen Plan-Subagenten vor
  dem Coden vor. Der Plan-Agent kann keine Dateien schreiben; sein Design landete sonst vollständig
  im Kontext des Koordinators.
- **Entscheidung:** Ein General-Purpose-Agent übernimmt die Planer-Rolle, schreibt ausschließlich
  das Design in `docs/wp/WP-xx.md` (kein Code) und berichtet ≤ 250 Wörter. Ein zweiter Agent setzt
  das Design danach um und füllt den Ergebnisteil.
- **Folgen:** Das Design ist versioniert und für Folge-Pakete nachlesbar; der Koordinator-Kontext
  bleibt klein. Die Trennung Design → Umsetzung bleibt wie im Plan erhalten.

## ADR-015 – HTTP-/Auth-Contract: Launcher-Token im Lockfile, kurzlebige Einmal-Codes
- **Datum/WP:** 15.10.2026, R0-Fixes (Entscheidung des Koordinators zu R0-01)
- **Kontext:** A.8 sieht `#code=` → `POST /api/auth` → Geräte-Cookie vor, B/C.8 ein Lockfile mit
  Health-Ping und Single-Instance. Offen war, wie ein erneuter Start bei laufendem Server einen neuen
  Code bekommt, und wie der Client „nicht angemeldet“ von „nicht erreichbar“ unterscheidet (ein im
  Upgrade abgelehnter WebSocket ist im Browser nur Close 1006). WP-10 (Server) und WP-14 (Client)
  bauen parallel.
- **Entscheidung:** Neues Contract-Modul `src/shared/http.ts` (Pfade, Schemas, `authCookieName(port)`
  = `parallax_<port>`, Fehlerkörper = `ErrorPayload`). Der Server schreibt nach `listen`
  `PARALLAX_HOME/server.lock.json` mit Port, PID, Instanz-UUID und einem zufälligen
  **Launcher-Token** (32 Byte, base64url). Ein erneuter Start liest das Lockfile, prüft per
  `GET /api/health` die Instanz-UUID und holt mit `POST /api/launcher/code`
  (`Authorization: Bearer <launcherToken>`, **ohne** Origin) einen einmal nutzbaren Code mit TTL
  ≤ 60 s. Requests ohne Origin sind nur dort zulässig; alle Browser-Requests behalten die
  Origin-/Host-/`Sec-Fetch-Site`-Pflicht (A.8). Der erste Start erzeugt den Code direkt im
  Server-Prozess. `GET /api/auth/status` antwortet immer 200 (`authenticated`, `serverInstanceId`);
  der Client fragt ihn vor dem WS und nach abnormalem Close. Dev: Origin **und** Host
  `127.0.0.1:5173` zusätzlich erlaubt, eine Dev-URL mit Code (TTL 10 min) wird geloggt. Neuer
  Fehlercode `LAUNCHER_TOKEN_INVALID`.
- **Folgen:** Keine HMAC-Variante, kein Code im Log außer im Dev-Modus, kein Code in URLs außer
  im Fragment. Ownership: Server WP-10 (`http/auth.ts`, `http/origin.ts`), Client WP-14
  (`state/auth.ts`), Launcher und Lockfile WP-21. Details: `docs/architecture.md` §5.1.

## ADR-016 – Anzeige-Status `needs-resume` für unterbrochene Sessions mit abgelaufenen Karten
- **Datum/WP:** 15.10.2026, R0-Fixes (Entscheidung des Koordinators zu R0-14)
- **Kontext:** Nach einem Serverneustart mit offener Entscheidung ist die Session `interrupted`
  und die Karte read-only „abgelaufen“ (A.10). Ohne den Nutzer geht es nicht weiter („Fortsetzen &
  Plan freigeben“), `needsAttention` war aber `false`.
- **Entscheidung:** Neue Zeile 3 in `deriveDisplayStatus`: `runState = interrupted` und
  `decisions.expired > 0` → `kind: 'needs-resume'`, `needsAttention: true`, `sortBucket: 0`. Sie
  zählt zu „Wartet auf dich (n)“ und hat ein eigenes Icon/i18n-Schlüssel (`status.needs-resume`),
  unterscheidbar von aktiven Entscheidungen. `notificationFor` meldet dafür nichts (der Zustand
  entsteht nur beim Serverstart). Kein neuer `runState`, keine neuen Fakten.
- **Folgen:** `DISPLAY_STATUS_KINDS` hat 14 Werte; WP-14 braucht Icon und Übersetzung. `canSleep`
  bleibt unverändert (`interrupted` schläft nie). Tabelle: `docs/architecture.md` §7.

## ADR-017 – Eine Pfadregel-Implementierung in `@shared/paths`, Feature-Slots statt Querimporte
- **Datum/WP:** 15.10.2026, R0-Fixes (Koordinator-Vorgabe zu R0-02/R0-03)
- **Kontext:** WP-10 und WP-11 laufen parallel und brauchen beide den sicherheitskritischen
  UNC-/Device-/ADS-Filter (C.10); Owner des Pfad-Helfers ist WP-10. WP-15 rendert die Plan-Karte von
  WP-16, WP-16 braucht Markdown und Diff-Vorschau von WP-15 – beide laufen parallel in Welle 1b.
- **Entscheidung:** Die reinen Pfadregeln (`windowsPathIssue`, `windowsPathKey`, …) liegen getestet
  und eingefroren in `src/shared/paths.ts`. `src/server/lib/paths.ts` (WP-10) ergänzt nur
  Dateisystem-Prüfungen (`assertSafePath`, `checkCwd`); WP-11 und das Web importieren
  `@shared/paths` direkt, niemand dupliziert die Regeln. `lib/process.ts` gehört WP-11. Im Web
  liefert WP-14 `src/web/shell/slots.tsx` (`FeatureSlots`: Shell-Slots plus `DecisionCard`,
  `Markdown`, `ToolInputPreview`); Features importieren einander nie, WP-20 setzt die echten
  Komponenten in `App.tsx` ein. i18n-Wörterbücher je Feature in `features/<f>/i18n/` (Stubs von
  WP-14, statisch registriert), Playground per `import.meta.glob`, `src/web/{ui,lib,state,i18n}` in
  Welle 1b read-only.
- **Folgen:** Datei-genaue Ownership in `CLAUDE.md` und `docs/architecture.md` §2.1; keine
  gemeinsam bearbeitete Datei zwischen WP-10/11/12/14 bzw. WP-13/15/16.

## ADR-018 – Request-Guard nach gematchter Route, Default-deny, zweite Linie in der WS-Route
- **Datum/WP:** 15.10.2026, R1-Fixes Server (R1-01, BLOCKER)
- **Kontext:** Der Guard verglich den **rohen** URL-Pfad mit `API_PATHS`, der Router (find-my-way)
  dekodiert dagegen Prozent-Kodierung und reduziert die Absolute-Form vor dem Matching. `/%61pi/ws`
  oder `GET http://127.0.0.1:P/api/blob/<id>` galten als „statisch“ – WS und Blobs waren ohne Cookie
  und sogar von jeder Website aus erreichbar (Cross-Site-WebSocket, nach WP-13/20 Codeausführung).
- **Entscheidung:** Klassifiziert wird nach dem Muster der **gematchten Route**
  (`request.routeOptions.url`) plus Methode (`http/origin.ts`, Tabelle §5.1); nicht gelistete
  Routen/Methoden sind `mutation` (Origin + same-origin + Cookie, auch für GET), GET/HEAD ohne Route
  (404) wie `public-get`. Vor der Tabelle: Host-Prüfung, Request-Target nur in Origin-Form, auf
  API-Routen nur kanonische Rohpfade (`/api/<seg>/…`, Segmente `[A-Za-z0-9_-]`) → sonst 400
  `VALIDATION_FAILED {reason:'request_target'}`; WebSocket-Upgrades nur auf `/api/ws` → sonst 400
  `INVALID_MESSAGE {reason:'upgrade_not_allowed'}` (`@fastify/websocket` schlösse sonst auf jeder
  GET-Route den Handshake ab). Die WS-Route prüft das Upgrade zusätzlich selbst
  (`attach(app, {authorizeUpgrade})`: `preValidation` mit HTTP-Fehlerantwort, im WS-Handler
  `terminate()` als letzte Linie). Kein Contract-Typ betroffen.
- **Folgen:** Neue Routen (z. B. `/api/file`) sind ohne Änderung am Guard geschützt; die
  Static-Route ist `STATIC_ROUTE = '/*'` (Default-Prefix von `@fastify/static`). Regressionstests
  über rohe Sockets (kodiert, doppelt kodiert, Absolute-Form, Groß-/Kleinschreibung, Trailing
  Slash, `..`, `;`, HEAD) für HTTP, Blob und WS, mit und ohne Web-UI.

## ADR-019 – WS-Upgrade: `Sec-Fetch-Site` nur prüfen, wenn vorhanden
- **Datum/WP:** 15.10.2026, R1-Fixes Server (V1-01, BLOCKER; Entscheidung des Koordinators)
- **Kontext:** Chrome/Edge senden beim WebSocket-Handshake kein `Sec-Fetch-Site` (bei `fetch`
  schon). Die Contract-Zeile verlangte `same-origin` – jeder echte Browser bekam 403, die App
  verband nie. Die Integrationstests sahen es nicht, weil `connectWs` den Header immer mitschickte.
- **Entscheidung:** Für den WS-Upgrade sind passender `Origin` (∈ `allowedOrigins`), `Host` und ein
  gültiges Geräte-Cookie Pflicht; `Sec-Fetch-Site` wird nur geprüft, wenn vorhanden, und muss dann
  `same-origin` sein (`cross-site`, `same-site`, `none` → 403). Für Nicht-GET-HTTP-Requests bleibt
  `Sec-Fetch-Site: same-origin` Pflicht. Der Test-Client `connectWs` sendet standardmäßig kein
  `Sec-Fetch-Site` mehr (wie Edge/Chrome).
- **Folgen:** Browser senden beim Handshake immer `Origin`; fremde Seiten (auch andere Ports auf
  127.0.0.1, „same-site“) scheitern an der Origin-Prüfung, Nicht-Browser am Cookie. architecture §5,
  §5.1, Diagramme (a)/(h) angepasst. Der Vite-Proxy (Dev) reicht die Header nur durch – unverändert.

## ADR-020 – Store-Datei mit neuerer `schemaVersion`: Start-Abbruch, Datei bleibt unverändert
- **Datum/WP:** 15.10.2026, R1-Fixes Server (R1-06; Entscheidung des Koordinators)
- **Kontext:** Eine neuere `schemaVersion` (neuerer Build auf demselben `PARALLAX_HOME`, z. B. ein
  zweiter Checkout) landete in der Quarantäne, danach auch die `.bak`, und es wurden Defaults
  geschrieben – ein Downgrade leerte `sessions.json` ohne Rückweg.
- **Entscheidung:** `JsonStore.load()` verwirft bei neuerer Version (Hauptdatei oder `.bak`) mit
  `StoreVersionTooNewError` (neuer Fehlercode `STORE_VERSION_TOO_NEW {file, version, supported}`,
  englische Meldung „… update Parallax. The file was left unchanged …“). Die Datei wird weder
  verschoben noch migriert noch überschrieben; der Store bleibt gesperrt (`get`/`set` werfen,
  `flush` schreibt nichts), und es wird grundsätzlich erst geschrieben, nachdem die Datei gelesen
  wurde (auch nach einem `set()` vor `load()`). Gilt für alle JsonStores (`sessions.json`,
  `settings.json`, `auth-secret.json`, `decisions.json`, künftig `processes.json`). Der Server
  bricht den Start ab (WP-20: Meldung auf stderr + Log, Exit-Code
  `STORE_VERSION_TOO_NEW_EXIT_CODE` = 3). Korrupte Dateien bleiben bei Quarantäne.
- **Folgen:** Kein Nur-Lese-Betrieb (einfacher, kein halber Zustand); der Launcher (WP-21) kann
  Exit-Code 3 als „Parallax aktualisieren“ anzeigen. Die WP-14-Übersetzung des Codes kam im selben
  Schritt (errors.en/de.ts, siehe R1.md „Umsetzung Server“).

## ADR-021 – `buildEnv`: persistente Umgebungsvariablen (Nexus) und Session-Marker
- **Datum/WP:** 15.10.2026, R1-Fixes Server (R1-03, R1-09; Entscheidung des Koordinators)
- **Kontext:** C.2 entfernt `npm_*`/`PNPM_*`/`NODE_OPTIONS` pauschal (Laufzustand von `pnpm run`) –
  das traf auch rechnerweit gesetzte Variablen wie `NPM_CONFIG_REGISTRY` (Firmen-Nexus) in den
  Sessions. Zugleich ließ die Liste `AI_AGENT` (`claude-code_<version>_agent`) der aufrufenden
  Claude-Session durch.
- **Entscheidung:** Drei Klassen (`envRemovalReason`): `session` – `CLAUDECODE`, `CLAUDE_CODE_*`
  (außer Allowlist), `CLAUDE_AGENT_SDK_*`, `CLAUDE_PID`, `CLAUDE_EFFORT`, `AI_AGENT`,
  `CLAUDE_PROJECT_DIR`, `CLAUDE_ENV_FILE`, `CLAUDE_PLUGIN_ROOT`, `CLAUDE_PLUGIN_DATA`, geerbte
  `PARALLAX`/`PARALLAX_ENTRY_ID`; `run_state` – `INIT_CWD`, `npm_lifecycle_*`, `npm_package_*`,
  `npm_execpath`, `npm_node_execpath`, `npm_command`, `npm_config_user_agent`, `npm_config_node_gyp`,
  `PNPM_SCRIPT_SRC_DIR`, `PNPM_PACKAGE_NAME`, `pnpm_config_verify_deps_before_run` (beobachtet mit
  pnpm 12.8); `machine_overridable` – übrige `NPM_*`/`PNPM_*`, `NODE_OPTIONS`, `NODE_ENV`. Nur die
  letzte Klasse bleibt erhalten, wenn derselbe Name dauerhaft in `HKCU\Environment` oder
  `HKLM\SYSTEM\CurrentControlSet\Control\Session Manager\Environment` steht **und** der Wert exakt
  dem Prozess-Env entspricht (REG_EXPAND_SZ expandiert). `session`/`run_state` werden immer entfernt,
  auch wenn sie persistent gesetzt wären. Registry-Lesen: `reg.exe query` per System32-Pfad ohne
  Shell (`lib/registry.ts readPersistentEnvironment`), einmal je `ClaudeIntegration` gecacht,
  Fehler → keine Ausnahme (fail closed), injizierbar (`persistentEnv`). Zusätzlich Option
  `target: 'terminal'` (Phase 2): stammt das Basis-Env aus einer Claude-Session, werden deren
  Tool-Shell-Variablen (`GIT_EDITOR`, `GIT_TERMINAL_PROMPT`, `GIT_ASKPASS`, `GCM_INTERACTIVE`,
  `COREPACK_ENABLE_AUTO_PIN`, `NO_COLOR`, `PYTHONIOENCODING`, `PSExecutionPolicyPreference`) mit
  derselben Persistenz-Ausnahme entfernt; `NoDefaultCurrentDirectoryInExePath` bleibt.
- **Folgen:** Kein Profil-Workaround `${env:NPM_CONFIG_REGISTRY}` mehr nötig; `buildEnvReport`
  meldet `keptPersistent`. Werte landen nie im Repo/Log (Tests mit Platzhaltern). OEM-Codepage der
  `reg.exe`-Ausgabe kann Nicht-ASCII-Werte verfälschen → kein Treffer (fail closed).

## ADR-022 – Spawns nur mit absolutem `.exe`-Pfad
- **Datum/WP:** 15.10.2026, R1-Fixes Server (R1-04)
- **Kontext:** libuv sucht einen Programmnamen ohne Pfad zuerst im `cwd` des Kindes (außer
  `NoDefaultCurrentDirectoryInExePath` steht im übergebenen Env). Ein geklontes Repo mit `git.exe`
  im Wurzelordner würde beim Git-Branch-Abruf (WP-13) oder „Im Explorer zeigen“ (WP-21) ausgeführt.
- **Entscheidung:** `assertSpawnableFile` (in `runFile`, `spawnHidden`, taskkill-Pfad) verlangt
  einen absoluten, sicheren Windows-Pfad (`@shared/paths`) mit Endung `.exe` – nackte Namen,
  relative/Laufwerks-relative, UNC-, Device- und ADS-Pfade sowie `.cmd`/`.bat`/`.ps1`/`.com` werfen
  `TypeError`. Aufrufer lösen Namen mit `resolveExecutable(name, env)` (lib/windows.ts, PATH ohne
  cwd, npm-Shims) oder `systemTool(name)` (System32) auf. Der Recorder nutzt `runFile` mit
  System32-Pfaden.
- **Folgen:** WP-13 (Git-Branch je Turn) und WP-21 (Edge, Explorer) müssen vorab auflösen; Hinweis
  in R1.md „Umsetzung Server“.

## ADR-023 – Bind-Adresse fest `127.0.0.1`
- **Datum/WP:** 15.10.2026, R1-Fixes Server (R1-05)
- **Kontext:** `--host`/`PARALLAX_HOST` erlaubten jede IP (`0.0.0.0` öffnete den Server ins Netz;
  ein Nicht-Browser setzt `Host` beliebig). Andere Loopback-Adressen sind mit `allowedHosts` ohnehin
  unbenutzbar. Plan „Sicherheit“/A.8: nur `127.0.0.1`.
- **Entscheidung:** `loadConfig` akzeptiert Flag und Env weiter (ADR-006), lehnt aber jeden Wert
  außer `127.0.0.1` mit `ConfigError` ab; `ServerConfig.host` ist der Literal-Typ `'127.0.0.1'`.
- **Folgen:** WP-20 übergibt `config.host` an `listen`; der WP-00-Stub `main.ts` wird dabei ersetzt.

## ADR-024 – Windows-Helfer in `src/server/lib/` (PATH-Suche, npm-Shims, Registry, Edge)
- **Datum/WP:** 15.10.2026, R1-Fixes Server (R1-08; Freigabe des Koordinators, erweitert)
- **Kontext:** `searchPath`, `resolveCmdShim` (claude/resolveClaude.ts) und `findEdge`,
  `regQuery`, `parseRegDefaultValue` (claude/preflight.ts) sind generisch; WP-21 darf `claude/`
  nicht ändern, R1-04 braucht die PATH-Suche im Prozess-Kontext.
- **Entscheidung:** Verschiebung ohne Logikänderung nach `lib/windows.ts` (`FsProbe`,
  `nodeFsProbe`, `createMemoryFs`, `getEnvVar`, `searchPath`, `resolveCmdShim`, neu
  `resolveExecutable`), `lib/registry.ts` (`regQuery`, `regKeyQuery`, `parseRegDefaultValue`,
  `parseRegValues`, `readPersistentEnvironment`) und `lib/edge.ts` (`findEdge`); Owner WP-11.
  `RunFileFn` liegt in `lib/process.ts`. `claude/*` importiert von dort, keine Alias-Exporte.
- **Folgen:** `ClaudeFsDeps`/`nodeFsDeps` heißen jetzt `FsProbe`/`nodeFsProbe`; architecture §2.1,
  §2.2 und `lib/README.md` ergänzt.

## ADR-025 – Auto-Retry nur nach Absturz im Leerlauf
- **Datum/WP:** 15.10.2026, R1-Fixes Server (Koordinator-Entscheidung zu WP-13 §3.5.12/§7)
- **Kontext:** A.10 „Auto-Retry nur aus idle“ ließ offen, ob ein im Leerlauf abgestürzter Prozess
  neu gestartet oder bis zum nächsten Prompt ruhend gelassen wird.
- **Entscheidung:** Auto-Retry **nur** nach einem Absturz im Leerlauf (`expected: false`, Code
  `CLAUDE_PROCESS_CRASHED`, vorher `runState idle`, leere Queue, keine offene Entscheidung):
  Neustart wie `session.resume` ohne Prompt, höchstens 3 in Folge, Backoff 2 s / 10 s / 30 s, Zähler
  zurück nach erfolgreichem Turn oder 5 min Laufzeit; Nutzerbefehle, die starten oder schließen,
  brechen den Timer ab. Absturz während der Arbeit oder mit offener Entscheidung → `error` + „Neu
  starten“, nie automatisch (keine Wiederholung von Seiteneffekten). Festgehalten in architecture §9.
- **Folgen:** WP-13b setzt `retry.ts` so um (Design §3.5.12); `options.autoRetry: false` bleibt als
  Schalter.

## ADR-026 – Seiten-CSP mit `style-src 'self' 'unsafe-inline'`
- **Datum/WP:** 15.10.2026, R1-Fixes Server (R1-10, Nachtrag zu WP-10 Abweichung Nr. 2)
- **Kontext:** Radix/shadcn fügen `<style>`-Elemente ein (z. B. ScrollArea); C.10 nennt nur
  `'self'`.
- **Entscheidung:** `style-src 'self' 'unsafe-inline'` bleibt; `script-src 'self'` strikt, `img-src`,
  `font-src` (über `default-src`) und `connect-src` nur `'self'` (+ eigener WS) – injiziertes CSS kann
  nichts nach außen leiten. Restrisiko: CSS-Injection für UI-Redressing.
- **Folgen:** Später enger (`style-src-elem 'self' 'sha256-…'`, `style-src-attr 'unsafe-inline'`),
  sobald WP-15/16 die tatsächlich injizierten Styles kennen; `require-trusted-types-for 'script'`
  prüfen (Follow-up).

## ADR-030 – Watcher-Ignores an der Wurzel verankert, Dev-Port je Worktree per Env
- **Datum/WP:** 15.10.2026, R1-Fixes Web (R1W-01, R1W-23)
- **Kontext:** Vite und Vitest geben `server.watch.ignored` an chokidar, das **absolute** Pfade
  prüft. Das relative Muster `**/.worktrees/**` traf in einem Checkout unter `.worktrees/<wp>`
  jede Datei: kein HMR, `vitest watch` reagierte nicht – genau dort arbeiten WP-15/16. Außerdem
  belegten alle Worktrees denselben festen Port 5173 (`strictPort`).
- **Entscheidung:** `repo.config.ts` liefert `watchIgnores(repoRoot)` – Matcher-Funktionen
  (`insideDir`, `path.relative`, unter Windows case-insensitiv) für `.worktrees`,
  `.claude/worktrees`, `dist`, `.tsbuild`, `coverage` **dieses** Checkouts; `vite.config.ts` und
  `vitest.config.ts` nutzen sie. `worktreeGlobs` bleibt nur für Vitest `test.exclude`
  (wurzelrelativ). ESLint-`globalIgnores`, tsconfig-`exclude` und `tsx watch --exclude` sind relativ
  zur Config bzw. `cwd` und blieben unverändert. Der Vite-Port kommt aus `devWebPort()`:
  `PARALLAX_DEV_WEB_PORT` (zod-geprüft, 1024–65535), sonst `DEV_WEB_PORT` aus dem neuen,
  importfreien `src/shared/devPorts.ts` (von `@shared/http` re-exportiert – keine Warnungen des
  Vite-Config-Loaders mehr).
- **Folgen:** HMR und `vitest watch` funktionieren in jedem Worktree (manuell geprüft). Ein
  abweichender Port taugt nur für den Playground: der Dev-Server erlaubt mit `--dev` nur die Origin
  `127.0.0.1:5173` (`allowedOrigins`); `pnpm dev` mit Server läuft weiter auf 5173/4712.

## ADR-031 – `DecisionCard`: eine bedienbare Instanz in der Leiste, Endzustand im Transkript
- **Datum/WP:** 15.10.2026, R1-Fixes Web (R1W-03, Koordinator-Entscheidung Variante A)
- **Kontext:** WP-15 rendert die Plan-Karte über den Slot im Transkript, WP-16 dieselbe offene
  Entscheidung in der Leiste. Offen war, wer nach `decision.resolved` rendert (die Karte bekommt
  `null`), ob zwei bedienbare Kopien entstehen und wie abgelaufene Pläne aussehen.
- **Entscheidung:** Variante A (architecture §2.3e): `DecisionCard` rendert offene und abgelaufene
  Entscheidungen und gibt nach der Auflösung `null` zurück. `placement: 'bar'` ist die einzige
  bedienbare Instanz; `placement: 'transcript'` zeigt Plantext, Status und „Zur Entscheidung“, das
  `focusDecision(sessionKey, decisionId)` (`src/web/shell/decision-focus.ts`) aufruft – die Leiste
  registriert dafür `useDecisionFocusHandler`, sonst fokussiert der Helfer die Karte bzw. die
  Leistenregion `[data-decision-bar]` des Panes. Den Endzustand zeichnet WP-15 aus
  `tool_call.decision.outcome` und `tool_call.input`. Kein zusätzliches Slot-Prop.
- **Folgen:** Keine doppelten Kürzel/Fokus-Konflikte; WP-16 liefert keine „aufgelöst“-Darstellung.
  Der FakeHost schreibt das Outcome bei `decision.respond` in den `tool_call` (Demos zeigen den
  Endzustand).

## ADR-032 – Abgeleitete Session-Selektoren statt Store-Form, Render-Isolation in der Shell
- **Datum/WP:** 15.10.2026, R1-Fixes Web (R1W-02, R1W-04, R1W-05, R1W-10)
- **Kontext:** `useSessionView`/`useSessionState` ändern sich mit jedem Delta-Frame; für die
  gruppierte, virtualisierte Liste (Subagent-Items unter der Agent-Karte) und Meta wie `hasEarlier`
  gab es keinen stabilen Hook, und `SessionPane`/Sidebar renderten bei jedem Delta bzw. jeder
  Summary alle Slots/Zeilen neu.
- **Entscheidung:** Hooks `useSessionSelector(key, select, fallback)` und
  `useSummarySelector(key, select, fallback)` (shallow verglichen), `useSessionMeta(key)`,
  `useTopLevelItemIds(key)`/`useChildItemIds(key, toolUseId)` über `selectItemTree` (je
  `view.items` per WeakMap gecacht; Items ohne geladenen Eltern-Tool-Call stehen oben).
  `SessionPane` liest nur Titel + Meta und rendert die Slots über `memo`-Wrapper, `SessionHeader`
  liest seine Summary selbst, Sidebar-Zeilen bekommen primitive Props. `useNowUntil` rendert nur
  noch an Deadlines.
- **Folgen:** Features koppeln sich nie an `state.sessions[key].view`; WP-14 kann die Store-Form
  ändern. Render-Zähler-Tests sichern die Isolation (`shell/render-isolation.test.tsx`).

## ADR-033 – Lokale Hinweise über `state/notices.ts`
- **Datum/WP:** 15.10.2026, R1-Fixes Web (R1W-07, R1W-19)
- **Kontext:** WP-15/16 brauchen kurzlebige Hinweise (Kopieren, Prompt nicht gesendet,
  `DECISION_ALREADY_RESOLVED` aus einem anderen Fenster); ohne API baut jedes Feature eine eigene
  Live-Region. `SettingsMenu` verschluckte Speicherfehler.
- **Entscheidung:** `showNotice({ text, params? } | { error }, { tone?, sessionKey?, durationMs?,
  id? })` (+ `showTextNotice`, `showErrorNotice`, `dismissNotice`, `useNotices`) im Client-Store
  (`ClientState.notices`, max. 5, gleiche `id` ersetzt). Anzeige in der dauerhaft gemounteten Region
  des `NotificationCenter` neben den Server-`notify`; Übersetzung beim Rendern; Fehler
  `role="alert"`. Timer der In-App-Benachrichtigungen werden beim Unmount gelöscht.
- **Folgen:** Eine Hinweisregion je Fenster; die spätere Benachrichtigungs-Arbeit (Phase 2) baut
  darauf auf. Feature-Demos ohne `AppShell` binden `NotificationCenter` selbst ein.

## ADR-034 – Importgrenzen der Features und von `src/shared` per ESLint
- **Datum/WP:** 15.10.2026, R1-Fixes Web (R1W-08, R0-22)
- **Kontext:** „Features importieren einander nie“, „Radix nur in `src/web/ui`“, „nur `state/*`
  schreibt den Store“ waren Konvention; WP-15 und WP-16 laufen parallel. `import fs from 'fs'` in
  `src/shared` meldete nur einen Folgefehler mit falscher Meldung.
- **Entscheidung:** `no-restricted-imports`-Blöcke je Bereich (spätere Blöcke ersetzen die Optionen,
  daher wiederholen sie die Basis-Muster): Feature-Grenze transcript ↔ decisions/composer, keine
  Feature-Importe in shell/state/lib/ui/playground, in i18n nur `features/<f>/i18n/{en,de}`, Radix
  nur in `ui/`, keine Store-Schreiber in Feature-Code (Tests ausgenommen), Node-Builtins mit und
  ohne `node:` in Web und Shared mit eigenen Meldungen.
- **Folgen:** Querimporte fallen beim Lint auf, nicht erst in R2. `App.tsx`/`main.tsx` bleiben frei
  (WP-20 verdrahtet dort). Relative Pfade wie `../decisions` aus einem Unterordner namens
  `decisions` innerhalb von `features/transcript` würden fälschlich gemeldet – dort `./…` nutzen.

## ADR-035 – Bundle: Start-Chunks, Lazy-Regel, Fonts als Dateien, zod ohne JIT
- **Datum/WP:** 15.10.2026, R1-Fixes Web (R1W-09, V1-02, V1-09, V1-06)
- **Kontext:** Ein Chunk mit 569 kB (Warnung), WP-15 bringt Markdown/Shiki/Diff. Vite inlinte die
  kleinste Font-Untermenge als `data:`-URI (CSP `default-src 'self'` blockiert sie); zod 4 prüft per
  `new Function('')`, ob JIT erlaubt ist (CSP-Verletzung bei jedem Start); `/favicon.ico` fehlte.
- **Entscheidung:** `rolldownOptions.output.codeSplitting.groups` `react` (react, react-dom,
  scheduler) und `vendor` (übriges `node_modules`), beide nur `tags: ['$initial']` – dynamische
  Importe behalten eigene Chunks; Warnschwelle bleibt 500 kB. `build.assetsInlineLimit: 0`.
  `src/web/lib/zod-jitless.ts` (`z.config({ jitless: true })`) als erster Import in `main.tsx`
  (zod entscheidet beim Erzeugen eines Objekt-Schemas). Lokales `public/favicon.svg`.
- **Folgen:** Start-Bundle `index` ≈ 121 kB, `react` ≈ 219 kB, `vendor` ≈ 236 kB, keine
  Chunk-Warnung; Build-Konsole ohne CSP-Meldung (geprüft mit der Seiten-CSP). WP-15 lädt
  Markdown/Shiki (JS-Regex-Engine)/Diff per `import()`.

## ADR-036 – Build-ID nur aus Build-Eingaben
- **Datum/WP:** 15.10.2026, R1-Fixes Web (V1-14; ergänzt ADR-013)
- **Kontext:** `resolveBuildId()` wertete `git status`/`git diff` des ganzen Baums aus; eine
  unversionierte Doku-Datei machte die Build-ID „dirty“ und erzwang Reloads ohne Code-Änderung.
- **Entscheidung:** Status und Diff nur über `BUILD_INPUT_PATHSPECS` (`src`, `scripts`,
  `package.json`, `pnpm-lock.yaml`, `pnpm-workspace.yaml`, `*.config.ts`, `tsconfig*.json`).
- **Folgen:** Doku-Änderungen ändern die Build-ID nicht mehr; neue Build-Eingaben außerhalb dieser
  Pfade müssen in die Liste aufgenommen werden.

## ADR-040 – Composer: Ziel-Sperre für Enter bei offener Entscheidung
- **Datum/WP:** 15.10.2026, R2-Fixes Web (R2W-01, Koordinator-Entscheidung Variante B)
- **Kontext:** Enter im Composer beantwortete die gerade angezeigte offene Entscheidung – auch eine,
  die erst während des Tippens erschien (auch von Subagenten): nie eine Freigabe, aber eine
  ungewollte Ablehnung bzw. Plan-Überarbeitung mit dem Text der eigentlich nächsten Anweisung.
- **Entscheidung:** Das Enter-Ziel wird beim ersten Zeichen des Entwurfs fixiert (`'' → nicht
  leer`): nur die Entscheidung, die die Leiste dann zeigt, sofern sie vom Haupt-Agent stammt und
  mindestens `ARM_DELAY_MS` (600 ms, wie die Karten) angezeigt war. „Weiter planen“ in der Leiste
  setzt das Ziel explizit (`requestComposerFocus(sessionKey, decisionId)`). Ohne passendes Ziel
  (Entscheidung erschien beim Tippen, anderes Ziel gewählt, Subagent, aus localStorage
  wiederhergestellter Entwurf) sendet Enter normal (`next`); die Hinweiszeile sagt das, „Als
  Antwort senden“ bzw. „Weiter planen mit Feedback“ ist dann ein expliziter Knopf links der
  Sende-Knöpfe (verschiebt sie nicht; ebenfalls mit Arm-Verzögerung). Ein leeres Feld zeigt die
  Antwort-Darstellung für Haupt-Agent-Entscheidungen, weil das erste Zeichen sie fixieren wird.
  Schlägt eine Antwort fehl, kommen Text und Ziel zurück.
- **Folgen:** Kein Zielwechsel unter den Händen des Nutzers; ein `next`-Prompt wartet dann hinter
  der Entscheidung (gewollt, der Nutzer schrieb eine Anweisung). Tests mit Gegenprobe in
  `composer/Composer.test.tsx`. Das Ziel lebt im Composer (Remount = kein Ziel).

## ADR-041 – Warteschlange nur im Transkript und als Zähler in der Kopfzeile
- **Datum/WP:** 15.10.2026, R2-Fixes Web (R2W-04, Koordinator-Entscheidung)
- **Kontext:** Eingereihte Prompts erschienen dreifach: graue Zeilen im Transkript (WP-15), Liste
  im Composer (WP-16), Badge „n eingereiht“ im Kopf (WP-14).
- **Entscheidung:** Kanonisch ist das Transkript (Plan „Chat-Ansicht“: grau, bis verarbeitet),
  dazu das Kopfzeilen-Badge mit Anzahl. Die Composer-Liste (`QueueList`) entfällt ohne Ersatz-Chip
  (der empfohlene Chip mit „Zu neuesten“ bräuchte eine Querverbindung Composer → Transkript); die
  Zeit bis zum `ack` zeigt der Spinner am Senden-Knopf.
- **Folgen:** Keine Text-Deduplizierung `pending` ↔ `detail.queue` mehr im Composer.

## ADR-042 – Modus/Modell: Picker im Composer, Kopfzeile nur Status
- **Datum/WP:** 15.10.2026, R2-Fixes Web (R2W-03, Koordinator-Entscheidung)
- **Kontext:** Plan „Kopfleiste“ sah die Picker im Kopf vor, WP-16 baute sie in den Composer; Kopf
  und Composer zeigten beide Modus und Modell.
- **Entscheidung:** Bedienbar sind Modus-, Modell- und Kontext-Picker nur im Composer (wie die
  VS-Code-Extension, direkt am Eingabefeld). Die Kopfzeile zeigt Modell und tatsächlichen Modus als
  kompakten, nicht bedienbaren Status (Badge/Text, unverändert); ein Sprung zum Picker per Klick
  ist erlaubt, aber nicht umgesetzt.
- **Folgen:** Keine Shell-Änderung nötig; WP-20 verdrahtet nur die Slots.

## ADR-043 – Eine Quelle für Modus-Bezeichnungen: `shell.permissionMode.*`
- **Datum/WP:** 15.10.2026, R2-Fixes Web (R2W-03, Plan C.3)
- **Kontext:** Drei Varianten für dieselben Modi („Fragen“ im Kopf, „Manuell“ im Picker, „Einzeln
  freigeben“ im Umsetzen-Knopf; de „Änderungen annehmen“ neben „Edits automatisch“).
- **Entscheidung:** `shell.permissionMode.*` ist die einzige Bezeichnung: en „Manual“, „Accept
  edits“, „Plan“, „Auto“; de „Manuell“, „Edits automatisch“, „Plan“, „Auto“. ModePicker,
  Umsetzen-Knopf („Implement · Manual“) und der Endzustand im Transkript nutzen sie;
  `composer.mode.modes` und `decisions.plan.modesShort` entfallen. Die Menüeinträge des
  Umsetzen-Menüs bleiben beschreibend, beginnen aber mit dem Label („Manual – approve each change“).
- **Folgen:** Neue Modi brauchen nur einen Eintrag in `shell.permissionMode`.

## ADR-044 – WP-14-Wünsche aus WP-15/16: `Disclosure` nach `ui/`, Rest bleibt
- **Datum/WP:** 15.10.2026, R2-Fixes Web (R2W-08 … R2W-11)
- **Entscheidung:** `Disclosure` (kontrolliert/unkontrolliert, echter `<button>` mit
  `aria-expanded`, `actions` neben dem Knopf) liegt in `src/web/ui/disclosure.tsx`; das Transkript
  behält einen dünnen Wrapper mit `useExpanded`, die Permission-Karte nutzt das Primitive direkt.
  `CodeBlock`/`DiffView` bleiben im Transkript (Shiki/State-Abhängigkeiten, ein Nutzer),
  `ChoiceMenu` in `decisions`. Der virtua-Layout-Stub wird nicht global in `test/setup`
  installiert (er patcht `ResizeObserver`/`offsetParent` für alle Web-Tests); WP-20 nimmt ihn bei
  Bedarf direkt aus `@web/features/transcript/testing`. Die FakeHost-Queue bleibt zurückgestellt
  (WP-20 testet gegen den echten Server). Die Shortcut-Hilfe markiert `allowInInputs`-Kürzel mit
  „auch in Textfeldern“ und nennt die Mod+Enter-Ausnahme der Entscheidungsleiste.
- **Folgen:** Weitere Primitive-Kandidaten erst, wenn ein zweites Feature sie braucht.

## ADR-045 – Grenzen der Entscheidungs-Antworten als `LIMITS`
- **Datum/WP:** 15.10.2026, R2-Fixes Web (R2W-12, Contract-Wunsch freigegeben, additiv)
- **Kontext:** `deny.message`/`decline.message` (10 000) und `revise.feedback` (50 000) standen als
  Literale im Schema und dupliziert im Web.
- **Entscheidung:** `LIMITS.decisionMessageChars = 10_000` und `LIMITS.planFeedbackChars = 50_000`
  in `@shared/common`; die Antwort-Schemas in `model.ts` (über `decisionResponseSchema` auch
  `protocol.ts` `decision.respond`) nutzen sie – Werte unverändert, der Server-Contract war schon
  begrenzt, daher keine Verschärfung. Kommentar am Schema: `autoCompactThreshold` ist eine
  Token-Zahl. Das Web nutzt die Konstanten für `maxLength`, Validierung und den Zeichenzähler des
  Composers (ab 80 % des Limits).
- **Folgen:** `PROTOCOL_VERSION`/Schema-Versionen bleiben 1; Eintrag im Contract-Changelog macht
  der Koordinator (`docs/progress.md`).

## ADR-050 – Lockfile unter gleichzeitigem Lesen: Retry auf beiden Seiten, Leser tolerant
- **Datum/WP:** 15.10.2026, R2-Fixes Server (R2-01, Koordinator-Entscheidung)
- **Kontext:** Der Launcher liest `server.lock.json` alle 150 ms, während der neue Server die Datei
  per Temp-Datei + Rename ersetzt. Unter Windows scheitert `MoveFileEx` über eine gerade geöffnete
  Datei mit `EPERM` (Probe: 483 von 608 Renames gegen einen Leser in enger Schleife). Der
  Fake-Server des Integrationstests renamte ohne Retry und starb daran – `pnpm check` wurde
  sporadisch rot. Der Produktivcode hatte schon den Store-Retry (≈ 1,6 s).
- **Entscheidung:** Fake-Server: synchroner Retry bei `EPERM`/`EBUSY`/`EACCES` mit Backoff (10 ms …
  400 ms, bis 10 s) vor „listening“. Produktiv: `writeServerLock` mit eigenem, längerem Plan
  `LOCK_RETRY_DELAYS_MS` (Store-Default + 3 × 1 s ≈ 4,6 s) und `fs`-Naht; `readServerLock`
  wiederholt transiente Lesefehler und meldet alles Unlesbare als `missing`/`invalid`, nie als
  Ausnahme. Leser sehen nie eine halbe Datei (atomarer Rename).
- **Folgen:** Tests mit Naht (Rename-/Lese-`EPERM`, Aufgeben nach dem Plan ohne Temp-Rest) und ein
  Windows-Test mit einem zweiten Prozess, der die Datei alle 20 ms liest, während sie in Schleife
  ersetzt wird (keine zerrissenen Lesevorgänge, jedes Schreiben gelingt). Ein Leser in enger
  Schleife ohne Pause könnte den Schreiber weiter aushungern – kein realer Fall (Launcher 150 ms).

## ADR-051 – Prozessabfragen dreiwertig und gebündelt; Waisen-Start wartet sichtbar
- **Datum/WP:** 15.10.2026, R2-Fixes Server (R2-02, Koordinator-Entscheidung)
- **Kontext:** `processInfo`/`childProcesses` lieferten `null`/`[]` sowohl für „gibt es nicht“ als
  auch für Timeout, Policy-Sperre (AppLocker, Constrained Language Mode) oder unlesbare Ausgabe –
  ein laufender `claude.exe` wurde als „weg“ verbucht und sein Record gelöscht. Je Record liefen
  zwei PowerShell-Aufrufe (20 s Timeout, unter Last ≈ 23 s), und der Start eines Eintrags wartete
  unsichtbar bis ≈ 40 s.
- **Entscheidung:** `lib/process.ts` `queryProcesses({pids, parentPids})` → `{kind:'ok', processes}`
  oder `{kind:'unknown', reason: timeout|failed|output|unsupported, detail}`: **eine** CIM-Abfrage
  (`ProcessId = a OR …`, höchstens 100 Klauseln je Aufruf), `-ErrorAction Stop` + `exit 3` statt
  leerer Liste, Default-Timeout `PROCESS_QUERY_TIMEOUT_MS` 60 s; `processInfo` → `found`/`missing`/
  `unknown`, `childProcesses` dreiwertig. Waisen beim Start: `isProcessAlive` als Sofort-Vorfilter
  (tote PIDs → Record weg, keine PowerShell), die lebenden in einer Abfrage im Hintergrund;
  `unknown` und ein gescheitertes `taskkill` behalten den Record (`warn`), beim nächsten Start
  erneut. Nur Einträge mit lebendem Record warten; ihr Start setzt vorher `process_starting`
  (sichtbar „starting“), Obergrenze = Abfrage-Timeout.
- **Folgen:** Normalfall (kein Record oder Prozess tot) kostet keine PowerShell. `ProcDeps` ist
  jetzt `{isProcessAlive, queryProcesses, killProcessTree}`; der Shutdown-Sweep beendet bei
  `unknown` nichts. Ein dauerhaft gesperrtes PowerShell lässt Records liegen (klein, nur für lebende
  PIDs).

## ADR-052 – Waisen: nur der verifizierte `claude.exe`-Wurzelprozess bis nach WP-22
- **Datum/WP:** 15.10.2026, R2-Fixes Server (R2-03, Koordinator-Entscheidung; ersetzt den
  R1-Hinweis „Kinder eines toten `claude.exe` beenden“)
- **Kontext:** War der aufgezeichnete `claude.exe` tot, wurden direkte Kinder mit Start zwischen
  `recordedAt − 5 s` und dem Start dieses Servers beendet – nach oben offen bis zum Neustart; eine
  inzwischen wiederverwendete PID hätte fremde Prozessbäume treffen können.
- **Entscheidung:** Der Kinder-Pfad ist entfernt: beendet wird nur ein Prozess mit der
  aufgezeichneten PID, demselben Image (case-insensitiv) **und** derselben Startzeit (± 5 s), per
  `taskkill /T /F` (samt seinem Baum). Kein `aliveAt`-Herzschlag jetzt.
- **Folgen:** Überleben nach einem harten Abbruch nur Kinder eines toten `claude.exe` (Bash, MCP),
  bleiben sie bis zur Abnahme stehen. Follow-up nach WP-22: Herzschlag `aliveAt` je Record (Feld
  mit Default) als Obergrenze, Kinder nur mit `startedAt ≤ aliveAt + Toleranz`, gemeinsamer Helfer
  mit `launcher/shutdown.ts`.

## ADR-053 – Bereitschaft: eigenes Timeout, zweiter Versuch, sonst `error`
- **Datum/WP:** 15.10.2026, R2-Fixes Server (R2-04, Koordinator-Entscheidung)
- **Kontext:** Ein ohne Prompt gestarteter Prozess (Resume, Auto-Retry) verlässt `starting` nur
  über `supportedModels()` (Ende des `initialize`-Handshakes). Das hing am 15-s-Steuer-Timeout ohne
  zweiten Versuch; ein Kaltstart ließ die Session dauerhaft `starting`.
- **Entscheidung:** SdkBackend `SdkTimeouts.readyMs` = 60 s für `supportedModels` (auch vor den
  C.1-Flag-Settings). Die Runtime versucht es zweimal (`READY_ATTEMPTS`); scheitern beide und kam
  weder ein `session_state` noch ein Prompt, schließt die Engine den Prozess (`closeRuntime(…,
  'not_ready')`) und der Eintrag endet in `error` mit `CLAUDE_CONTROL_FAILED {method:
  'supportedModels'}` (px-Item, `lastError`, kein Auto-Retry). Kam ein Prompt bzw. Status, bestimmen
  dessen Signale den Zustand (nur Log). Ein Absturz während des Wartens behält seinen eigenen Fehler.
- **Folgen:** Nie mehr dauerhaft `starting`; „Neu starten“ ist der Ausweg. Höchstens ≈ 2 min bis
  zum Fehler – im Live-Test (WP-22) mit einem Kaltstart prüfen.

## ADR-054 – Exklusiver Home-Lock per Named Pipe (Exit 5)
- **Datum/WP:** 15.10.2026, R2-Fixes Server (R2-05, Koordinator-Entscheidung)
- **Kontext:** Zwei gleichzeitig gestartete Server (Doppelklick, zweiter `--port`, `pnpm dev:live`
  mit `--home` auf das echte Home) öffneten beide die Stores und liefen durch Recovery und
  Waisen-Bereinigung, bevor der Verlierer am `listen` scheiterte – oder liefen dauerhaft als zweiter
  Writer. Das Lockfile schützt nur den Launcher-Pfad und erst nach `listen`.
- **Entscheidung:** `src/server/lib/homeLock.ts`: `acquireHomeLock(home)` legt das Home an und
  nimmt `\\.\pipe\parallax-home-<16 hex von sha256(windowsPathKey(realpath(home)))>` per
  `net.createServer().listen` (libuv: erste Pipe-Instanz exklusiv → zweites `listen` =
  `EADDRINUSE`, auch aus anderen Prozessen/Sitzungen). Ergebnis `{kind:'acquired', lock}` oder
  `{kind:'busy', pipe}`; die Pipe verschwindet mit dem Prozess (kein Stale-Zustand), Verbindungen
  werden sofort geschlossen, der Server ist `unref()`. `busy` → Exit-Code
  `SERVER_EXIT_CODES.alreadyRunning` (5, schon vorhanden; der Launcher sucht dann den Gewinner).
  Verdrahtung vor dem ersten Store in `main.ts` macht WP-20c (Anleitung in `docs/wp/R2.md`).
- **Folgen:** Kein zweiter Writer je Home, unabhängig vom Port; Schreibweisen (Groß/klein, `/`,
  abschließendes `\`, Junctions/`subst`) ergeben denselben Schlüssel. Ohne Windows keine
  Exklusivität (`exclusive: false`, nur Tests).

## ADR-055 – `lib/async.ts` und `lib/fs.ts` statt verstreuter Kopien
- **Datum/WP:** 15.10.2026, R2-Fixes Server (R2-10, Koordinator-Zuschnitt)
- **Kontext:** `toError` dreimal plus Inline-Kopien, `realSetImmediate` in vier Modulen, eigene
  `sleep`-Kopien, eine eigene UUID-Regex im SdkBackend; `withFsRetry`/`writeFileAtomic` lagen in
  `store/jsonStore.ts` (WP-10) und wurden vom Launcher importiert.
- **Entscheidung:** `lib/async.ts` (`toError`, `sleep`, `realSetImmediate`, `nextMacrotask`),
  `lib/fs.ts` (`withFsRetry`, `isTransientFsError`, `DEFAULT_RETRY_DELAYS_MS`, `writeFileAtomic`,
  `FsOps`/`nodeFsOps`) – unverändert aus `jsonStore.ts` verschoben, dort als `StoreFs`/`nodeStoreFs`
  usw. re-exportiert (Store-Aufrufer unverändert). Alle Kopien in `backend/`, `sessions/`,
  `launcher/`, `lib/process.ts` nutzen die Module; die UUID-Prüfung nutzt `messageUuidSchema`.
- **Folgen:** Neue kleine Helfer gehören dorthin. Der gemeinsame Kinder-Kill-Helfer entfällt
  vorerst (ADR-052: kein zweiter Nutzer mehr), er kommt mit dem Herzschlag-Follow-up.

## ADR-056 – `PARALLAX_HOME`-Rechte: nur warnen
- **Datum/WP:** 15.10.2026, R2-Fixes Server (R2-13, Koordinator-Entscheidung)
- **Kontext:** Das Home enthält Launcher-Token und Cookie-Secret. Unter `%LOCALAPPDATA%` erbt es
  Nutzer-only-ACLs, mit `--home` auf einem anderen Laufwerk oft „Authentifizierte Benutzer: Ändern“;
  auf Mehrbenutzer-/RDP-Rechnern ist `127.0.0.1` aus allen Sitzungen erreichbar.
- **Entscheidung:** Keine ACL-Änderung. `lib/homeAccess.ts` `checkHomeAccess(home)` liest die DACL
  als SDDL (`Get-Acl`, Pfad nur über eine Umgebungsvariable) und die eigene SID (`whoami /user`),
  sprachunabhängig über SIDs: Allow-Einträge mit Lesezugriff für breite Benutzergruppen (Jeder,
  Authentifizierte Benutzer, Benutzer, …) oder andere Konten (`S-1-5-21-…`) → `shared`; SYSTEM,
  Administratoren, Ersteller-Besitzer, Dienste, App-Container zählen nicht. `pnpm preflight` zeigt
  `warn` mit `icacls`-Vorschlag (Home wie der Server: `--home`/`PARALLAX_HOME`/Default), der Server
  loggt beim Start `logHomeAccess` als Warnung (Verdrahtung WP-20c).
- **Folgen:** `unknown` (kein Windows, PowerShell gesperrt) ist nur `info`. Deny-Einträge werden
  ignoriert – die Warnung kann zu vorsichtig sein, nie zu nachsichtig.

## ADR-070 – Versionsanzeige: CLI je Session in der Kopfzeile, Server-Fakten im Einstellungsmenü
- **Datum/WP:** 15.10.2026, R3-Fixes Web (R3-01 BLOCKER, R3-02 UI-Teil; Plan „Claude-Auflösung →
  Versions-Hinweis“, C.7)
- **Kontext:** Die UI zeigte die `claude`-Version nirgends; WP-22 muss „angezeigte Version =
  `claude --version`“ abnehmen. Die Daten liefert der Server schon: `SessionSummary.cliVersion`
  (aus `init.claude_code_version`, persistiert in `Entry.cliVersion`), `HostState.{serverVersion,
  sdkVersion, sdkClaudeCodeVersion, dataDirLabel, backend}`, `profiles[].claude.{version, path,
  versionStatus}`.
- **Entscheidung:** (a) Kopfzeile: nicht bedienbarer Eintrag „CLI ‹version›“
  (`data-slot="header-cli-version"`, `data-version-status`), ab `xl` sichtbar; älter als
  `sdkClaudeCodeVersion` → rotes Badge, immer sichtbar, Grund im Tooltip und als `sr-only`-Text.
  Ohne `init` (nie gestartet) kein Eintrag. (b) Sidebar-Tooltip: Zeile „Claude Code ‹version›“
  (rot bei zu alt). (c) Einstellungsmenü: beschriftete Gruppe „Über diesen Server“
  (`data-slot="host-info"`, Einträge `data-info="claude|sdk|parallax|data|backend"`) – Claude Code
  des Standardprofils mit Pfad (Prüfung: „wird geprüft…“, „nicht gefunden“), SDK mit erwarteter
  CLI, Parallax-Version, Datenordner, „FakeBackend – kein echtes Claude Code“; keine Menüeinträge.
  (d) Badge „Fake“ neben dem Produktnamen bei `backend === 'fake'`. Die Versionsregel C.7 rechnet
  das Web je Session selbst (`src/web/lib/version.ts`, gleiche Semantik wie
  `server/claude/resolveClaude.ts` `cliVersionStatus`), weil der Contract nur die Host-Version
  bewertet; leere Versionen (`''` vom Normalizer ohne Feld) gelten als unbekannt.
- **Folgen:** Kein Contract-Eingriff. Wunsch an den Koordinator: `compareVersions`/
  `cliVersionStatus` nach `@shared` (eine Quelle für Server und Web). E2E-Assert „Version sichtbar“
  (R3-07 f) über die genannten `data-*`-Attribute.

## ADR-071 – Prüf-Zustand statt Setup-Warnung, solange „Profil testen“ läuft
- **Datum/WP:** 15.10.2026, R3-Fixes Web (R3-03)
- **Kontext:** Bis zum Ende der ersten Profil-Prüfung meldet der Server `claude.state: 'checking'`
  und `setupRequired: true` – das frisch geöffnete Fenster zeigte kurz die Warnung „Claude Code
  needs attention“.
- **Entscheidung:** Client-Fix: bei `claude.state === 'checking'` zeigt `SetupHint` einen neutralen
  Hinweis (Ton `info`, „Claude Code wird geprüft…“, `data-state="checking"`), unabhängig von
  `setupRequired`; danach gilt das Ergebnis der Prüfung (`required` bzw. `too-old`). Auch das
  Einstellungsmenü sagt „wird geprüft…“.
- **Folgen:** Funktioniert mit und ohne die optionale Server-Änderung (`setupRequired` erst nach der
  ersten Prüfung `true`). Playground-Szenario `shell-checking`.

## ADR-072 – Mod+Enter auf einer Option der Frage-Karte: Capture-Phase der Karte, keine Registry-Ausnahme
- **Datum/WP:** 15.10.2026, R3-Fixes Web (V2-02)
- **Kontext:** Radix ruft auf Radio-/Checkbox-Items für Enter `preventDefault()` auf (WAI-ARIA),
  auch für Strg+Enter; die Shortcut-Registry überspringt vorbelegte Ereignisse – der
  `decisions.respond`-Handler lief auf einer fokussierten Option nie.
- **Entscheidung:** `DecisionCardShell` behandelt genau diesen Fall im `onKeyDownCapture` der Karte
  (vor Radix): Mod+Enter (`matchesShortcut` mit `RESPOND_KEYS`) auf `[role=radio|checkbox]` im
  eigenen DOM der Karte (nicht in Portalen) → dieselbe Logik wie das Registry-Kürzel
  (Hauptaktion), dann `preventDefault`, damit die Registry nicht ein zweites Mal antwortet. Eine
  generelle Registry-Ausnahme für `allowInInputs`-Kürzel mit Modifier wurde verworfen: in offenen
  Radix-Menüs löst Strg+Enter den Menüpunkt aus (der `preventDefault` setzt) – die Ausnahme hätte
  dort zusätzlich geantwortet („Menüs wählen nur“).
- **Folgen:** Enter/Leertaste auf Optionen antworten weiterhin nie; Tests mit Gegenprobe in
  `QuestionCard.test.tsx`, im Browser nachgeprüft (Keydown weiter `defaultPrevented`, Antwort kommt).

## ADR-073 – „Server beenden“ aus dem veralteten Fenster über einen kurzlebigen Socket
- **Datum/WP:** 15.10.2026, R3-Fixes Web (V2-04; V2-03 bleibt beim Koordinator/WP-21)
- **Kontext:** „Parallax wurde aktualisiert“ ohne frühere Verbindung bot nur „Neu laden“; ist der
  Server der ältere Build (ein Build ersetzte `dist/` unter ihm), führt das Neuladen wieder dorthin.
  Die Verbindung ist in dieser Phase geschlossen; eine HTTP-Route zum Beenden gibt es nicht (und
  soll es nicht geben).
- **Entscheidung:** `ManagedHostConnection.shutdownServer(timeoutMs = 15 s)`: offen → normales
  `server.shutdown`; in `version-mismatch` ein eigener, kurzlebiger Socket (`createTransport()`),
  der den Handshake mit derselben `protocolVersion` macht (der Hub prüft die `buildId` des Clients
  nicht), nur `server.shutdown` sendet (keine Abos) und mit `ack` oder Close 4503 endet → Phase
  `server-stopped`. Andere Protokollversion (`PROTOCOL_VERSION_MISMATCH`), Ablehnung, Abbruch oder
  Zeitüberschreitung → `ClientCommandError`, die Ansicht bleibt bedienbar. `HostGate` zeigt „Neu
  laden“ + „Server beenden…“ mit Inline-Rückfrage (Fokus auf „Abbrechen“), bei Fehler den
  übersetzten Grund + Hinweis auf Task-Manager/`parallax.cmd`.
- **Folgen:** Kein Server-/Contract-Eingriff; funktioniert, solange die Protokollversion gleich ist
  (Build-Wechsel ohne Protokollwechsel ist der V2-03-Fall). Playground `shell-outdated`.

## ADR-074 – Shell-Modul `transcript-follow`: eigene Nachricht holt das Transkript ans Ende
- **Datum/WP:** 15.10.2026, R3-Fixes Web (V2-06)
- **Kontext:** Hochgescrollt und gesendet → Nachricht und Antwort erschienen außerhalb des
  sichtbaren Bereichs. Composer (WP-16) und Transkript (WP-15) dürfen einander nicht importieren.
- **Entscheidung:** `src/web/shell/transcript-follow.ts` nach dem Muster von `decision-focus`:
  der Composer ruft nach jedem eigenen Senden (Prompt oder Antwort per Text) `followTranscript
  (sessionKey)`, das Transkript registriert `useTranscriptFollowHandler` und klebt wieder am Ende
  (wie „Zum Neuesten“). Nachrichten aus anderen Fenstern verschieben die Ansicht nicht.
- **Folgen:** Nur Nutzeraktionen dieses Fensters; weitere Features können denselben Weg nutzen.
## ADR-060 – Edge-App-Profil: nie angemeldet, nie synchronisiert (nur Kommandozeilenschalter)
- **Datum/WP:** 15.10.2026, R3-Fixes Server (V2-01, Koordinator-Entscheidung: Datenschutz, höchste Priorität)
- **Kontext:** Ein frisches Profil `--user-data-dir=<home>\edge` meldete sich beim ersten Start
  implizit mit dem Microsoft-Konto des Windows-Nutzers an, richtete Sync ein (Verlauf, getippte URLs
  mit `#code=`, Tabs, Kennwörter) und zeigte modal „Wir synchronisieren …“ über der App.
  `--no-first-run` verhindert das nicht. Richtlinien/Registry wären global und scheiden aus.
- **Entscheidung:** `edgeAppArgs` startet Edge zusätzlich mit `--disable-sync`,
  `--allow-browser-signin=false` und `--disable-features=msImplicitSignin,msEdgeFirstSyncOnFirstRun,
  msWebUISyncConfirmationDialog,msForceBrowserSignIn,msSeamlessWebToBrowserSignIn,
  msEnableWebToBrowserSignIn,msEnableAADWebToBrowserSignIn,msQuickAuthToBrowserSignIn` (Namen aus
  `msedge.dll` 155). Gemessen (Edge 155.0.4283.45, Temp-Profile, CDP `edge://signin-internals`,
  Profildateien; `docs/wp/V2.md` „Umsetzung Server“): nur `--disable-sync` → implizit angemeldet
  („Signed In, Consented for Sync“), Sync aus; `msImplicitSignin` aus → „Not Signed In“, auch beim
  zweiten Start; `--allow-browser-signin=false` und vorab geschriebene Prefs (`signin.allowed`,
  `profiles.edge_implicit_sign_in_enabled`) allein verhindern die implizite Anmeldung **nicht** –
  daher keine Prefs-Datei. Ein schon angemeldetes Profil (ältere Version) bekommt im Launcher einen
  Hinweis (`edgeProfileSignedIn`, nur lesend); `pnpm preflight` warnt bei Edge-Richtlinien, die das
  übersteuern können.
- **Folgen:** Kein Konto, kein Sync, kein Sync-Dialog im App-Fenster; die Seite „Profile“ bietet nur
  noch eine (nicht ausgeführte) Anmeldung an. Richtlinien gehen Schaltern vor:
  `BrowserSignin=2`, `ForceSync`, `ImplicitSignInEnabled=1`, `ConfigureOnPremisesAccountAutoSignIn`,
  `UserDataDir` und `FeatureFlagOverridesControl=0` (ignoriert `--disable-features`) – auf einem
  verwalteten Arbeitsrechner vor WP-22 prüfen (`pnpm preflight`, `edge://policy`). Ein neuer
  Edge-Feature-Name bei einem späteren Edge-Update wäre unwirksam, nicht schädlich (unbekannte
  Namen werden ignoriert) – Nachprüfung in WP-22 per `edge://signin-internals`.

## ADR-061 – FakeBackend nie auf dem echten Datenordner; Health meldet das Backend
- **Datum/WP:** 15.10.2026, R3-Fixes Server (R3-02, Koordinator-Entscheidung „hart verbieten“)
- **Kontext:** `--backend=fake` bzw. ein stehengebliebenes `PARALLAX_BACKEND=fake` startete das
  FakeBackend auf `%LOCALAPPDATA%\Parallax` (Fake-Antworten in echten Transkripten, Fake-Session-IDs,
  Fake-PIDs in `processes.json`); spätere Starts öffneten still ein Fenster zu diesem Server.
- **Entscheidung:** `loadConfig`: `backend === 'fake'` und Home gleich oder unterhalb des echten
  Datenordners → `ConfigError` (Server Exit 1, Launcher „Invalid option“, Exit 2). `GET /api/health`
  trägt additiv `backend?: 'sdk' | 'fake'` (`backendKindSchema` in `@shared/http`, optional für ältere
  Server). Der Launcher vergleicht es mit dem angeforderten Backend und bricht mit
  `backend_mismatch` (Exit 1, Hinweis `parallax --backend=<laufendes>` → „Server beenden“) ab, statt
  ein Fenster zu öffnen; ohne `backend` im Health (älterer Server) keine Prüfung.
- **Folgen:** Dev (`.parallax-dev`) und E2E (Temp-Homes) unverändert. Die Kennzeichnung „Fake“ in der
  UI liest `host.state.backend` (Web-Fixes, R3-01/R3-02).

## ADR-062 – Ein Launcher je Datenordner, ein Build je Checkout (Named-Pipe-Locks)
- **Datum/WP:** 15.10.2026, R3-Fixes Server (R3-04)
- **Kontext:** Ein Doppelklick startete zwei Launcher; der zweite gab nach einem einzigen
  `findRunningServer` mit „start Parallax again in a moment“ auf oder meldete im Port-Pfad einen
  fremden Server. Zwei Launcher verschiedener Datenordner konnten gleichzeitig denselben Checkout
  bauen.
- **Entscheidung:** `lib/homeLock.ts` verallgemeinert den Home-Lock zu `acquireDirectoryLock(kind,
  dir)` (`\\.\pipe\parallax-<kind>-<16 hex>`, gleicher Schlüssel wie der Home-Lock). Der Launcher
  nimmt `launch` je Home für seinen ganzen Lauf (belegt → „waiting for it“, Poll bis
  `lockWaitMs`, Default 25 min) und `build` je Checkout um den Build (nach dem Warten wird der Build
  erneut geprüft). Zusätzlich: Exit 5/Port belegt → `findRunningServer` bis zur Bereitschaftsfrist
  pollen; Port belegt durch einen Server **dieses** Homes → dessen Fenster.
- **Folgen:** Doppelklick = ein Server, zwei Fenster (Integrationstest mit zwei echten Launchern).
  Die Pipe verschwindet mit dem Prozess (kein Stale-Zustand). `e2e/global-setup.ts` baut ohne
  Build-Lock (Follow-up, nicht im Besitz).

## ADR-063 – Validierung ausgehender Daten explizit, Default `log` auch im Prod-Betrieb
- **Datum/WP:** 15.10.2026, R3-Fixes Server (R3-05, Koordinator-Entscheidung „dauerhaft log“)
- **Kontext:** Prod lief mit `off`: Contract-Abweichungen echter SDK-Daten verwarf erst der Client,
  still (möglicher Resync-Kreis); der Testmodus hing am generischen `NODE_ENV=test`.
- **Entscheidung:** `--validate=off|log|throw` / `PARALLAX_VALIDATE` (zod) in `loadConfig`, Default:
  Flag > Env > `throw` unter Vitest bzw. `NODE_ENV=test` (E2E) > `log`. `compose.ts` übergibt den Wert
  an Hub und Transkript-Store; der Launcher reicht ihn mit `--validate=` weiter. `log` verwirft den
  Wert (ein Op bekommt keine Seq → keine Lücke), zählt ihn (`hub.stats().invalidOutgoing`,
  `transcripts.stats().invalidLines`) und loggt mit laufender Zahl die ersten 20, dann jeden 100.
  (`shouldLogRepeated`, `lib/logger.ts`).
- **Folgen:** Ein Contract-Bruch in WP-22 erscheint als `error`-Zeile im Server-Log. Der Host-State hat
  keinen Zähler (Contract unverändert) – nur Log und Server-Statistik. `NODE_ENV=test` bleibt als
  Test-Erkennung, bis die E2E `PARALLAX_VALIDATE=throw` setzt (Follow-up).

## ADR-064 – Globale Fehler-Handler und Waisen-Ergebnisse nach dem Shutdown
- **Datum/WP:** 15.10.2026, R3-Fixes Server (R3-06)
- **Kontext:** Ein spätes Ergebnis der Waisen-Prüfung nach `stores.close()` rief `processes.remove`
  → `set()` warf → unbehandelte Rejection → Exit 1 mit Stacktrace; allgemein beendete jede
  unbehandelte Rejection/Exception den Server ohne Log-Zeile, ohne 4503, ohne Aufräumen.
- **Entscheidung:** Manager: jedes Waisen-Ergebnis mit `.catch` (Log), `shutdown()` wartet höchstens
  `orphanShutdownWaitMs` (2 s) auf die laufende Prüfung, Ergebnisse nach dem Flush werden ignoriert
  (Record bleibt, der nächste Start prüft erneut). `app/crash.ts`: `unhandledRejection`/
  `uncaughtException` → `logger.fatal` + `shutdown.stop('error', 1)`; vor dem Shutdown-Rahmen
  (Startphase) Log schließen und Exit 1; ein zweiter Fehler während des Fehler-Shutdowns → sofort
  Exit 1; während eines regulären Shutdowns nur Log.
- **Folgen:** Exit-Code 1 bedeutet jetzt auch „geordnet nach unerwartetem Fehler beendet“ (Ursache im
  pino-Log als `fatal`). `ShutdownReason 'error'` ist damit genutzt (R3-11).

## ADR-065 – Build-ID aus dem letzten Commit der Build-Eingaben (ergänzt ADR-013/ADR-036)
- **Datum/WP:** 15.10.2026, R3-Fixes Server (R3-13, V2-03)
- **Kontext:** `<version>+<HEAD-Hash>`: jeder Doku-Commit änderte die Build-ID → Neubau durch Launcher
  und `pnpm e2e`, laufende Server galten als „older build“.
- **Entscheidung:** `resolveBuildId` nimmt `git log -1 --format=%H -- <BUILD_INPUT_PATHSPECS>` (auf
  12 Zeichen gekürzt; ohne Treffer HEAD, ohne git `nogit`), weiter mit `.dirty-<Digest>` für
  uncommittete Build-Eingaben. Die Pfadliste schließt jetzt `**/*.md` (auch READMEs in `src/`),
  `**/*.test.ts(x)` und `**/__snapshots__/**` aus. Gits Standard-History-Simplification sorgt dafür,
  dass die Build-Eingaben dieses Commits denen von HEAD gleichen (auch nach Merges).
- **Folgen:** Doku-, Fortschritts- und Test-Commits erzwingen keinen Neubau mehr (Test mit
  Temp-Repo in `repo.config.test.ts`). Gleicher Inhalt auf zwei Zweigen kann verschiedene IDs haben
  (nur ein überflüssiger Neubau). `resolveBuildId(repoRoot, env?)` nimmt die Env als Parameter.

## ADR-066 – Der Server liefert eine beim Start fixierte UI-Kopie aus; Web-Build trägt seine ID
- **Datum/WP:** 15.10.2026, R3-Fixes Server (V2-03, Koordinator: robusteste Lösung laut V2.md)
- **Kontext:** `pnpm build`, `pnpm e2e` oder der Launcher eines anderen Datenordners bauten `dist/`
  unter einem laufenden Server neu; dessen neue/neu geladene Fenster hingen dann dauerhaft in
  „Parallax wurde aktualisiert“ (V2-04), und offene Dateien konnten `vite build` stören. Ein
  „Build verweigert sich, solange ein Server läuft“ bräuchte eine Prozess-Erkennung je `dist` mit
  Wettläufen; ein E2E-eigenes `dist` schützt nicht vor `pnpm build` und dem Launcher.
- **Entscheidung:** Vite schreibt `dist/web/build.json` (`{"buildId"}`, gleiche ID wie
  `dist/server.js`). `app/webSnapshot.ts`: Beim Start kopiert der Server `dist/web` nach
  `PARALLAX_HOME/ui/<buildId>` (Temp-Ordner + Rename, Wiederverwendung je Build, ältere Kopien
  gelöscht – der Home-Lock schließt Wettläufe aus) und liefert nur noch daraus aus. Passt die ID von
  `build.json` nicht (halber/fremder Build) oder läuft ein unbundled `dev`-Build, wird `dist/web`
  direkt ausgeliefert (Warnung). `checkBuild` verlangt jetzt `build.json` mit derselben ID wie der
  Server-Bundle (halber Build → `stale`).
- **Folgen:** Ein laufender Server ist von späteren Builds unabhängig; der Launcher-Hinweis „older
  build“ bleibt der Weg zum Update. Kosten: einmal ≈ 8 MiB kopieren je Build und Datenordner (E2E:
  je Server). Die erste Prüfung nach dem Update baut einmal neu (alte Builds ohne `build.json`).

## ADR-067 – CSP-Direktiven zentral in `@shared/http`
- **Datum/WP:** 15.10.2026, R3-Fixes Server (R3-14, Contract-Wunsch aus R1W-23, additiv)
- **Kontext:** Die Seiten-CSP lebte nur in `src/server/http/app.ts`; ein Dev-Server konnte sie nicht
  ohne Kopie übernehmen.
- **Entscheidung:** `@shared/http` exportiert `pageCspDirectives(port)`, `BLOB_CSP_DIRECTIVES`,
  `cspHeaderValue`, `pageCsp(port)` und `BLOB_CSP` (Werte unverändert, ADR-026); der Server nutzt sie.
- **Folgen:** Die Vite-Dev-CSP (`server.headers` + `html.cspNonce`, R1W-23 „optional“) bleibt ein
  Folgeauftrag für `vite.config.ts` (Nonce + HMR-WebSocket `ws://127.0.0.1:5173` ergänzen);
  bis dahin README: `pnpm dev:live` nur in einem eigenen Edge-Profil.

## ADR-080 – Kein eigener Permission-Modus für neue Sessions (Plan C.3 bewusst beibehalten nach WP-22)
- **Datum/WP:** 16.10.2026, WP-22-Fixes (WP22-04, Nutzer-Entscheidung)
- **Kontext:** In der Live-Abnahme wechselte der Default der CLI 2.1.300 für dasselbe Konto von
  `default` auf `auto` (neue **und** fortgesetzte Sessions); im Auto-Modus legte Claude eine Datei
  ohne Karte an. Vorschlag aus WP-22: das Standardprofil setzt `default` explizit.
- **Entscheidung:** Parallax setzt **keinen** eigenen Modus. Es bleibt bei C.3: ohne Wahl entscheidet
  die CLI bzw. der `defaultMode` des Nutzers (`settings.json`), bei Resume der zuletzt tatsächliche
  Modus der Session (`Entry.permissionMode`); der Nutzer kann ihn je Session im Composer vor dem
  ersten Prompt und jederzeit danach umstellen. Kein Code-Umbau.
- **Begründung:** Der Modus ist eine Einstellung des Nutzers und seines Kontos; ein von Parallax
  erzwungener Modus wiche still vom Verhalten der CLI im Terminal ab und überschriebe eine bewusste
  `defaultMode`-Wahl. Der **tatsächliche** Modus ist immer sichtbar: Kopfzeile (`header-mode`) und
  Composer-Picker folgen `init.permissionMode` und jeder `system/status`-Nachricht mit
  `permissionMode` (auch ein Wechsel durch die CLI mitten im Turn, z. B. nach der Plan-Freigabe –
  Engine-Test „permission mode set by the CLI (WP22-04)“; Picker-Test „label follows the server“).
- **Folgen:** Wer „Parallax fragt immer“ will, stellt `defaultMode` der CLI bzw. den Modus der
  Session auf „Manual“. Der Live-Smoke wählt „Manual“ vor dem ersten Prompt. Findings Punkt 2
  („ohne `permissionMode` startet die Session in `default`“) gilt nicht mehr allgemein.

## ADR-081 – Waisen: Herzschlag-Schnappschuss der Prozessbäume, exakte Verifikation (ersetzt ADR-052)
- **Datum/WP:** 16.10.2026, WP-22-Fixes (WP22-06, R2-03-Follow-up)
- **Kontext:** Nach einem harten Server-Abbruch beendet sich `claude.exe` selbst (stdin zu), seine
  Tool-Prozesse (`powershell.exe` → `PING.EXE`, ein Dev-Server …) laufen weiter; ADR-052 beendete
  nur die verifizierte Wurzel. Ein Kinder-Pfad über `ParentProcessId` allein ist gegen
  PID-Wiederverwendung nicht sicher, und Enkel eines toten Zwischenprozesses hängen an einer
  fremden ParentProcessId.
- **Entscheidung:** Herzschlag in der Engine: 10 s nach einem Spawn, danach alle 30 s
  (`processSnapshotMs`, nur solange Prozesse laufen) **eine** CIM-Prozessliste
  (`lib/process.ts` `listProcesses`) für alle Sessions; je Record die Nachkommen der `claude.exe`
  (`descendantsOf`: über alle Ebenen, ein „Kind“ älter als sein Elternprozess zählt nicht) mit PID,
  Image und **exakter** CIM-Startzeit als `children` plus `aliveAt` in `processes.json` (Felder mit
  Default, kein Versionssprung, höchstens 200 Einträge). Beim nächsten Start: Lebend-Vorfilter über
  Wurzel **und** Schnappschuss, eine gebündelte Abfrage; beendet (`taskkill /T /F`) werden die
  verifizierte Wurzel (PID + Image + Start ± 5 s, wie bisher) und jeder Prozess des Schnappschusses,
  der noch mit **genau** derselben PID, demselben Image und derselben Startzeit läuft. `unknown`
  beendet nie etwas und behält den Record, ein gescheitertes `taskkill` ebenso.
- **Folgen:** Prozesse, die nach dem letzten Schnappschuss starteten (≤ 30 s Fenster), bleiben
  unbekannt und unberührt. Kosten: eine PowerShell alle 30 s, solange Sessions laufen (≈ 1–3 s,
  ≈ 35 KB JSON bei ≈ 370 Prozessen). Live geprüft (WP-22.md „Umsetzung“): nach `taskkill` des
  Servers überlebten `powershell.exe` + `PING.EXE`, der Neustart beendete genau diese. Das
  verwaiste Lockfile erkennt der Launcher wie bisher („stale lock file“) und ersetzt es.

## ADR-082 – Benachrichtigungen: Origin im eigenen Edge-Profil erlauben, sonst nativer Windows-Toast
- **Datum/WP:** 16.10.2026, WP-22-Fixes (WP22-03, WP22-15; Plan A.9)
- **Kontext:** Edge zeigt `Notification.requestPermission()` im App-Fenster als Chip in der fehlenden
  Adressleiste – die Anfrage gilt als „ignoriert“. Zusätzlich erschien in WP-22 trotz Berechtigung
  kein sichtbarer Toast. Nachmessung (Edge 155, Temp-Profile): eine vorab in
  `Default\Preferences` geschriebene Ausnahme `profile.content_settings.exceptions.notifications
  ["http://127.0.0.1:<port>,*"] = {setting: 1}` wird akzeptiert (frisches und bestehendes Profil);
  die Web Notification erscheint dann als **Edge-eigenes Popup** (kein Windows-Toast, darum kein
  Eintrag in `wpndatabase.db`), auch bei minimiertem Fenster – bei eingeschaltetem Bildschirm.
  WP22-15 lag sehr wahrscheinlich am ausgeschalteten Bildschirm (Windows zeigt dann keine Banner,
  Edge-Popups verschwinden ungesehen).
- **Entscheidung:** (a) Der Launcher erlaubt vor jedem Öffnen eines Fensters Benachrichtigungen für
  den eigenen Origin im eigenen Profil (`grantEdgeNotifications`: zusammenführen, atomar schreiben,
  unlesbare Prefs unangetastet; keine Policy, keine Registry). (b) Der Server zeigt einen
  **nativen Windows-Toast** (`lib/toast.ts`, PowerShell 5.1 + WinRT, Skript konstant per
  `-EncodedCommand`, Titel/Text/Tag nur über Umgebungsvariablen, XML per DOM – keine Shell-, Skript-
  oder XML-Injektion), wenn kein Fenster offen ist oder das gewählte Fenster keine Web
  Notifications zeigen darf (Präsenz `systemNotifications: false`; das Fenster bekommt dann den
  In-App-Hinweis). Absender „Parallax“ über den Anzeigenamen unter
  `HKCU\Software\Classes\AppUserModelId\Parallax.App` (dokumentierter Weg für nicht paketierte
  Apps; ohne ihn behält Windows den Toast nur im Verlauf). Texte en/de nach `settings.language`,
  ein PowerShell-Aufruf nach dem anderen, `notify.clear` entfernt den Toast (`History.Remove`).
  Der erste Fehler (CLM/AppLocker, WinRT fehlt) schaltet den Kanal für den Serverlauf ab.
  `--toasts=native|off`/`PARALLAX_TOASTS`, unter Vitest/`NODE_ENV=test` aus. Contract additiv:
  `PresenceState.systemNotifications?`, `HostState.nativeNotifications` (Default `false`); das
  Banner „Benachrichtigungen aktivieren“ entfällt, solange native Toasts verfügbar sind.
- **Folgen:** Ein Klick auf den nativen Toast schließt ihn nur – das Öffnen der Session über den
  optionalen HKCU-Protokoll-Handler `parallax:` bleibt Opt-in in Phase 2 (Plan A.9). Der eine
  HKCU-Schlüssel ist die einzige Änderung außerhalb des Datenordners (README „Benachrichtigungen“).
  Windows-Einstellungen („Nicht stören“, Absender deaktiviert, Bildschirm aus) können Banner
  unterdrücken; Windows-Toasts bleiben dann im Benachrichtigungscenter.

## ADR-083 – Keine `PARALLAX_*` der Server-Umgebung in `claude`; Tests nie auf geerbtem Home
- **Datum/WP:** 16.10.2026, WP-22-Fixes (WP22-07, höchste Priorität)
- **Kontext:** `buildEnv` entfernte nur `PARALLAX`/`PARALLAX_ENTRY_ID`; `PARALLAX_HOME` (und
  `PARALLAX_PORT`, `_BACKEND`, `_VALIDATE`, `_LIVE` …) des Servers erreichten jedes Tool einer
  Session. Ein `pnpm test`/`pnpm start` in einer Parallax-Session griff damit auf das Home des
  laufenden Servers zu (`test/setup` setzte `PARALLAX_HOME` nur „falls nicht gesetzt“).
- **Entscheidung:** `buildEnv` behandelt `PARALLAX` und jedes `PARALLAX_*` als Session-Marker
  (immer entfernt, auch wenn dauerhaft gesetzt) und setzt danach nur `PARALLAX=1` und
  `PARALLAX_ENTRY_ID`; eine Profil-Variable mit `PARALLAX_*`-Namen bleibt (bewusst gesetzt).
  Defense in depth: die globalSetups von Vitest und Playwright nehmen **immer** ein frisches
  Temp-Home (`parallax-test-*` direkt im OS-Temp), Worker behalten nur dieses; jedes andere geerbte
  Home (echtes Datenverzeichnis, darin, nicht temporär, Temp-Home eines Live-Servers) wird ersetzt
  (Hinweis auf stderr). `PARALLAX_PORT` ist in Tests immer `0`, geerbte Server-Steuervariablen
  (`PARALLAX_BACKEND`, `_DEV`, `_HOST`, `_LOG_LEVEL`, `_VALIDATE`, `_TOASTS`, `PARALLAX`,
  `PARALLAX_ENTRY_ID`) werden entfernt; `PARALLAX_LIVE*`/`PARALLAX_E2E_SKIP_BUILD` bleiben (Schalter
  der Werkzeuge).
- **Folgen:** Live geprüft: das PowerShell-Tool einer Session sieht nur `PARALLAX,PARALLAX_ENTRY_ID`,
  obwohl der Server mit `PARALLAX_HOME` lief. CLAUDE.md/`test/README.md` („falls nicht gesetzt“)
  sollten nachgezogen werden (Koordinator).

## ADR-084 – „Server beenden“ < 5 s: wartende Sessions erst unterbrechen, nach 2,5 s beenden
- **Datum/WP:** 16.10.2026, WP-22-Fixes (WP22-05)
- **Kontext:** Eine Session mit offener Permission-Karte endete nach `input.end()`/`Query.close()`
  nicht (die CLI wartet auf die Antwort; die SDK bricht das `canUseTool`-Signal ab, bevor sie
  antworten kann) – erst `closeGraceMs` 5 s + `taskkill` + 1,5 s Rest = 8,0 s.
- **Entscheidung:** `manager.shutdown()`: Sessions mit offener Entscheidung bekommen vor `close()`
  ein `interrupt()` (höchstens 1 s; der eingefrorene Broker hält die Records offen → nach dem
  Neustart `expired`/`needs-resume`, A.10). Was nach `shutdownKillAfterMs` (2,5 s) noch läuft, beendet
  die Engine parallel per `taskkill /T /F` (statt auf die 5-s-Regel des Backends und den Sweep des
  Shutdown-Rahmens zu warten); die Obergrenze 15 s bleibt. Während des Shutdowns keine
  Benachrichtigungen, KI-Titel-, Context- oder Git-Abfragen. Die Schlusszeile „shutdown: done“
  nennt `totalMs` und die Dauer je Schritt.
- **Folgen:** Live: arbeitende + wartende Session → 3,7 s bis zum Prozessende (die wartende endete
  nach dem Interrupt nach 1,3 s, die arbeitende mit laufendem `ping` wurde nach 2,5 s beendet).
  Exit-Code 1 der beendeten `claude.exe` ist erwartet (nur `info`-Log).

## ADR-085 – KI-Titel: `customTitle` der SDK ist kein Beweis für einen eigenen Titel
- **Datum/WP:** 16.10.2026, WP-22-Fixes (WP22-02)
- **Kontext:** SDK 0.3.296 füllt `getSessionInfo().customTitle` mit `custom-title` ‖ Sidecar
  `custom-title.json` der CLI ‖ `aiTitle`; eine nie umbenannte Session meldet ihren KI-Titel dort.
  `aiTitleFrom` verwarf jeden Titel mit `customTitle !== null`.
- **Entscheidung:** Eigene Titel erkennt nur der Server (`titleSource 'custom'` nach `/rename`,
  `session.rename` oder Titel beim Anlegen) – die werden nie ersetzt. Kandidat ist `customTitle`
  bzw. (ältere SDKs) `summary`; ein Text gleich dem ersten Prompt bleibt ausgeschlossen. Der
  FakeHistoryStore bildet das Feldbild der SDK nach.
- **Folgen:** Live: „PARALLAX-Umgebungsvariablen in PowerShell“ (`titleSource: ai`). Ein in der
  Konsole per `/rename` gesetzter Titel einer Parallax-Session gilt als KI-Titel (darf ersetzt
  werden) – selten, unschädlich.

## ADR-086 – Modellwahl vor dem ersten Start: CLI-Aliase als Katalog
- **Datum/WP:** 16.10.2026, WP-22-Fixes (WP22-01, WP22-12)
- **Kontext:** Vor dem ersten Start eines Profils gab es keinen `supportedModels()`-Katalog; der
  Picker zeigte „Die Modellliste gibt es, solange die Session läuft“, der erste Turn lief immer mit
  dem Nutzer-Default (hier Opus/xhigh). „Default (recommended) · Opus 5.5“ stand im Picker, obwohl
  Haiku antwortete (`ANTHROPIC_MODEL`).
- **Entscheidung:** Ohne Katalog liefern Snapshot und `session.refreshModels` die CLI-Aliase
  `default`/`opus`/`sonnet`/`haiku` (`FALLBACK_MODEL_CATALOG`); `session.setModel` auf einer
  ruhenden Session gilt schon für den ersten Start. Nach dem ersten Prozess ersetzt der echte
  Katalog (je Profil im Speicher) die Aliase. Ist „Default“ gewählt, nennen Label und Zeile das
  tatsächlich gesehene Modell („Default … · claude-haiku-5-5“).
- **Folgen:** Effort-Stufen gibt es erst mit dem echten Katalog. Ein persistierter Katalog je
  Profil (über Serverneustarts) ist Phase 2.

## ADR-087 – Kleinere WP-22-Befunde: Diagnosen, Kosten, Übersetzung, Preflight, Context-Quelle
- **Datum/WP:** 16.10.2026, WP-22-Fixes (WP22-08, -09, -10, -11, -13, -14)
- **Entscheidung:**
  - WP22-08: `result.errors`-Einträge der Form `[…diagnostic] …` (z. B. `[ede_diagnostic]` nach jedem
    Stop) sind interne CLI-Diagnosen – sie fehlen im `turn_result` (keine rote Fußzeile, kein
    `unknownCounts`-Schlüssel); im CLI-Transkript bleiben sie.
  - WP22-09: `<html translate="no">` + `<meta name="google" content="notranslate">`.
  - WP22-10: `conversation.costUsd` summiert die Query-Segmente (CLI 2.1.300 beginnt
    `total_cost_usd` nach einem Resume bei 0; ein `/clear` im selben Prozess beginnt beim aktuellen
    Stand). Findings F.14 ist veraltet.
  - WP22-11: `pnpm preflight` meldet ohne relevante Richtlinie `OK edge policies none`.
  - WP22-13: Gewollt verschieden: nach Stop läuft der Prozess weiter und ist bereit → `Idle`; nach
    einem Server-Abbruch ist der Turn abgeschnitten und kein Prozess da → `Interrupted`.
  - WP22-14: Der Gauge-Dialog nennt die Quelle der Kategorien (Agent SDK; Summe wie `/context`,
    Aufteilung kann abweichen).
- **Folgen:** Kein Contract-Eingriff außer dem Kommentar zu `conversation.costUsd`.

## ADR-090 – „Server beenden“ nach C.8: 5 s je `close()`; wartende Sessions mit Arbeit in der Queue sofort beenden (ersetzt ADR-084)
- **Datum/WP:** 16.10.2026, Code-Review-Fixes (CR-02, CR-06; Koordinator-Vorgabe: Plan C.8,
  Transkript-Integrität vor Geschwindigkeit)
- **Kontext:** ADR-084 beendete jeden `claude.exe`-Baum, dessen `close()` nach 2,5 s nicht fertig
  war (SessionEnd-Hooks und Transkript-Schreiben brauchen bis 3–4 s, CR-02), und schickte jeder
  Session mit offener Entscheidung ein `interrupt()` – nach einem abgebrochenen Turn startet die
  Drain-Schleife der CLI aber sofort den nächsten gequeueten Prompt (SDK-Doku zu `still_queued`,
  CR-06). **Live-Messung dieser Fix-Runde** (CLI 2.1.300, Haiku, drei Sessions): auch `close()`
  allein hilft dort nicht – eine wartende CLI quittiert stdin-EOF mit „Tool permission request
  failed: AbortError: Tool permission stream closed“, setzt den Turn fort und beantwortete den
  bereits gefalteten Queue-Prompt (Modellaufruf 0,3 s nach dem Shutdown, Exit 0 nach 2,5 s). Ohne
  Queue endet die wartende Session nach `interrupt` + `close()` sauber („[Request interrupted by
  user for tool use]“, kein Modellaufruf, 1,1 s). Ein Abbrechen der Queue (`cancel_queued`) bietet
  `Query.interrupt()` in SDK 0.3.296 nicht an.
- **Entscheidung:** `manager.shutdown()` je Session parallel:
  - **wartet auf eine Entscheidung, Queue leer, keine Hintergrund-Tasks** (`shutdownCanEndTurn`):
    `interrupt()` (≤ 1 s), dann wie unten;
  - **wartet und hat gequeuete Prompts oder Hintergrund-Tasks:** weder `interrupt` noch `close()`
    (beides startet weitere Arbeit: Modell, Tools, neue Permission-Requests in den eingefrorenen
    Broker), sondern sofort `taskkill /T /F`. Die CLI blockiert dort auf der Antwort und schreibt
    nichts; nach dem Ende bekommt jeder nie gestartete Prompt ein px-Item `PROMPT_NOT_DELIVERED`
    (wie nach einem Absturz), der Record der Entscheidung bleibt offen (→ `expired`, A.10);
  - **sonst** `close()`, bis zu `shutdownKillAfterMs` **5 s ab diesem `close()`** auf das Ende
    warten, erst dann `taskkill /T /F` (C.8). Obergrenze des Schritts 15 s (dann `error`-Log und
    Kill der Reste). Der Sweep des Shutdown-Rahmens (`killChildProcessTrees`) läuft erst nach
    `SHUTDOWN_SWEEP_GRACE_MS` (1 + 5 + 2 = 8 s) als Rückfallebene.
- **Folgen:** „Server beenden“ mit einer arbeitenden Session dauert jetzt ≈ 5 s + Dauer des
  `taskkill` (live 6,6 s: wartende Session per Interrupt nach 1,1 s, die mit Queue-Prompt –
  damals noch per `close()` – nach 2,5 s, die arbeitende mit laufendem `ping` nach 5,0 s beendet,
  Prozessende 6,55 s, `totalMs 6597`); das WP-22-Ziel „< 5 s“ gilt für das parallele Warten. Eine
  gequeuete Nachricht einer wartenden Session wird beim Beenden nicht mehr bearbeitet, sondern als
  nicht zugestellt angezeigt. Eine arbeitende Session mit Queue kann ihren Turn in den 5 s noch
  beenden und den nächsten Prompt beginnen (C.8-Kompromiss, Kill nach 5 s). Engine-Tests mit
  virtueller Uhr: 4-s-`close()` wird nicht abgeschnitten, Kill erst bei 5 s, kein Interrupt/kein
  `close()` bei Queue bzw. Hintergrund-Task.

## ADR-091 – Native Toasts: nur deterministische Fehler schalten ab, sonst zählen und pausieren (ergänzt ADR-082)
- **Datum/WP:** 16.10.2026, Code-Review-Fixes (CR-05, CR-03)
- **Kontext:** Jeder `failed`-Toast – auch ein Timeout unter Last oder ein gescheitertes
  `History.Remove` – schaltete den Kanal für den ganzen Serverlauf ab (CR-05). `toastText` nutzte
  den Titel als Ersetzungsstring (`$&`, `$'` … wurden ausgewertet, CR-03).
- **Entscheidung:** `lib/toast.ts` liefert `failed.permanent`: das Skript prüft zuerst den
  Sprachmodus (`$ExecutionContext.SessionState.LanguageMode` ≠ `FullLanguage` → Exit 4) und meldet
  Fehler der Einrichtung (Registry, WinRT-Typen) mit Exit 4, Fehler der Aktion (`Show`,
  `History.Remove`) mit Exit 3. Dauerhaft sind: kein Windows, Exit 4, PowerShell nicht startbar
  (außer `EMFILE`/`ENFILE`/`EAGAIN`/`ENOMEM`/`EBUSY`). Nur diese schalten den Kanal ab
  (`onUnavailable`, Host-State `nativeNotifications: false`). Alle anderen werden gezählt; ab dem
  dritten in Folge pausiert der Kanal (`TOAST_BACKOFF_MS` 1 min, je weiterem Fehler verdoppelt,
  höchstens 15 min) und versucht es danach erneut; ein Erfolg setzt Zähler und Pause zurück.
  `available()` bleibt in der Pause `true`. `toastText` ersetzt `{title}` per Funktion.
- **Folgen:** Kurze Lastspitzen kosten höchstens die Toasts der Pause, nicht alle bis zum Neustart.
  Live geprüft: das geänderte Skript läuft (`removeToast` → `removed`). CLM selbst ist nur per
  Unit-Test geprüft (F6 bleibt für einen verwalteten Rechner offen).

## ADR-092 – Build-Lock im gemeinsamen Build-Weg; Checkout auf UNC-Pfad baut (ergänzt ADR-062)
- **Datum/WP:** 16.10.2026, Code-Review-Fixes (CR-08, CR-04)
- **Kontext:** Den Build-Lock (R3-04) nahm nur der Launcher; `pnpm e2e` und `pnpm build` bauten
  ohne ihn (CR-08). `acquireDirectoryLock('build', repoRoot)` warf für Pfade, die die
  Datenordner-Regeln ablehnen (UNC, …), einen `TypeError` – ein Checkout auf `\\nas\…` mit veraltetem
  `dist/` stürzte ab (CR-04).
- **Entscheidung:** `launcher/build.ts` besitzt den Lock: `acquireBuildLock(repoRoot)` (Named Pipe
  `parallax-build-<16 Hex>` wie bisher), `pollLock` (Warten mit einer Meldung, auch vom Launcher
  genutzt), `buildLockKey` – echter Pfad für Laufwerkspfade (gleicher Pipe-Name wie bisher), für
  einen von `@shared/paths` abgelehnten Pfad dessen aufgelöste Schreibweise **ohne** weiteren
  Dateizugriff (es ist der Checkout, aus dem der Prozess läuft). `lib/homeLock.ts` bekommt dafür
  `acquireKeyLock(kind, key)` (der Pipe-Teil ohne Pfadprüfung); `acquireDirectoryLock` bleibt
  streng. Nutzer: Launcher (`ensureBuild`), `e2e/global-setup.ts` (prüft und baut unter dem Lock,
  wartet auf einen laufenden Build und prüft danach neu) und `scripts/build-server.ts`
  (`pnpm build:server`). `runBuild` erwartet den Lock beim Aufrufer und setzt für seine Schritte
  `PARALLAX_BUILD_LOCK_HELD=1`, damit `build-server.ts` nicht auf den eigenen Aufrufer wartet.
- **Folgen:** Launcher und E2E-Setup bauen einen Checkout nie gleichzeitig (manuell geprüft:
  `pnpm build:server` wartete auf einen gehaltenen Lock und baute danach). **Offen:** Der
  Vite-Schritt von `pnpm build` (`build:web`) läuft weiter ohne Lock – dafür müsste
  `package.json` `build` auf ein Skript zeigen, das `runBuild` unter dem Lock ausführt (oder
  `vite.config.ts` den Lock nehmen); beides liegt außerhalb dieser Fix-Runde (Anfrage im Bericht).
  Zwei Schreibweisen desselben UNC-Checkouts teilen sich keinen Lock.

## ADR-093 – Waisen: nach dem Kill der Wurzel nichts weiter; jeder Kill nach frischer Prüfung (ergänzt ADR-081)
- **Datum/WP:** 16.10.2026, Code-Review-Fixes (CR-01, Koordinator-Vorgabe)
- **Kontext:** `checkRecord` beendete nach dem `taskkill /T` einer noch laufenden Wurzel zusätzlich
  jeden Prozess des Schnappschusses mit den Prozessinfos von **vor** diesem Kill. Die PIDs des eben
  beendeten Baums kann Windows sofort neu vergeben – ein fremder Prozess(baum) wäre hart beendet
  worden, dazu bis zu 200 unnötige `taskkill`-Starts je Record; ebenso nutzten spätere Records die
  Antwort von vor den Kills früherer Records.
- **Entscheidung:** Wurde die verifizierte Wurzel erfolgreich beendet, endet der Record dort
  (`killed`; ihr `/T` hat den Baum mitgenommen). Sonst wird jeder Prozess des Schnappschusses (und
  jede Wurzel eines späteren Records) **unmittelbar vor seinem Kill** frisch geprüft: tot →
  übersprungen (ohne PowerShell); lebt er und lief seit der letzten Antwort ein `taskkill`, dann
  eine neue gebündelte Abfrage (diese PID plus alle noch nicht geprüften, lebenden PIDs der
  Records). Beendet wird nur bei exakt gleicher PID, Image und Startzeit. Eine `unknown`-Antwort
  beendet nichts mehr und behält den Record.
- **Folgen:** Je Kill höchstens eine zusätzliche CIM-Abfrage, im Normalfall keine (nach dem Kill
  eines Elternprozesses sind seine Kinder tot). Ein Prozess, der nach einem erfolgreichen
  Wurzel-Kill außerhalb ihres Baums weiterläuft (Zwischenprozess vor dem Abbruch beendet), bleibt
  unberührt – wie Prozesse nach dem letzten Schnappschuss.

## ADR-094 – `pnpm build` vollständig unter dem Build-Lock (schließt den offenen Punkt von ADR-092)
- **Datum/WP:** 16.10.2026, Code-Review-Fix CR-08 (Koordinator-Freigabe: nur das Script `build`
  in `package.json`, keine Abhängigkeiten, Lockfile unverändert)
- **Kontext:** Nach ADR-092 lief der Vite-Schritt von `pnpm build`
  (`pnpm run build:web && pnpm run build:server`) ohne Lock; ein `pnpm build` parallel zu einem
  Launcher- oder E2E-Build konnte `dist/web` leeren, während der andere schrieb.
- **Entscheidung:** `package.json` `build` → `tsx --tsconfig tsconfig.tools.json scripts/build.ts`.
  Das Skript ruft `buildUnderLock` (`launcher/build.ts`): Build-Lock des Checkouts nehmen (belegt →
  Meldung „another build of this checkout is running - waiting for it …“, Poll wie der Launcher),
  dann `runBuild` mit genau den Schritten `build:web` + `build:server` (unverändert in
  `package.json`, vom Pin-Test geprüft), Lock danach freigeben – auch bei einem Fehler. Hält der
  Aufrufer den Lock schon (`PARALLAX_BUILD_LOCK_HELD=1`), baut es sofort. `build:web`/`build:server`
  bleiben einzeln aufrufbar (`build:server` nimmt den Lock selbst, `build:web` nicht).
- **Folgen:** Launcher, E2E-Setup und `pnpm build` bauen einen Checkout nie gleichzeitig. Nachweis:
  zwei gleichzeitige `pnpm build` – der zweite wartete, bis der erste fertig war, und baute dann;
  `dist/server.js` und `dist/web/build.json` tragen dieselbe Build-ID; Regressionstests mit
  echtem Lock (zwei `buildUnderLock` nacheinander statt verschränkt). Die Ausgabe von Vite/esbuild
  erscheint bei `pnpm build` nur noch im Fehlerfall (Schrittnamen und Build-ID immer).
  `pnpm install --frozen-lockfile` bleibt grün.

---

Phase 2 (Mission Control): Design `docs/wp/WP-30.md`. Nummern ab ADR-100 (Zehnerblöcke wie in
Phase 1; ADR-095 … 099 bleiben für Phase-1-Nachträge frei).

## ADR-100 – Phase-2-Contracts: Host-Funktionen über WS-Befehle, Protokoll v2
- **Datum/WP:** 16.10.2026, WP-30 (Phase-2-Design, Contracts v2)
- **Kontext:** Profile, Ordner-Browser und Einstellungen brauchen Server-Funktionen; der Plan nennt
  `GET/PUT /api/profiles`. Multi-Host (Backlog) verbindet ein Fenster per WS mit mehreren Hosts; HTTP
  an einen fremden Origin bräuchte CORS (verboten, A.8).
- **Entscheidung:** Alles Zustandsbezogene als `cmd`/`ack` (zod, Idempotenz, Auth wie WS); HTTP nur
  für Binärdaten (`/api/blob`, `/api/attachments`). `PROTOCOL_VERSION` 2: neue Fehlercodes, das
  System-Event `handoff` und neue Befehle sind für v1-Clients unlesbar; bei mehreren Hosts sind
  Build-IDs legitim verschieden, die Protokollversion ist der Kompatibilitätsschlüssel.
- **Folgen:** Offene Fenster laden nach dem Update einmal neu. Profil-Env-Werte gehen nur in der
  `ack` an das anfragende Fenster (der Hub loggt nur Befehlsnamen).

## ADR-101 – Host-Befehle: die Engine routet an `HostCommandHandler`
- **Datum/WP:** 16.10.2026, WP-30
- **Entscheidung:** `HOST_COMMAND_NAMES` (`@shared/protocol`: `profile.*`, `fs.listDirectory`) gehen
  nicht an Eintrags-Logik, sondern an Handler aus `SessionManagerDeps.hostCommands` (Port in
  `sync/ports.ts`); WP-32 liefert `profile.*`, WP-33 `fs.listDirectory`, WP-40 verdrahtet. Ohne Handler
  → `NOT_IMPLEMENTED`.
- **Begründung:** Parallele Pakete ohne gemeinsame Datei; die Engine bleibt der einzige Einstieg des
  Hubs.

## ADR-102 – Profil-Store: `profiles.json` mit allen Profilen, „Standard“ bearbeitbar, nie löschbar
- **Datum/WP:** 16.10.2026, WP-30
- **Entscheidung:** `PARALLAX_HOME/profiles.json` (`JsonStore`, `profilesFileSchema` v1) enthält alle
  Profile; fehlt die Datei, gilt `[STANDARD_PROFILE]` (geschrieben erst beim ersten Speichern).
  „Standard“ (`builtin`) ist voll bearbeitbar, nicht löschbar und wird ergänzt, falls er fehlt. Genau
  ein Default; Löschen des Defaults macht „Standard“ zum Default. Befunde (`ProfileIssue`) mit
  `level: 'error'` (Args gesperrt/nicht erlaubt/ungültig, ungültiger executable-/configDir-Pfad)
  verhindern Speichern, Default-Setzen und Start; Warnungen (u. a. `${env:NAME}` nicht gesetzt)
  nicht. Der Löschschutz zählt auch archivierte Einträge; die configDir-Warnung zeigt der Client
  (`entryCount > 0`).
- **Folgen:** Caches (Auflösung, Modelle) werden bei Profiländerung je Profil verworfen;
  `HostState.profiles` wird neu veröffentlicht.

## ADR-103 – Bild-Anhänge: roher Upload, inhaltsadressiert, ohne Eintragsbindung
- **Datum/WP:** 16.10.2026, WP-30
- **Entscheidung:** `POST /api/attachments` mit Rohbytes (`Content-Type` Bildtyp, keine
  Multipart-Abhängigkeit), Magic-Byte-Prüfung, ≤ 3,75 MB (`LIMITS.imageBytes`); der Client
  verkleinert vorher (lange Kante 1568 px, PNG, sonst JPEG mit sinkender Qualität). Ein Prompt darf
  jedes Bild-Blob dieses Hosts referenzieren (existiert, Bildtyp, Größe) – die Regel „nur eigene
  Uploads dieses Eintrags“ (§5.2) entfällt für Bilder: jeder Blob ist dem angemeldeten Nutzer ohnehin
  lesbar, eine Bindung schützt nichts. Datei-Anhänge mit Eintragsordner (`additionalDirectories`,
  C.11) bleiben Phase 3.
- **Folgen:** Bilder gehen als base64 in der User-Message; das Transkript zeigt die `BlobRef`s.

## ADR-104 – Externe Konsole: PowerShell `Start-Process`, Rückkehr mit Verlaufsimport
- **Datum/WP:** 16.10.2026, WP-30
- **Kontext:** Node/libuv setzt beim Spawn immer eigene Std-Handles (`STARTF_USESTDHANDLES`); ein direkt
  gestartetes `claude.exe` hätte NUL statt einer Konsole (kein TUI), `detached` heißt unter Windows
  `DETACHED_PROCESS` (gar keine Konsole). `cmd /c start` ist verboten (C.10).
- **Entscheidung:** `system/console.ts` (WP-33): `powershell.exe` (absoluter System32-Pfad, versteckt,
  ohne Shell) mit konstantem Skript per `-EncodedCommand`; Daten nur in Umgebungsvariablen
  (`PARALLAX_CONSOLE_EXE`, `_ARGS` – Kommandozeile nach CommandLineToArgvW-Regeln –, `_CWD`), die das
  Skript vor `Start-Process -PassThru` aus seiner Umgebung entfernt; die übrige Umgebung =
  `consoleLaunchFor().env`. Ausgabe PID + Startzeit. Die Engine (WP-34) schließt vorher die SDK-Query
  (nie beide gleichzeitig), setzt `external`, prüft alle 5 s den Prozess; endet er, holt sie die
  Session automatisch zurück: Verlauf per `readHistory`, Nachrichten ab `since − 5 s` normalisiert
  und angehängt, Item `handoff/returned`, Zustand `sleeping`. „Zurückholen“ löst dasselbe sofort aus
  (Fehler, solange die Konsole läuft). Ein offener Handoff überlebt einen Serverneustart.
  „Konsolenbefehl kopieren“ liefert eine PowerShell-Zeile als Rückfall.
- **Folgen:** Ein `/clear` in der Konsole beginnt dort eine neue CLI-Session, die Parallax nicht kennt
  (zurück kommt die ursprüngliche). AppLocker kann PowerShell sperren → `EXTERNAL_CONSOLE_FAILED` +
  Kopierbefehl. Live zu prüfen (WP-41).

## ADR-105 – Leerlauf-Schlaf aus den Einstellungen
- **Datum/WP:** 16.10.2026, WP-30
- **Entscheidung:** `settings.idleSleep` (Default an, 30 min, 5–1440). Schlaf nur, wenn `canSleep`
  gilt und kein fokussiertes, sichtbares Fenster die Session zeigt; die Zeit läuft ab dem Moment, ab
  dem beides gilt; Fakten-, Präsenz- und Settings-Änderungen planen neu. Schlafen =
  `closeRuntime(…, 'sleep')` → `sleeping`.
- **Folgen:** Speicher je Session (R1-15) bleibt auf die Wachzeit begrenzt.

## ADR-106 – Archiv: nur ohne Arbeit, Prozess endet, Lesemodus
- **Datum/WP:** 16.10.2026, WP-30
- **Entscheidung:** Archivieren nur ohne laufende Arbeit, offene Entscheidungen, Queue und
  Hintergrund-Tasks (sonst `SESSION_BUSY`); es schließt den Prozess, entfernt Benachrichtigungen und
  ein geplantes Fortsetzen. Archivierte Einträge sind schreibgeschützt (`SESSION_ARCHIVED`) bis
  „Wiederherstellen“. Kein endgültiges Löschen in Phase 2 (Backlog).

## ADR-107 – Frühere Unterhaltungen: Wechsel im selben Eintrag, Registry v2
- **Datum/WP:** 16.10.2026, WP-30
- **Entscheidung:** `session.switchConversation` macht eine frühere Unterhaltung wieder aktuell: die
  bisherige endet mit `switched`, die Ziel-Unterhaltung rückt ans Ende von `conversations` (die Regel
  „die letzte ist die aktuelle“ bleibt; die UI sortiert nach `startedAt`). Der nächste Prompt setzt
  deren Claude-Session fort. Sicht: `conversation.reset{hasEarlier}` + Log-Ende als `item.upsert`.
  Der neue Enum-Wert erhöht `REGISTRY_SCHEMA_VERSION` auf 2 (Migration = Identität), damit ein älterer
  Build sauber abbricht (ADR-020) statt die Datei in Quarantäne zu legen.
- **Begründung:** Entspricht `/resume` der CLI im selben Fenster; kein zweiter Eintrag mit derselben
  Claude-Session (zwei Schreiber).

## ADR-108 – Slash-Befehle: nativ im Client, sonst durchreichen; Katalog je Eintrag
- **Datum/WP:** 16.10.2026, WP-30
- **Entscheidung:** Der Composer (WP-37) behandelt `/model`, `/effort`, `/fast`, `/plan`, `/rename`,
  `/status`, `/help`, `/resume` nativ; `/clear` geht durch (die Engine kennt es). Terminal-Befehle =
  `init.terminalSlashCommands` ∪ statische Liste → Hinweis „In externer Konsole öffnen“. Alles andere
  wird als Prompt `/name args` gesendet. Die Engine ruft `supportedCommands()` bei Bereitschaft,
  schreibt `detail.commands` und cached die Liste je Eintrag (`entries/<id>/commands.json`);
  `commands_changed` (Normalizer) ersetzt sie ebenfalls (zwei Schreiber, die letzte Liste gewinnt).

## ADR-109 – Benachrichtigungen: Server filtert, Client klingt, Klick über `parallax:`
- **Datum/WP:** 16.10.2026, WP-30
- **Entscheidung:** Der Server wendet „Nicht stören“, `events[kind].toast` (false → nur In-App),
  `focusedElsewhere` und `doneMinSeconds` an (reine Funktion in `notifier.ts`). Töne spielt der Client
  per Web Audio (synthetisiert, keine Dateien, kein Netz), wenn `sound` an und nicht „Nicht stören“;
  eigene Web Notifications sind dann `silent`. Der native Toast ist stumm, wenn `sound` aus ist. Klick
  auf den nativen Toast: mit `openOnClick` registriert der Server `HKCU\Software\Classes\parallax` →
  Launcher `--open "%1"` → neues App-Fenster mit `#session=` (ein bestehendes Fenster nach vorn zu holen
  ist unter Windows nicht verlässlich). URI streng geprüft (`parseSessionProtocolUri`), Aufruf ohne
  `cmd`.
- **Folgen:** Viele Klicks → viele Fenster (akzeptiert). Live zu prüfen (WP-41).

## ADR-110 – Autostart als Verknüpfung; Systemintegration nur auf dem produktiven Server
- **Datum/WP:** 16.10.2026, WP-30
- **Entscheidung:** `Parallax.lnk` im Benutzer-Autostart, erzeugt per PowerShell/`WScript.Shell`
  (Skript konstant, Daten per Env), Ziel = `realpath(process.execPath)` (fnm/nvm-Multishell-Pfade sind
  temporär), Argumente = tsx-CLI, `--tsconfig`, `src/server/launcher/main.ts`, `--autostart`; Fenster
  minimiert. Abgleich beim Serverstart und bei jeder Änderung. Autostart und Protokoll-Handler nur,
  wenn der Server auf dem Standard-Datenordner mit SDK-Backend ohne `--dev` läuft
  (`HostState.systemIntegration`); `--system-integration=on` erzwingt es (Live-Abnahme auf einem
  Temp-Home, die registrierten Befehle tragen dann `--home=<home>`), Tests nie.
- **Folgen:** Beim Anmelden erscheint kurz ein minimiertes Konsolenfenster des Launchers.

## ADR-111 – Port aus den Einstellungen
- **Datum/WP:** 16.10.2026, WP-30
- **Entscheidung:** Rangfolge Flag > `PARALLAX_PORT` > `settings.port` > 4711; `loadConfig` liest
  `settings.json` nur lesend (ungültig/neuer → ignorieren + Hinweis im Log), damit Launcher und Server
  denselben Port wählen. Wirkung nach Neustart; `HostState.port` zeigt den tatsächlichen.

## ADR-112 – Rate-Limit: „Fortsetzen um HH:MM“ über `wakeupAt`
- **Datum/WP:** 16.10.2026, WP-30
- **Entscheidung:** `session.continueAfterLimit(true)` plant `continue` zu `rateLimitedUntil`
  (`Entry.continueAt`, Status-Event `wakeup` → `StatusFacts.wakeupAt`); fällig → ggf. Resume, Prompt
  `continue`. Ein eigener Prompt oder Archivieren löscht den Plan. Nach einem Serverneustart wird ein
  höchstens 1 h überfälliger Plan nachgeholt, ältere verworfen.

## ADR-113 – Git-Branch: Start, Turn-Ende, sichtbare Sessions alle 60 s, persistent
- **Datum/WP:** 16.10.2026, WP-30
- **Entscheidung:** Lesen beim Start/Resume, am Turn-Ende, alle 60 s für Einträge, die ein sichtbares
  Fenster zeigt (auch ruhend – nur `cwd` nötig), und bei Fokus-Wechsel; `Entry.gitBranch` persistiert.

## ADR-114 – Kataloge persistent: Modelle je Profil, Slash-Befehle je Eintrag, Abo-Limits
- **Datum/WP:** 16.10.2026, WP-30
- **Entscheidung:** `PARALLAX_HOME/model-catalogs.json`, `entries/<id>/commands.json` und
  `account-limits.json` (nur Sessions mit `apiKeySource 'none'`) – Server-interne Schemas (kein
  Contract) mit `schemaVersion`; eine neuere Version bricht den Start ab wie ADR-020.

## ADR-115 – Phase-2-Gerüst und Ownership
- **Datum/WP:** 16.10.2026, WP-30
- **Entscheidung:** WP-30 legt Contracts v2, Ports (inkl. neuem `system/ports.ts`), die Slots
  `SettingsPage`/`ProfilesSettings`, den Anfragekanal `src/web/shell/requests.ts`, i18n-Namensräume je
  Bereich (`navigation`, `newSession`, `profiles`, `preferences`) und die ESLint-Blöcke der neuen
  Features an; danach bearbeitet jedes Paket nur eigene Dateien (Tabelle in `CLAUDE.md`). Gemeinsame
  Verdrahtung (`compose.ts`, `App.tsx`) nur WP-40.

## ADR-116 – Neue Fenster per `window.open(…, 'popup,noopener')`
- **Datum/WP:** 16.10.2026, WP-30 (R3-15)
- **Entscheidung:** „In neuem Fenster öffnen“ öffnet `/#session=<entryId>` als Popup **ohne** Opener:
  das neue Fenster bekommt eine eigene `clientId` (kein doppelter Toast für Fenster-Zwillinge); das
  Cookie gilt (gleiches Profil). Live zu prüfen im Edge-App-Fenster (WP-41).

## ADR-117 – Prompt-Vorschläge: Setting (Default aus) und Ghost-Text schon in Phase 2
- **Datum/WP:** 16.10.2026, WP-30
- **Entscheidung:** `settings.promptSuggestions` (Default `false`, B: Mehrkosten je Turn) steuert die
  SDK-Option beim nächsten Prozessstart. Der Composer zeigt `detail.promptSuggestion` als Ghost-Text
  (Tab übernimmt) – aus Phase 3 vorgezogen, weil ein Schalter ohne sichtbare Wirkung verwirrt.
- **Folgen:** Die Editor-Einstellung kommt dagegen erst mit „Im Editor öffnen“ in Phase 3
  (Nutzerentscheidung 16.10.2026); in Phase 2 gibt es kein `editor`-Feld.

## ADR-118 – Tastatur Phase 2
- **Datum/WP:** 16.10.2026, WP-30
- **Entscheidung:** Strg+K Quick-Switcher, Alt+1..9 (sichtbare Reihenfolge), Alt+N nächste wartende
  Session (zyklisch, wie der Knopf „Wartet auf dich (n)“), F2 Umbenennen (Fokus nicht in einem
  Eingabefeld). Keine Strg+Alt-Kürzel (AltGr). Belegung im Edge-App-Fenster per E2E prüfen.

## ADR-119 – Ordner-Browser
- **Datum/WP:** 16.10.2026, WP-30 (R1-17)
- **Entscheidung:** `fs.listDirectory`: Wurzeln = vorhandene Laufwerke (je `stat` mit 1,5 s Timeout)
  + Benutzerordner; nur Ordner und Links auf Ordner; versteckt = Punkt-Name oder bekannte
  Systemordner (Node kennt kein Hidden-Attribut). Vor jedem Zugriff `windowsPathIssue` und je Segment
  `lstat`/`readlink` (kein Link auf UNC/Device). Zugeordnete Netzlaufwerke sind erlaubt (vom Nutzer
  eingerichtet, nicht aus Claudes Text).

## ADR-120 – Parallax-Edge-Fenster ohne Autoplay-Sperre
- **Datum/WP:** 18.10.2026, Koordinator nach WP-38 (umgesetzt in WP-40)
- **Entscheidung:** Der Launcher startet Edge zusätzlich mit `--autoplay-policy=no-user-gesture-required`.
  Das eigene Edge-Profil lädt nur den Parallax-Origin auf `127.0.0.1` (nichts aus dem Internet), daher
  betrifft die Lockerung nur unsere synthetisierten Töne (ADR-109). Ohne das Flag bleibt ein Fenster
  aus Autostart oder Toast-Klick bis zur ersten Interaktion stumm. Der Hinweis „Töne aktivieren“
  (WP-38) bleibt als Rückfall für Fenster, die nicht über den Launcher geöffnet wurden.

## ADR-121 – Leerlauf-Schlaf nur ohne geplante Turns
- **Datum/WP:** 18.10.2026, Koordinator nach R4 (R4-02, architecture §10 / R0-27)
- **Entscheidung:** Die Engine erkennt geplante Turns und lässt solche Sessions nie einschlafen: ein
  `tool_use` `ScheduleWakeup` oder `CronCreate` im laufenden Prozess sowie ein gesendeter Prompt, der mit
  `/loop` beginnt, markieren die Runtime als „geplant“; `sleepEligible` schließt sie aus, bis der Prozess
  endet (konservativ: `CronDelete` hebt die Markierung nicht auf). Rein Engine-intern, kein Contract.
  Der Default `DEFAULT_IDLE_SLEEP` (an, 30 min) bleibt. WP-41 prüft live „`/loop` bleibt wach“.

## ADR-122 – Nativer Toast stumm, wenn ein Fenster selbst klingt
- **Datum/WP:** 18.10.2026, Koordinator nach R4 (R4W-07), ergänzt ADR-109
- **Entscheidung:** Bekommt bei einer Benachrichtigung zusätzlich zum nativen Toast ein Fenster das
  `notify` (Fall ohne Web-Notification-Recht, ADR-082), ist der Toast `silent` – das Fenster spielt den Ton
  per Web Audio (seit ADR-120 auch ohne vorherige Interaktion). Ohne Fenster klingt der Toast wie bisher
  nach `events[kind].sound`. Kein Doppelton.

## ADR-123 – Konsolenbefehl ohne Secret-Werte
- **Datum/WP:** 18.10.2026, Koordinator nach R4 (R4W-08), schränkt ADR-104 ein
- **Entscheidung:** `session.consoleCommand` schreibt Werte geheimer Variablen (`isSecretEnvKey`,
  ADR-124) nicht mehr in die Kopierzeile, sondern eine verdeckte Abfrage in der Konsole, z. B.
  `$env:NAME=[Net.NetworkCredential]::new('', (Read-Host 'NAME' -AsSecureString)).Password` (PowerShell
  5.1 und 7). Übrige Werte bleiben im Befehl. Der Hinweistext beim Kopieren sagt, dass geheime Werte
  abgefragt werden. Die von Parallax selbst geöffnete Konsole (ADR-104) übergibt Secrets weiter über die
  Prozess-Umgebung, nie über die Zwischenablage.

## ADR-124 – Eine Secret-Regel in `@shared/secrets`
- **Datum/WP:** 18.10.2026, Koordinator nach R4 (R4-07, R4W-09; Contract-Änderung, additiv)
- **Entscheidung:** `isSecretEnvKey(name)` liegt in `src/shared/secrets.ts` und wird von Server
  (Redaction, `registerSecret`, Konsole) und Web (Maskierung im Profil-Editor) importiert; Kopien
  entfallen. Regel: ein Namensteil (durch `_` getrennt, case-insensitiv) ist `KEY`, `APIKEY`, `TOKEN`,
  `SECRET`, `PASSWORD`, `PASSWD`, `CREDENTIAL` oder `CREDENTIALS` (z. B. `AWS_BEARER_TOKEN_BEDROCK`,
  `GH_TOKEN_CI`), dazu ausdrücklich `ANTHROPIC_CUSTOM_HEADERS`; nicht `KEYBOARD_LAYOUT`,
  `TOKENIZER_PATH`. Aufgelöste Werte von Secret-Namen (auch `${env:…}`) registriert der Server bei jedem
  Bau einer Launch-Spec (`launchSpecFor`, `checkProfile`, `consoleLaunchFor`), nicht nur für die Konsole.

## ADR-125 – Summengrenze für Bild-Anhänge je Prompt
- **Datum/WP:** 18.10.2026, Koordinator nach R4 (R4-16; Contract-Änderung, additiv)
- **Entscheidung:** Neben der Einzelgrenze `LIMITS.imageBytes` gilt `LIMITS.attachmentsTotalBytes`
  = 20 000 000 Byte roh je Prompt (base64 ≈ 26,7 MB, unter der Request-Grenze der Messages-API).
  Server: `resolveAttachments` lehnt die Summe mit `PAYLOAD_TOO_LARGE` ab (Params im bestehenden Schema,
  `bytes` = Summe, `max` = Grenze); Client: der Composer prüft vor dem Senden und zeigt den Fehler am Chip.

## ADR-126 – Web-Regeln nach R4: Feature → Shell, Fehler aus Dialogen, Hinweise über Modals
- **Datum/WP:** 18.10.2026, Koordinator nach R4 (R4W-05, R4W-22)
- **Entscheidung:** (1) Features dürfen Shell-Bausteine (Komponenten, Kanäle, Helfer) importieren, die
  Shell nie Features (ESLint erzwingt die Gegenrichtung); reine Helfer gehören nach `src/web/lib`.
  (2) Fehler einer Aktion aus einem offenen Dialog zeigt der Dialog selbst (`Alert role="alert"`), nicht
  die Hinweis-Region. (3) Die Hinweis-Region liegt über modalen Dialogen und bleibt für Screenreader
  erreichbar; ein Hinweis kann eine Aktion tragen (`ClientNotice.action?`), z. B. „Töne aktivieren“.

## ADR-127 – Nachträge aus der Fix-Runde R4
- **Datum/WP:** 18.10.2026, Koordinator nach FIX-R4 (Quellen: `docs/wp/FIX-R4-F1.md` … `FIX-R4-F4.md`).
  Ergänzt ADR-102, ADR-104, ADR-110, ADR-114 und ADR-124; deren Text bleibt unverändert (nur anhängen).
- **ADR-102 (Profil-Store; Quelle FIX-R4-F1, R4-06):** Ändert ein Speichern `executable`, `env` oder
  `configDir` (`profileResolutionKey`, derselbe Schlüssel wie der Auflösungs-Cache), fällt der Prüfstatus
  auf „wird geprüft“ zurück und die Komposition prüft das Profil neu; Name, Farbe, Args und Vorgaben
  behalten ihn (Args ändern weder Version noch Anmeldung).
- **ADR-104 (externe Konsole; Quelle FIX-R4-F1, R4-01/-03/-04/-05):** (a) Die Gates `SESSION_EXTERNAL`/
  `SESSION_ARCHIVED` gelten beim Eingang **und** erneut im Lifecycle-Lock (`assertEntryGate`); ein zweites
  `openExternal`, das auf den Lock wartete, antwortet `SESSION_EXTERNAL` (nicht idempotent),
  `startRuntime` lehnt externe Einträge ab – nie ein zweiter Schreiber, nie eine zweite Konsole.
  (b) Der Shutdown wartet ab Beginn, parallel zu den Closes, höchstens `lifecycleShutdownWaitMs` (10 s) auf
  laufende Lifecycle-Operationen, damit ein gerade geöffneter Handoff gespeichert wird; nach
  Shutdown-Beginn öffnet `openExternal` nichts mehr (`SERVER_SHUTTING_DOWN`). (c) PowerShell startet
  ohne `-ExecutionPolicy Bypass`; das Skript setzt `PSModulePath` und `PSExecutionPolicyPreference` vor
  `Start-Process` auf die Werte der Spec bzw. entfernt sie (Träger `PARALLAX_CONSOLE_PSMODULEPATH`/
  `_PSPOLICY`) – die Konsole erbt keine Lockerung von Parallax. (d) Die 5-s-Prüfung fragt die Startzeit per
  CIM nur beim ersten Blick und dann alle 60 s (`CONSOLE_RECHECK_MS`), dazwischen nur `isProcessAlive`.
- **ADR-110 (Autostart; Quelle FIX-R4-F1, R4-11/-12):** „Autostart aus“ entfernt eine vorhandene
  `Parallax.lnk` nur, wenn ihre Argumente `launcher\main.ts` enthalten; eine fremde Verknüpfung bleibt
  (`foreign`, kein Fehler – wie beim fremden Protokoll-Handler). Auf einem anderen Datenordner tragen
  Verknüpfung und Protokoll-Befehl `--home=<home> --system-integration=on`, damit der so gestartete Server
  wieder integriert ist.
- **ADR-114 (Kataloge; Quelle FIX-R4-F1, R4-15):** Der Startabbruch bei neuerer `schemaVersion` gilt für
  `model-catalogs.json` und `account-limits.json`. `entries/<id>/commands.json` ist nur Cache: unlesbar,
  ungültig oder neuer heißt „kein Cache“, die Datei wird mit dem nächsten Katalog überschrieben (WP-31
  bewusst, harmlos).
- **ADR-124 (Secret-Regel; Quelle FIX-R4-F1, R4-07):** Registriert werden die aufgelösten Werte der
  Secret-Namen **des Profils** (`registerProfileSecrets` in `launchSpecFor`, `checkProfile` vor dem
  CLI-Aufruf und `consoleLaunchFor`), nicht jedes Secret der Server-Umgebung (Pfade in `*_KEY_PATH`-Variablen
  würden Logs unlesbar machen). Die Freitextmuster des Loggers folgen denselben Namensteilen.

## ADR-128 – `PSExecutionPolicyPreference` der aufrufenden Claude-Session auch für SDK-Spawns entfernen
- **Datum/WP:** 18.10.2026, Koordinator nach WP-41 (Befund WP41-08). Ergänzt ADR-021 (dessen Text bleibt).
- **Kontext:** ADR-021 entfernt die Tool-Shell-Variablen einer aufrufenden Claude-Session
  (`TERMINAL_TOOL_SHELL_VARS`) nur für `target: 'terminal'`, weil das gestartete `claude` sie für seine
  eigenen Tools ohnehin setzt. Live (WP-41) bekamen die SDK-`claude`-Prozesse eines aus einer
  Claude-Code-Shell gestarteten Servers `PSExecutionPolicyPreference=Bypass`; darüber erben auch die von
  `claude` gestarteten Hooks und MCP-Server die gelockerte Ausführungsrichtlinie. Für die Konsole hat
  R4-04 dieselbe Lockerung bereits beseitigt (ADR-127 zu ADR-104 (c)).
- **Entscheidung:** Stammt das Basis-Env aus einer Claude-Session (`CLAUDECODE` gesetzt), entfernt
  `buildEnv` `PSExecutionPolicyPreference` (case-insensitiv) für **jedes** Ziel, also auch SDK-Session,
  „Profil testen“ und Preflight – mit derselben Persistenz-Ausnahme (bleibt, wenn persistent mit gleichem
  Wert gesetzt) und demselben Report-Grund `tool_shell`. Die übrigen Tool-Shell-Variablen bleiben für SDK
  erhalten (harmlos, ADR-021).
- **Folgen:** Normaler Start (Launcher, Autostart, `parallax.cmd`) ist unverändert, weil ohne aufrufende
  Session nichts greift. Umsetzung und Tests: FIX-41 F1 (`src/server/claude/env.ts`, `env.test.ts`).

## ADR-129 – Ziel einer Benachrichtigung bei Fokus-Gleichstand; Fokus übersteht Reconnects
- **Datum/WP:** 18.10.2026, Koordinator nach FIX-41 F1 (Befund WP41-04). Ergänzt ADR-109 (Text bleibt).
- **Kontext:** Ohne fokussiertes sichtbares Fenster geht eine Benachrichtigung an den zuletzt fokussierten
  Client; bei Gleichstand bzw. „nie fokussiert“ an den zuletzt verbundenen. Der Hub setzte `lastFocusAt`
  je Verbindung und beim Hello eines unfokussierten Fensters auf `null`. Live (WP-41) waren dadurch das
  App-Fenster und unsichtbare Hilfsclients gleichauf, und das `notify` ging an einen unsichtbaren Client –
  kein Popup.
- **Entscheidung:** (1) Stufen der Zielwahl ohne fokussiertes sichtbares Fenster: jüngstes `lastFocusAt`;
  bei Gleichstand Clients mit `systemNotifications !== false` vor solchen ohne, dann sichtbare vor
  unsichtbaren, dann zuletzt verbunden. Die Stufe „anderes fokussiertes sichtbares Fenster“ bleibt.
  (2) Der Hub merkt sich `lastFocusAt` je `clientId` (begrenzt) und übernimmt den Wert beim Hello eines
  bekannten, unfokussierten Fensters, statt ihn auf `null` zu setzen. (3) Je Benachrichtigung eine
  `debug`-Zeile `notification route` mit Kanal, Ziel, Grund und Präsenz-Zusammenfassung, ohne Titel/Texte.
- **Folgen:** Ein Fenster nach Server-Neustart oder Verbindungsabbruch behält seinen Fokus-Rang. Umsetzung
  und Tests: FIX-41 F1 (`sessions/notifier.ts`, `sessions/manager.ts`, `sync/hub.ts`).

## ADR-130 – Externe Konsole: geplantes Weiter und Auto-Retry erst nach geöffneter Konsole verwerfen
- **Datum/WP:** 19.10.2026, Code-Review Phase 2, Fix-Paket S1 (CR2-02). Ergänzt ADR-104 und ADR-112 (Texte
  bleiben).
- **Kontext:** `session.openExternal` verwarf ein geplantes „Weiter nach Rate-Limit“ (`continueAt`,
  `wakeupAt`) und einen anstehenden Auto-Retry, bevor die Konsolen-Spec gebaut und die Konsole geöffnet war.
  Scheiterte einer dieser Schritte (`PROFILE_INVALID`, `CLAUDE_NOT_FOUND`, AppLocker →
  `EXTERNAL_CONSOLE_FAILED`), blieb der Eintrag in Parallax, aber zur Reset-Zeit setzte nichts fort.
- **Entscheidung:** Reihenfolge im Lock: Gates, Vorbedingungen, `checkCwd`, **Konsolen-Spec**
  (`consoleLaunchFor`), Query schließen, Waisenprüfung abwarten, `launcher.open`. Plan und Retry werden erst
  bei `result.kind === 'opened'` verworfen. Ein Profilfehler ändert nichts (die Query läuft weiter); scheitert
  `open()`, ruht der Eintrag mit erhaltenem Plan/Retry.
- **Folgen:** Ein während `open()` fälliger Timer wartet auf den Lock; nach geöffneter Konsole lehnt
  `startRuntime` ihn ab (R4-01). Umsetzung und Tests: `sessions/external.ts`,
  `external.integration.test.ts` „CR2-02: …“.

## ADR-131 – Wirkungen eines Prompts erst, wenn er angenommen ist
- **Datum/WP:** 19.10.2026, Code-Review Phase 2, Fix-Paket S1 (CR2-04, CR2-09). Ergänzt ADR-112, ADR-121 und
  R4-01.
- **Kontext:** Ein reiner Text-Prompt verwarf Plan und Retry und setzte den Prompt-Titel vor dem
  Lifecycle-Lock; wies die zweite Gate-Prüfung im Lock ihn ab (`SESSION_EXTERNAL`, `SESSION_ARCHIVED`), blieben
  Titel und `promptTitle` geändert. `deliverPrompt` markierte einen `/loop`-Prozess als geplant, bevor
  `send()` den Prompt angenommen hatte; ein abgelehnter Prompt ließ den Prozess nie mehr schlafen.
- **Entscheidung:** `session.sendPrompt` ändert Retry, Plan und Prompt-Titel – für Text- und Anhang-Prompts
  gleich – erst im Lock nach `assertEntryGate` und der Anhangprüfung. `deliverPrompt` markiert einen
  `/loop`-Prozess erst nach erfolgreichem `send()` als geplant.
- **Folgen:** Hinter einer anderen Lifecycle-Operation erscheint der Prompt-Titel erst mit dem Lock; vor dem
  eigenen Start (Waisenprüfung) weiterhin sofort. Umsetzung und Tests: `sessions/commands.ts`,
  `sessions/runtime.ts`, `external.integration.test.ts` „CR2-04: …“, `phase2.integration.test.ts` „CR2-09: …“.

## ADR-132 – Persistierte Modellkataloge tragen den Profil-Schlüssel
- **Datum/WP:** 19.10.2026, Code-Review Phase 2, Fix-Paket S1 (CR2-05). Ergänzt ADR-102 und ADR-114.
- **Kontext:** `model-catalogs.json` speicherte Kataloge und Alias-Auflösungen nur je Profil-ID; der Manager
  säte `profileKeys` aus den Profilen beim Start. Wurde `profiles.json` bei gestopptem Parallax geändert oder
  aus `.bak` geholt (andere `.exe`, anderes `CLAUDE_CONFIG_DIR` = anderes Konto), lieferte der Cache Modelle
  und Aliasse des alten Kontos, und `onProfileChanged` verwarf nie.
- **Entscheidung:** Jeder gespeicherte Katalog trägt `profileKey` (`profileCacheKey` des Profils, unter dem
  der Cache steht; Feld mit Default `null`, `schemaVersion` bleibt 1). Beim Start übernimmt der Manager nur
  Kataloge, deren Schlüssel zum Profil jetzt passt; andere – auch ältere Dateien ohne Schlüssel und Kataloge
  gelöschter Profile – werden aus Datei und Cache entfernt und beim nächsten Start neu geholt.
- **Folgen:** Nach einem Update auf diese Version fehlen die Kataloge einmalig bis zum ersten Start je Profil
  (Rückfall auf die CLI-Aliasse, WP22-01). Abo-Limits unverändert. Umsetzung und Tests:
  `sessions/catalogStore.ts`, `sessions/manager.ts`, `phase2b.integration.test.ts` und `catalogStore.test.ts`
  „CR2-05: …“.
