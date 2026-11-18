# Parallax – Regeln für jede Session und jeden Subagenten

## Zweck
Parallax ist eine lokale Mission-Control-App für viele parallele Claude-Code-Sessions unter Windows.
Ein Node-Server (127.0.0.1) steuert je Session das **installierte** `claude` über das Agent SDK;
die Web-UI (Chrome im App-Modus) zeigt Status, Context, Chat und nicht-modale Entscheidungen.

## Stack
- Server: Node ≥ 24.5 (Standard 26), TypeScript, Fastify 5 + `@fastify/websocket`, zod 4, pino 10,
  `@anthropic-ai/claude-agent-sdk` **exakt 0.3.322** (Plattform-Binaries per pnpm ausgeschlossen).
- Web: Vite 8, React 19, Tailwind v4, shadcn/ui (`radix-ui`), lucide-react, Zustand,
  react-markdown/streamdown, shiki, diff, virtua. Fonts lokal (@fontsource-variable).
- Tests: Vitest 5 (Projekte `node` + `web`/happy-dom), Playwright mit `channel: 'chrome'`.
- Paketmanager: pnpm 12.17.0. Einstellungen in `pnpm-workspace.yaml`, nie in `package.json`.

## Befehle
| Befehl | Zweck |
|---|---|
| `pnpm install --frozen-lockfile` | Abhängigkeiten exakt nach Lockfile |
| `pnpm dev` | Server (FakeBackend, Port 4712, `--home=.parallax-dev`) + Vite (5173, Proxy `/api`) |
| `pnpm dev:web` | nur Vite; Playground `#playground`; im Worktree eigener Port per `PARALLAX_DEV_WEB_PORT` |
| `pnpm dev:live` | wie `dev`, aber SdkBackend (echtes `claude`) – nur mit WP-Freigabe |
| `pnpm build` | `dist/web` (Vite) + `dist/server.js` (esbuild) |
| `pnpm start` | Launcher: Build bei Bedarf, Server unsichtbar, Chrome; ohne `claude`: `PARALLAX_BACKEND=fake` + eigenes `PARALLAX_HOME` |
| `pnpm check` | typecheck (`tsc -b`) + lint + test – muss vor jedem Commit grün sein |
| `pnpm typecheck` / `lint` / `test` / `format` | Einzelschritte; eigene Pfade: `pnpm exec eslint <pfade>`, `pnpm exec vitest run <pfade>` |
| `pnpm e2e` | Playwright in Chrome gegen den Server-Build mit FakeBackend (ohne `e2e/live`) |
| `$env:PARALLAX_LIVE='1'; pnpm e2e e2e/live` | Live-Smoke gegen das echte `claude` – nur mit Nutzer-Freigabe; SDK-/CLI-Upgrade: `docs/sdk-upgrade.md` |
| `pnpm preflight` / `pnpm record <szenario>` | Umgebungscheck (WP-11) / Fixture-Recorder (WP-01) |
| `pnpm exec tsx --tsconfig tsconfig.tools.json scripts/public-check.ts [--refs <bereich>]` | Prüfung auf private Daten: Dateien bzw. was ein Push veröffentlicht (WP-84) |
| `pnpm exec tsx --tsconfig tsconfig.tools.json scripts/release-notes.ts --check \| --extract <version>` | `CHANGELOG.md` prüfen bzw. Notizen einer Version ausgeben (WP-85) |
| `… scripts/release-pack.ts --out <ordner>`, dann `… scripts/release/smoke.ts --dir <paket> --work <ordner>` | Release-Paket lokal bauen und prüfen (schwer, Netz; sonst CI `release.yml`). `scripts/release-key.ts` führt nur der Nutzer aus |

