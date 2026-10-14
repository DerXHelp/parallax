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
| `pnpm dev:live` | wie `dev`, aber SdkBackend (echtes `claude`) – nur mit WP-Freigabe |
| `pnpm build` | `dist/web` (Vite) + `dist/server.js` (esbuild) |
| `pnpm start` | Build + `node dist/server.js` (Launcher folgt in WP-21) |
| `pnpm check` | typecheck (`tsc -b`) + lint + test – muss vor jedem Commit grün sein |
| `pnpm typecheck` / `lint` / `test` / `e2e` / `format` | Einzelschritte |
| `pnpm preflight` / `pnpm record <szenario>` | Umgebungscheck (WP-11) / Fixture-Recorder (WP-01) |

Eigene Pfade gezielt prüfen: `pnpm exec eslint <pfade>`, `pnpm exec vitest run <pfade>`.

## Ordner und Ownership
| Pfad | Inhalt | Owner |
|---|---|---|
| `src/shared/` | Contracts: protocol, model, errors, status (zod), `product.ts` | WP-02 (eingefroren) |
| `src/server/lib/` | Logger, Pfad-/Prozess-Helfer | WP-10/11 |
| `src/server/{http,sync,store}/` | App, Auth, HTTP/WS, Sync, JsonStore, Registry | WP-10 |
| `src/server/claude/` | resolveClaude, buildEnv, Profil „Standard“, Preflight | WP-11 |
| `src/server/sessions/` | Normalizer + Status (12), Manager + Broker (13) | WP-12/13 |
| `src/server/backend/` | FakeBackend, SdkBackend | WP-13 |
| `src/server/main.ts`, `bootstrap.ts` | Einstieg / temporärer Stub | WP-20 |
| `src/web/{ui,lib,i18n,state}/`, `App.tsx`, `main.tsx` | Shell, Primitives, i18n, Stores | WP-14 |
| `src/web/features/` | Transkript (15), Entscheidungen + Composer (16) | WP-15/16 |
| `scripts/`, `test/fixtures/sdk/`, `e2e/` | Werkzeuge, Fixtures, E2E | WP-01/11/20/21 |
| Root-Configs, `package.json`, Lockfile | Bootstrap | WP-00 / Koordinator |

Jeder Ordner hat eine `README.md` mit Details. Aliase: `@shared/*` (überall), `@web/*` (nur Web).

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

## Tabu ohne Freigabe
`package.json`, `pnpm-lock.yaml`, `pnpm-workspace.yaml` und `src/shared/**`. Änderungswünsche
(neue Abhängigkeit, Contract-Änderung) im Bericht unter „GEWÜNSCHTE ABHÄNGIGKEITEN“ bzw.
„SCHNITTSTELLEN/CONTRACT-ABWEICHUNGEN“ anfragen. Nichts außerhalb der eigenen Besitz-Pfade ändern.

## Windows
- Pfade nur über den Pfad-Helfer (case-insensitiv vergleichen, `cwd`-String exakt behalten,
  UNC/Device/ADS vor jedem Dateizugriff ablehnen).
- Prozessbäume mit `taskkill /PID <pid> /T /F` beenden; **jeder** Spawn mit `windowsHide: true`
  und ohne Shell (Argument-Array). Nie `cmd /c start`.
- Gestartete Hintergrundprozesse (Dev-Server, Vite, Tests) am Ende immer beenden.
- **Session-Variablen der aufrufenden Claude-Session** (`CLAUDECODE`, `CLAUDE_CODE_*`,
  `CLAUDE_PID`, `CLAUDE_EFFORT`, `CLAUDE_AGENT_SDK_*` …) dürfen nie in gestartete
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
- `docs/plan.md` – abgestimmter Plan (bei Widersprüchen gilt „Änderungen nach kritischem Review“).
- `docs/progress.md` – WP-Tabelle, Contract-Changelog, offene Fragen, nächste Schritte.
- `docs/decisions.md` – ADRs (nur anhängen). `docs/architecture.md` – Architektur (ab WP-02).
- `docs/wp/WP-xx.md` – Auftrag und Ergebnis je Arbeitspaket. `docs/sdk-findings.md` (WP-01).
