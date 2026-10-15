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