# Parallax – Regeln für jede Session und jeden Subagenten

## Zweck
Parallax ist eine lokale Mission-Control-App für viele parallele Claude-Code-Sessions unter Windows.
Ein Node-Server (127.0.0.1) steuert je Session das **installierte** `claude` über das Agent SDK;
die Web-UI (Edge im App-Modus) zeigt Status, Context, Chat und nicht-modale Entscheidungen.

## Stack
- Server: Node ≥ 22 (Standard 26), TypeScript, Fastify 5 + `@fastify/websocket`, zod 4, pino 10,
  `@anthropic-ai/claude-agent-sdk` **exakt 0.3.296** (Plattform-Binaries per pnpm ausgeschlossen).
- Web: Vite 8, React 19, Tailwind v4, shadcn/ui (`radix-ui`), lucide-react, Zustand,
  react-markdown/streamdown, shiki, diff, virtua. Fonts lokal (@fontsource-variable).
- Tests: Vitest 5 (Projekte `node` + `web`/happy-dom), Playwright mit `channel: 'msedge'`.
- Paketmanager: pnpm 12.8.2. Einstellungen in `pnpm-workspace.yaml`, nie in `package.json`.

## Befehle
| Befehl | Zweck |
|---|---|
| `pnpm install --frozen-lockfile` | Abhängigkeiten exakt nach Lockfile |
| `pnpm dev` | Server (FakeBackend, Port 4712, `--home=.parallax-dev`) + Vite (5173, Proxy `/api`) |
| `pnpm dev:web` | nur Vite; Playground `#playground`; im Worktree eigener Port per `PARALLAX_DEV_WEB_PORT` |
| `pnpm dev:live` | wie `dev`, aber SdkBackend (echtes `claude`) – nur mit WP-Freigabe |
| `pnpm build` | `dist/web` (Vite) + `dist/server.js` (esbuild) |
| `pnpm start` | Launcher: Build bei Bedarf, Server unsichtbar, Edge; ohne `claude`: `PARALLAX_BACKEND=fake` |
| `pnpm check` | typecheck (`tsc -b`) + lint + test – muss vor jedem Commit grün sein |
| `pnpm typecheck` / `lint` / `test` / `e2e` / `format` | Einzelschritte |
| `pnpm preflight` / `pnpm record <szenario>` | Umgebungscheck (WP-11) / Fixture-Recorder (WP-01) |

Eigene Pfade gezielt prüfen: `pnpm exec eslint <pfade>`, `pnpm exec vitest run <pfade>`.

## Ordner und Ownership (datei-genau; Details und Exporte: `docs/architecture.md` §2.1–2.3)
| Pfad | Inhalt | Owner |
|---|---|---|
| `src/shared/**` | Contracts (zod): `common`, `errors`, `status`, `model`, `protocol`, `sync`, `http`, `paths`, `build`, `samples`, `product` | Koordinator (eingefroren) |
| `src/server/**/ports.ts`, `src/server/backend/{types,fixture}.ts` | Server-Ports | Koordinator (eingefroren) |
| `src/server/lib/{logger,ids,paths}.ts` | Logger, `newId`, Pfad-Helfer (fs-Prüfungen auf `@shared/paths`) | WP-10 |
| `src/server/lib/{process,windows,registry,edge}.ts` | Spawn/`killProcessTree`, `searchPath`/`resolveExecutable`, Registry-Env, `findEdge` | WP-11 |
| `src/server/lib/{async,fs,homeLock,homeAccess}.ts` | `toError`/`sleep`, `withFsRetry`/`writeFileAtomic`, Home-Lock (Exit 5), Home-Rechte-Warnung | Koordinator (R2-Fixes) |
| `src/server/config.ts`, `src/server/{http,sync,store}/` | Config, App, Auth, HTTP/WS, Sync, Stores | WP-10 |
| `src/server/claude/` | resolveClaude, buildEnv, parseProfileArgs, Profil „Standard“, Preflight | WP-11 |
| `src/server/sessions/{normalizer,status}/` | Normalizer, Statusmaschine | WP-12 |
| übrige Dateien in `src/server/{sessions,backend}/` | Manager, Broker, Fake-/SdkBackend | WP-13 |
| `src/server/main.ts`, `src/server/app/` / `src/server/launcher/` | Einstieg + Komposition (`compose.ts`) / Launcher, Lockfile | WP-20 / WP-21 |
| `src/web/{shell,ui,lib,state,i18n,playground}/`, `App.tsx`, `main.tsx`, `index.css` | Shell + Slots, Primitives, Stores, Auth-Client, i18n-Kern | WP-14 (Welle 1b: nur lesen) |
| `src/web/features/transcript/` | Transkript inkl. eigenem `i18n/`, `playground.tsx` | WP-15 |
| `src/web/features/{decisions,composer}/` | Entscheidungen, Composer (dito) | WP-16 |
| `scripts/`, `test/`, `e2e/` | `preflight.ts` WP-11, Recorder + Fixtures WP-01, E2E WP-20, `test/setup` Koordinator | siehe Inhalt |
| Root-Configs, `package.json`, Lockfile | Bootstrap | Koordinator |