## Ordner und Ownership Phase 3 (datei-genau; Details: `docs/wp/WP-50.md` §6, `docs/architecture.md` §2)
| Pfad | Inhalt | Owner |
|---|---|---|
| `src/shared/**`, `src/server/**/ports.ts` (inkl. `system/ports.ts`, neu `files/ports.ts`), `src/server/backend/{types,fixture}.ts` | Contracts v3 | Koordinator (eingefroren) |
| `src/server/lib/{async,fs,homeLock,ffi}.ts` | Basis-Helfer (`toError`, `writeFileAtomic`, Home-Lock, `node:ffi`) | Koordinator |
| `src/server/sessions/**` (ohne `ports.ts`, ohne `normalizer/**`) | Engine: frischer Kontext, Plan-Versionen, Stop je Task, Detail-Felder, Anhänge/Pastes | WP-51 |
| `src/server/sessions/normalizer/**`, `src/server/backend/**` (ohne `types/fixture`) | Normalizer, SDK-Optionen, Fake-Szenarien | WP-52 |
| `src/server/files/**` (ohne `ports.ts`), `src/server/{http,store}/**`, `src/server/lib/**` (übrige) | Datei-Dienst, `/api/file`, Uploads, Anhang-Store, Programmstart | WP-53 |
| `src/web/features/files/**`, `src/web/shell/side-panel/**`, `src/web/state/fake-host{,.test}.ts`, `src/web/ui/{code-block,diff-view,copy-button}.tsx`, `src/web/ui/use-highlight.ts` und `src/web/lib/{highlight,languages,diff,sized-cache}.ts` (aus WP-50 Teil 2), neu `src/web/ui/splitter.tsx` | Viewer, `FileLink`, Dateien-Panel, Panel-Host, Fake-Host | WP-54 |
| `src/web/features/{transcript,tasks}/**`, neu `src/web/lib/file-refs.ts` (+ Test) | Verweise im Transkript, Task-Panel, Aufgabenleiste | WP-55 |
| `src/web/features/decisions/**` | Plan-Komfort | WP-56 |
| `src/web/features/composer/**` | Anhänge, Paste-Chips, @-Picker | WP-57 |
| `src/web/shell/**` (ohne die Zeilen oben/unten), `src/web/state/**` (ohne `fake-host`), `src/web/lib/**` (übrige), `src/web/features/preferences/**` | Shell: Kopfzeile, Session-Menü, Drop-Zone, schmales Fenster, Editor-Einstellung, Slot-Fehlergrenze | WP-58 |
| `src/server/main.ts`, `src/server/app/**`, `src/web/{App,main}.tsx`, `e2e/**` | Komposition, Verdrahtung, E2E | WP-60 |
| `src/web/shell/{requests,slots,placeholders}.ts(x)`, `src/web/shell/server-shutdown/**`, `src/web/shell/new-session/**`, `src/web/shell/{NewSessionDialog,NewSessionForm,EmptyState}.tsx`, `src/web/i18n/**`, übrige `src/web/ui/*`, `src/web/features/profiles/**`, `src/web/notifications/**`, `src/web/playground/**`, `src/web/index.{html,css}` | Gerüst / unverändert | Koordinator |
| `src/server/{claude,host,system,sync,launcher,install}/**` (ohne `ports.ts`), `src/server/config.ts`, `scripts/**`, `test/**`, Root-Configs, `package.json`, Lockfile, `.github/**`, `CHANGELOG.md` | unverändert / Bootstrap | Koordinator |

- **Update in der App (WP-87…89, `docs/wp/WP-87.md` §2.0):** Koordinator `src/shared/**`,
  `src/server/update/{ports,endpoints,marker,handoff}.ts`, Web-Gerüst (Slots, Abschnitt `updates`, i18n); 87p
  `src/server/install/{install,layout,testPackage}.ts`, `src/server/store/backup.ts`, `src/shared/changelog.ts`,
  `scripts/release/changelog.ts`, `scripts/release-pack.ts`, `test/setup/home.ts`; 87a `src/server/update/**` (übrige);
  87b `src/server/launcher/{args,cli,main,launcher,shutdown,backupStep}.ts`, neu `applyUpdate.ts`; 88a
  `src/web/features/updates/**`; 88b `src/web/state/{store,connection}.ts`, `src/web/shell/{HostGate,ShellBanners,
  Sidebar}.tsx`; 89 (Koordinator) `src/server/main.ts`, `src/server/{app,http}/**`, `src/server/sessions/manager.ts`,
  `src/web/App.tsx`, `e2e/**`, `scripts/build-server.ts`, `scripts/release/smoke.ts`, `.github/**`.
- Keine Datei wird von zwei Paketen bearbeitet; nichts in fremden Ordnern anlegen. `README.md` von
  Ordnern mit mehreren Ownern (`src/server`, `server/lib`, `server/sessions`, `server/backend`,
  `src/web`, `web/shell`, `web/features`, `web/ui`) pflegt der Koordinator.
