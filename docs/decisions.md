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
