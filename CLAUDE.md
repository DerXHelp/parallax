# Parallax – Regeln für jede Session und jeden Subagenten

## Zweck
Parallax ist eine lokale Mission-Control-App für viele parallele Claude-Code-Sessions unter Windows.
Ein Node-Server (127.0.0.1) steuert je Session das **installierte** `claude` über das Agent SDK;
die Web-UI (Chrome im App-Modus) zeigt Status, Context, Chat und nicht-modale Entscheidungen.

## Stack
- Server: Node ≥ 22 (Standard 26), TypeScript, Fastify 5 + `@fastify/websocket`, zod 4, pino 10,
  `@anthropic-ai/claude-agent-sdk` **exakt 0.3.322** (Plattform-Binaries per pnpm ausgeschlossen).
- Web: Vite 8, React 19, Tailwind v4, shadcn/ui (`radix-ui`), lucide-react, Zustand,
  react-markdown/streamdown, shiki, diff, virtua. Fonts lokal (@fontsource-variable).
- Tests: Vitest 5 (Projekte `node` + `web`/happy-dom), Playwright mit `channel: 'chrome'`.
- Paketmanager: pnpm 12.8.2. Einstellungen in `pnpm-workspace.yaml`, nie in `package.json`.

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

## Ordner und Ownership Phase 3 (datei-genau; Details: `docs/wp/WP-50.md` §6, `docs/architecture.md` §2)
| Pfad | Inhalt | Owner |
|---|---|---|
| `src/shared/**`, `src/server/**/ports.ts` (inkl. `system/ports.ts`, neu `files/ports.ts`), `src/server/backend/{types,fixture}.ts` | Contracts v3 | Koordinator (eingefroren) |
| `src/server/lib/{async,fs,homeLock,homeAccess}.ts` | Basis-Helfer (`toError`, `writeFileAtomic`, Home-Lock, Home-Rechte) | Koordinator |
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
| `src/server/{claude,host,system,sync,launcher}/**` (ohne `ports.ts`), `src/server/config.ts`, `scripts/**`, `test/**`, Root-Configs, `package.json`, Lockfile | unverändert / Bootstrap | Koordinator |

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

## Git
- **`main` ist der stabile Stand.** Aus `origin/main` aktualisiert der Nutzer seine produktive Instanz
  (eigener Klon, `git pull`; README „Produktiv nutzen und weiterentwickeln“). Auf `main` wird nicht
  entwickelt.
- Entwicklung auf Branches: je Vorhaben ein Feature-Branch `feature/<name>` von `main` (Phase/Welle: ein
  Integrations-Branch, z. B. `feature/phase-3`). WP- und Fix-Worktree-Branches (`wp/xx`, `fix/<name>`)
  zweigen vom Feature-Branch ab; der Koordinator merged sie dorthin (`--no-ff --no-commit`, Checks, dann
  Commit).
- Nach `main` kommen nur fertige, geprüfte Stände: Merge `--no-ff` des Feature-Branches erst bei grünem
  `pnpm check` + `pnpm build`, bei Code-Änderungen zusätzlich `pnpm e2e`, plus die im Plan vorgesehenen
  Reviews und Live-Prüfungen. Fehler der produktiven Instanz: `fix/<name>` von `main`, nach `main`
  mergen, danach `main` in den laufenden Feature-Branch.
- Lokale Commits pro WP, Merge macht der Koordinator. **Subagenten pushen nie**; `origin` = privates
  Repo `DerXHelp/parallax`, Push (jeder Branch) nur durch den Koordinator nach Freigabe des Nutzers.
  **Dauerfreigabe (Nutzer 12.11.2026):** Nach einem grünen `claude`-Kurz-Check darf der Koordinator
  nach `main` mergen und pushen, wenn nur das CLI-Profil oder kleine Anpassungen betroffen sind (Ablauf:
  Skill `/claude-update`); größere Fixes vorher dem Nutzer zeigen.
- Commit-Messages mit mehreren `-m`-Flags, **kein Heredoc**, keine Command-Substitution.
- Worktrees liegen in `.worktrees/` (ignoriert, von tsconfig/Vitest/ESLint/Vite ausgeschlossen);
  pro Worktree `pnpm install --frozen-lockfile`. `core.longpaths` ist gesetzt.
- In diesem Repo nie `parallax.cmd`/`pnpm start` auf `%LOCALAPPDATA%\Parallax` – immer mit eigenem
  `--home`/`PARALLAX_HOME`. Sonst baut der Launcher den Entwicklungsstand, migriert womöglich die echten
  Daten der produktiven Instanz und biegt Autostart und Protokoll-Handler auf dieses Repo um.

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