- Features importieren einander nie: gemeinsame Komponenten über `FeatureSlots`
  (`src/web/shell/slots.tsx`, verdrahtet in WP-40), Querverbindungen zur Shell über den Anfragekanal
  `src/web/shell/requests.ts`. Features dürfen Shell-Bausteine importieren, die Shell nie Features;
  reine Helfer gehören nach `src/web/lib` (ADR-126). Fehler aus einem offenen Dialog zeigt der Dialog
  selbst (`Alert role="alert"`). Wörterbücher je Bereich: `features/<f>/i18n/{en,de}.ts` bzw.
  `shell/<bereich>/i18n/{en,de}.ts` (Namensräume `navigation`, `newSession`, `profiles`, `preferences`;
  Phase 3 neu `files`, `tasks`, `sidePanel`).
- Aliase: `@shared/*` (überall), `@web/*` (nur Web). Jeder Ordner hat eine `README.md`.

## Contracts (Kurzregeln, Details `docs/architecture.md`)
- **Contracts und Ports sind eingefroren:** Änderung nur nach Freigabe des Koordinators (s. „Tabu“).
- Auf dem Draht nur `entryId`; `sessionKey = hostId:entryId` existiert nur im Client.
- SDK-Messages normalisiert nur der Server (WP-12); Shared kennt keine SDK-Typen.
- Fehler: `ErrorPayload {code, params}`; neue Codes nur per Contract-Änderung.
- IDs: Server `lib/ids.ts` (`newId('en'|'cv'|'dc'|'pf')`), Web `lib/ids.ts`.
- Ops nur über `applySessionOp` (`@shared/sync`) anwenden – Server-Hub und Web-Store.
- Status-Anzeige nur über `deriveDisplayStatus` (`@shared/status`).
- HTTP/Auth (Pfade, Schemas, Cookie `parallax_<port>`, Launcher-Code, Lockfile) nur aus `@shared/http`.
- Persistierte Schemas: neue Felder immer mit Default; sonst `schemaVersion` + Migration.
- Testdaten aus `@shared/samples` (feste IDs/Zeiten) statt eigener Beispielobjekte.

## Code-Regeln
- TypeScript strict + `noUncheckedIndexedAccess`; **kein `any`** (auch nicht über `as`).
- **zod an jeder Grenze**: WS, HTTP, Dateien, Env, CLI-Argumente, SDK-Messages (tolerant parsen,
  unbekannte Typen ignorieren und zählen).
- Fehlercodes nur aus `src/shared/errors.ts`; der Server sendet Codes, die UI übersetzt.
- **Kein UI-String ohne `t()`** (ESLint `react/jsx-no-literals`; gilt auch für `title`,
  `aria-label`, `placeholder` – die prüft der Linter nicht, das Review schon).
- Logging nur über `logger` (`src/server/lib/logger.ts`); kein `console.*` in `src/**`.
- **Web importiert nie Server-Code** und umgekehrt (tsconfig `rootDir` + ESLint
  `no-restricted-imports`). `src/shared` importiert weder Server noch Web noch Node-APIs.
- Helfer nur in `*/lib`. **Vor dem Anlegen eines Helfers greppen**, ob es ihn schon gibt.
- UI-Primitives nur aus `src/web/ui`, Farben nur über Design-Tokens (`index.css`).
- Kein `rehype-raw`, kein `dangerouslySetInnerHTML`; Links nur http(s); nichts aus dem Internet laden.
  Einzige Ausnahme (WP-83 §3.7, ADR-220): der **Server** lädt Release-Dateien von GitHub und das Agent SDK aus der
  npm-Registry (`src/server/update/**`, `src/server/install/sdk.ts`) – signiert bzw. per Hash geprüft; die Web-UI nie.
- Lokale Imports in Root-Configs (`*.config.ts`) mit `.ts`-Endung (Vite-Config-Loader).

## Tests
- `*.test.ts(x)` liegen **neben dem Code**; Web-Tests laufen in happy-dom mit Testing Library.
- `test/setup` (Vitest, auch `e2e/global-setup.ts`) nimmt **immer** ein eigenes Temp-`PARALLAX_HOME`
  (`parallax-test-*` im OS-Temp; jedes andere geerbte Home wird ersetzt), `PARALLAX_PORT=0` und entfernt
  geerbte Server-Steuervariablen. Nie das echte `%LOCALAPPDATA%\Parallax` anfassen – auch nicht im Dev-Modus.
- **Kein Live-`claude`** (kein `pnpm dev:live`, kein `record`, kein Live-Smoke, kein SdkBackend-Test),
  außer das WP erlaubt es ausdrücklich. Standard ist das FakeBackend mit Fixtures. **Dauerfreigabe
  (Nutzer 12.11.2026):** der Kurz-Check bei `claude`-Updates (`pnpm cli-check`, Skill `/claude-update`,
  WP-62) darf ohne Rückfrage live laufen – Haiku, Abo, kein API-Key, höchstens 0,05 USD je Check.