- Keine Datei wird von zwei Paketen bearbeitet; nichts in fremden Ordnern anlegen. `README.md` von
  Ordnern mit mehreren Ownern (`src/server`, `server/lib`, `server/sessions`, `server/backend`,
  `src/web`, `web/features`) pflegt der Koordinator.
- Features importieren einander nie: gemeinsame Komponenten (`DecisionCard`, `Markdown`,
  `ToolInputPreview`) über `FeatureSlots` (`src/web/shell/slots.tsx`), verdrahtet in WP-20.
  Wörterbücher je Feature in `features/<f>/i18n/{en,de}.ts` (Stubs von WP-14).
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
- Immer mit `PARALLAX_HOME=<tmp>` und `PARALLAX_PORT=0` (setzt `test/setup` automatisch, falls
  nicht gesetzt). Nie das echte `%LOCALAPPDATA%\Parallax` anfassen – auch nicht im Dev-Modus.
- **Kein Live-`claude`** (kein `pnpm dev:live`, kein `record`, kein SdkBackend-Test), außer das WP
  erlaubt es ausdrücklich. Standard ist das FakeBackend mit Fixtures.
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
  und ohne Shell (Argument-Array). Nie `cmd /c start`. Nur **absolute `.exe`-Pfade** starten
  (`resolveExecutable` aus `lib/windows.ts`), nie nackte Namen wie `git` – sonst gewinnt das `cwd`.
- Gestartete Hintergrundprozesse (Dev-Server, Vite, Tests) am Ende immer beenden.
- **Session-Variablen der aufrufenden Claude-Session** (`CLAUDECODE`, `CLAUDE_CODE_*`,
  `CLAUDE_PID`, `CLAUDE_EFFORT`, `CLAUDE_AGENT_SDK_*`, `AI_AGENT`, Hook-Marker …) dürfen nie in gestartete
  `claude`-Prozesse lecken: Env immer über `buildEnv()` bauen (Review C.2).

## Sprache
- Doku (README, `docs/**`, CLAUDE.md, WP-Aufträge/-Berichte) und Commit-Messages: **Deutsch**.
- Code-Bezeichner und Code-Kommentare: **Englisch**. Logs und `pnpm preflight`: Englisch.
- UI zweisprachig: Englisch (Default) und Deutsch.

## Git
- Lokale Commits pro WP (Worktree-Branch `wp/xx`), Merge macht der Koordinator. **Niemals pushen**,
  kein Remote anlegen.
- Commit-Messages mit mehreren `-m`-Flags, **kein Heredoc**, keine Command-Substitution.
- Worktrees liegen in `.worktrees/` (ignoriert, von tsconfig/Vitest/ESLint/Vite ausgeschlossen);
  pro Worktree `pnpm install --frozen-lockfile`. `core.longpaths` ist gesetzt.

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
