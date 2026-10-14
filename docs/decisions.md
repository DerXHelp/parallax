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