- Synthetische SDK-Streams als `.ts`-Module (Fixture-Format v1), nie `.jsonl` außerhalb
  `test/fixtures/sdk/` (git-ignoriert, fehlt nach dem Merge).

## Tabu ohne Freigabe
`package.json`, `pnpm-lock.yaml`, `pnpm-workspace.yaml`, `src/shared/**` und die Server-Ports
(`src/server/**/ports.ts`, `backend/types.ts`, `backend/fixture.ts`). Änderungswünsche (neue
Abhängigkeit, Contract-Änderung) im Bericht unter
„GEWÜNSCHTE ABHÄNGIGKEITEN“ bzw. „SCHNITTSTELLEN/CONTRACT-ABWEICHUNGEN“ anfragen; erst nach Freigabe
durch den Koordinator ändern (mit Eintrag im Contract-Changelog). Nichts außerhalb der eigenen
Besitz-Pfade ändern.

## Abhängigkeiten (Nutzer 17.11.2026, ADR-221)
- **Nur Versionen, die älter als 14 Tage sind** (npm und GitHub Actions): `pnpm update
  --config.minimumReleaseAge=20160 --config.minimumReleaseAgeExclude=@anthropic-ai/claude-agent-sdk`, danach jeden
  neuen Eintrag unter `packages:` im Lockfile gegen die Registry-Zeit prüfen (`docs/wp/DEPS-2026-11.md`). Agent SDK
  und `claude` ausgenommen (`/claude-update`). Actions per Commit-SHA mit der Version als Kommentar.
- **Sicherheits-Fixes:** Bei einer CVE mit Schwere **hoch oder kritisch** entscheidet der Nutzer im Einzelfall, ob der
  Fix vor Ablauf der 14 Tage kommt; vorlegen: Paket, Schwere, Pfad (Laufzeit oder nur Entwicklung), Alter des Fixes.
  Sonst wartet der Fix 14 Tage.
- Dependabot-PRs nie auf GitHub mergen: in den laufenden Feature-Branch übernehmen und den üblichen Weg gehen.
  `pnpm audit` läuft wöchentlich (`.github/workflows/audit.yml`) und vor jedem Release.

## Windows
- Pfadregeln nur aus `@shared/paths` (Server: `lib/paths.ts`): case-insensitiv vergleichen,
  `cwd`-String exakt behalten, UNC/Device/ADS vor jedem Dateizugriff ablehnen. Nie duplizieren.
- Prozessbäume mit `taskkill /PID <pid> /T /F` beenden; **jeder** Spawn mit `windowsHide: true`
  und ohne Shell (Argument-Array). **Ausnahme:** sichtbare GUI-Programme nach einem Nutzerklick
  (Editor, Explorer, Standardprogramm) nur über `spawnGui` aus `lib/process.ts` (absolute `.exe`,
  PE-Subsystem GUI geprüft, Blockliste, `detached`, ADR-144). Nie `cmd /c start`. Nur **absolute `.exe`-Pfade** starten
  (`resolveExecutable` aus `lib/windows.ts`), nie nackte Namen wie `git` – sonst gewinnt das `cwd`.
- Gestartete Hintergrundprozesse (Dev-Server, Vite, Tests) am Ende immer beenden.
- **Session-Variablen der aufrufenden Claude-Session** (`CLAUDECODE`, `CLAUDE_CODE_*`,
  `CLAUDE_PID`, `CLAUDE_EFFORT`, `CLAUDE_AGENT_SDK_*`, `AI_AGENT`, Hook-Marker …) dürfen nie in gestartete
  `claude`-Prozesse lecken: Env immer über `buildEnv()` bauen (Review C.2). `buildEnv` entfernt auch
  jedes geerbte `PARALLAX`/`PARALLAX_*`; gesetzt werden nur `PARALLAX=1` und `PARALLAX_ENTRY_ID` (ADR-083).

## Ressourcen (Nutzerregel 12.11.2026, ADR-154)
Der Rechner des Nutzers darf **nie** einfrieren oder spürbar hängen – auch nicht kurz.
- **Höchstens ein schwerer Lauf gleichzeitig** auf der Maschine: `pnpm check`/`test`/`build`/`e2e`/
  `install`, voller `vitest run`. Parallele Subagenten nur, wenn sie keine schweren Läufe starten
  (gezielt `pnpm exec vitest run <eigene pfade>`, `eslint <pfade>` sind erlaubt); volle Checks macht
  dann der Koordinator nacheinander.
