# Architektur

> Platzhalter. Wird in **WP-02 (Contracts)** gefüllt: Module, Datenfluss,
> Source-of-Truth-Tabelle, Sync-Protokoll, `AgentBackend`-Interface.

Bis dahin gilt `docs/plan.md` (Grundarchitektur, Server-Bausteine und „Änderungen nach kritischem
Review“). Das Ordnergerüst und die Ownership stehen in `CLAUDE.md` und den `README.md`-Dateien
der Ordner.

## Stand nach WP-00 (Gerüst)
- `src/shared` – isomorphe Contracts (composite-Projekt, Deklarationen nach `.tsbuild/shared`).
- `src/server` – Node-Server; `main.ts` → `dist/server.js` (esbuild, npm-Pakete extern).
- `src/web` – Vite-Root; Build nach `dist/web`; Dev-Proxy `/api` (HTTP + WS) → Port 4712.
- Import-Grenzen: Web ↛ Server, Server ↛ Web, Shared ↛ beide (tsconfig `rootDir` + ESLint).