- **Keine künstliche Last:** keine gleichzeitigen Testläufe, keine CPU-Last-Skripte, kein „E2E unter
  Last“. Flakes nur durch wiederholte Läufe nacheinander suchen.
- Vitest, Playwright und `pnpm build` laufen mit Priorität „niedriger als normal“ (vererbt an alle
  Kindprozesse), Vitest mit höchstens 50 % der CPUs (`repo.config.ts`). Nicht abschalten, nicht per
  `--maxWorkers` erhöhen. Eigene schwere Befehle außerhalb dieser Werkzeuge in PowerShell mit
  `(Get-Process -Id $PID).PriorityClass = 'BelowNormal'` davor starten.

## Sprache
- Doku (README, `docs/**`, CLAUDE.md, WP-Aufträge/-Berichte) und Commit-Messages: **Deutsch**.
- Code-Bezeichner und Code-Kommentare: **Englisch**. Logs und `pnpm preflight`: Englisch.
- UI zweisprachig: Englisch (Default) und Deutsch.

## Öffentliches Repo (WP-84, ADR-212)
- Das Repo ist öffentlich. **Nichts Privates** in Code, Doku, Testdaten, Commit-Messages oder Branch-Namen:
  keine Benutzerordner, kein Pfad des Entwicklungs-Repos, keine Scratch-Ordner, keine privaten
  E-Mail-Adressen, keine Firmen-, Netz- oder Kontodetails, keine echten Session-Links oder Schlüssel.
  Neutral schreiben: `%USERPROFILE%\…`, `%TEMP%\…`, `C:\Users\<USER>\…`, `<repo>\…`, „Scratch-Ordner
  (nicht im Repo)“; Testnamen erfunden, E-Mail-Adressen nur `*.example`. Scratch-Pfade nie in Berichte.
- `scripts/public-check` prüft die Dateien in `pnpm test` (allgemeine Regeln, Benutzername und Pfad dieses
  Rechners, dazu die lokale Liste `public-check.local` im gemeinsamen git-Verzeichnis; sie wird nie
  versioniert und nie gelöscht). Funde nennen nur Datei, Zeile und Regel.
- **Vor jedem Push:** `pnpm exec tsx --tsconfig tsconfig.tools.json scripts/public-check.ts --refs
  origin/main..<branch>` (Messages, Autor- und Committer-Adressen, Branch- und Dateinamen, alle Blobs des
  Bereichs) muss 0 Funde melden.
- Commits nur mit der `noreply`-Adresse von GitHub, ohne `Co-Authored-By`- und `Claude-Session`-Zeilen.

## Git
- **`main` ist der stabile Stand,** aus dem Releases entstehen. Die produktiven Instanzen laufen aus
  Releases (Installation in `%LOCALAPPDATA%\Programs\Parallax`, README „Installieren“/„Aktualisieren“,
  WP-86); ein eigener Klon mit `git pull` bleibt der Rückweg. Auf `main` wird nicht entwickelt.
- Entwicklung auf Branches: je Vorhaben ein Feature-Branch `feature/<name>` von `main` (Phase/Welle: ein
  Integrations-Branch, z. B. `feature/phase-3`). WP- und Fix-Worktree-Branches (`wp/xx`, `fix/<name>`)
  zweigen vom Feature-Branch ab; der Koordinator merged sie dorthin (`--no-ff --no-commit`, Checks, dann
  Commit).
- Nach `main` kommen nur fertige, geprüfte Stände: Merge `--no-ff` des Feature-Branches erst bei grünem
  `pnpm check` + `pnpm build`, bei Code-Änderungen zusätzlich `pnpm e2e`, plus die im Plan vorgesehenen
  Reviews und Live-Prüfungen. Fehler der produktiven Instanz: `fix/<name>` von `main`, nach `main`
  mergen, danach `main` in den laufenden Feature-Branch.
- Lokale Commits pro WP, Merge macht der Koordinator. **Subagenten pushen nie**; `origin` = öffentliches
  Repo `DerXHelp/parallax`, Push (jeder Branch) nur durch den Koordinator nach Freigabe des Nutzers und
  nach einem sauberen `public-check --refs` (Abschnitt „Öffentliches Repo“).
  **Dauerfreigabe (Nutzer 12.11.2026):** Nach einem grünen `claude`-Kurz-Check darf der Koordinator
  nach `main` mergen und pushen, wenn nur das CLI-Profil oder kleine Anpassungen betroffen sind (Ablauf:
  Skill `/claude-update`); größere Fixes vorher dem Nutzer zeigen.
  **Dauerfreigabe (Nutzer 16.11.2026):** Ist ein Feature fertig umgesetzt und sind die Bedingungen oben
  erfüllt (grünes `pnpm check` + `pnpm build`, `pnpm e2e`, vorgesehene Reviews; eine nötige Live-Prüfung
  vorher mit dem Nutzer klären), merged der Koordinator den Feature-Branch ohne Rückfrage nach `main`
  (`--no-ff --no-commit`, Checks, Commit) und pusht `main`.
- **Changelog (ADR-216):** Bei jedem Merge nach `main` ergänzt der Koordinator im selben Merge-Commit
  `CHANGELOG.md` unter „Unveröffentlicht“: ein Satz je Wirkung für den Nutzer, das WP in Klammern; `fix/<name>` unter
  „Behoben“; interne Arbeiten (Tests, Refactoring, Doku) ohne Eintrag. Das Format prüft `pnpm check`.
- **Releases (ADR-215, Ablauf `docs/wp/WP-83.md` §4.4):** Nur auf Wunsch des Nutzers. **Dauerfreigabe:** „mach ein
  Release“ erlaubt Release-Commit auf `main` (`version`, Abschnitt umbenennen), annotierten Tag `vX.Y.Z` und Push von
  `main` und Tag – vorher `pnpm audit` und `public-check --refs`. Danach die CI beobachten (`gh run watch`) und den
  Link melden; schlägt sie fehl, Entwurf und Tag löschen, beheben, dieselbe Version neu taggen.
- Commit-Messages mit mehreren `-m`-Flags, **kein Heredoc**, keine Command-Substitution.
- Worktrees liegen in `.worktrees/` (ignoriert, von tsconfig/Vitest/ESLint/Vite ausgeschlossen);
  pro Worktree `pnpm install --frozen-lockfile`. `core.longpaths` ist gesetzt.
- In diesem Repo nie `parallax.cmd`/`pnpm start` auf `%LOCALAPPDATA%\Parallax` – immer mit eigenem
  `--home`/`PARALLAX_HOME`. Sonst baut der Launcher den Entwicklungsstand, migriert womöglich die echten
  Daten der produktiven Instanz und biegt Autostart und Protokoll-Handler auf dieses Repo um.
- Den Installer nie gegen `%LOCALAPPDATA%\Programs\Parallax` oder das echte Startmenü probieren: Tests geben
  ihre Ordner selbst vor (eine Sperre bricht sonst ab), `scripts/release/smoke.ts` lenkt `APPDATA` und
  `LOCALAPPDATA` in seinen Arbeitsordner um.

## Subagenten: Auftrag und Bericht
- Rückfragen nie selbst an den Nutzer: im Bericht `BLOCKED: <frage>` melden.
- Details (Versionen, Abweichungen, Stolpersteine) in `docs/wp/WP-xx.md`, nicht in den Bericht.
- Bericht ≤ 250 Wörter, genau dieses Format:
```
STATUS: fertig | teilweise | BLOCKED
GEÄNDERTE PFADE: …
SCHNITTSTELLEN/CONTRACT-ABWEICHUNGEN: …
ENTSCHEIDUNGEN (≤3): …
CHECKS: typecheck …, lint …, tests … (Anzahl), build …
GEWÜNSCHTE ABHÄNGIGKEITEN: …
FOLLOW-UPS: …
COMMIT: <hash> <Betreff>
```

## Doku
- **Rangfolge:** Contracts (`src/shared`, Ports) > `docs/architecture.md`/ADRs > `docs/wp/*` >
  `docs/sdk-findings.md` > `docs/plan.md`.
- `docs/plan.md` – abgestimmter Plan (bei Widersprüchen gilt „Änderungen nach kritischem Review“).
- `docs/progress.md` – WP-Tabelle, Contract-Changelog, offene Fragen, nächste Schritte.
- `docs/decisions.md` – ADRs (nur anhängen). `docs/architecture.md` – Architektur: Module,
  Datenfluss, Source of Truth, Sync-Protokoll, Item- und Statusmodell (seit WP-02 gefüllt).
- `docs/wp/WP-xx.md` – Auftrag und Ergebnis je Arbeitspaket. `docs/sdk-findings.md` (WP-01).
