# Fortschritt Phase 1 (Durchstich)

Kritischer Pfad: 00 → 01 → 02 → 12 → 13 → 20 → 22. Aufträge und Ergebnisse: `docs/wp/WP-xx.md`.

Status: `offen` · `läuft` · `fertig` · `teilweise` · `blockiert`

## Arbeitspakete
| WP | Inhalt | Abhängig | Status | Commit | Ergebnis (eine Zeile) | Follow-ups |
|---|---|---|---|---|---|---|
| 00 | Bootstrap: Configs, pnpm-workspace, tsconfig-Referenzen, ESLint/Prettier, Vitest, Vite-Proxy, Tailwind + shadcn-Basis, Gerüst, alle Phase-1-Deps | – | fertig | Initial-Commit auf `main` („WP-00: Projektgerüst und Abhängigkeiten“) | Gerüst lauffähig, `pnpm check`/`build` grün, keine SDK-Plattform-Binaries | React 19.3.1 nachziehen (≥ 24 h), ESLint 10/TS 7 sobald Plugins bereit; siehe WP-00.md |
| 01 | SDK-Spike + Recorder: `scripts/record`, Fixtures, `docs/sdk-findings.md` (live, Haiku) | 00 | offen | – | – | – |
| 02 | Contracts: `src/shared/{protocol,model,errors,status}` (zod), `AgentBackend`, `architecture.md`, CLAUDE.md v1 | 01 | offen | – | – | – |
| 10 | Server-Plattform: App, Config, Auth, HTTP/WS, Sync (Seq, Ringpuffer), `JsonStore`, Logger | 02 | offen | – | – | – |
| 11 | Claude-Integration: `resolveClaude`, Env-Builder, Profil „Standard“, `pnpm preflight` | 02 | offen | – | – | – |
| 12 | Normalizer + Status: zwei Adapter, Snapshots aller Fixtures, `deriveDisplayStatus` | 01, 02 | offen | – | – | – |
| 14 | Web-Shell + State: WS-Client mit Resync, Stores, Theme, i18n-Kern, Playground-Route | 02 | offen | – | – | – |
| 13 | Session-Engine: FakeBackend, Broker, Manager, SdkBackend | 11, 12 | offen | – | – | – |
| 15 | Transkript-Renderer: Streaming-Markdown, Diff, Bash, Fallback, virtualisierte Liste | 14 | offen | – | – | – |
| 16 | Entscheidungen + Composer: Karten, Leiste, Queue, Stop, Entwürfe, Picker, Gauge | 14 | offen | – | – | – |
| 20 | Integration + E2E: Verdrahtung, Playwright (msedge) auf FakeBackend | 10–16 | offen | – | – | – |
| 21 | Betrieb/Launcher: unsichtbarer Start, Lock + Health-Ping, Edge-Profil, `/auth`-Cookie, „Server beenden“ | 10 | offen | – | – | – |
| 22 | Live-Abnahme: Phase-1-Checks gegen echtes `claude`, Screenshots | 20, 21 | offen | – | – | – |
| R0 | Review nach WP-00…02 (Konventionen, Duplikate, i18n, Importgrenzen, Sicherheit) | 02 | offen | – | – | – |
| R1 | Review nach Welle 1a (10, 11, 12, 14) | Welle 1a | offen | – | – | – |
| R2 | Review nach Welle 1b (13, 15, 16) | Welle 1b | offen | – | – | – |
| R3 | Review nach Welle 2/3 + `/code-review` | 20–22 | offen | – | – | – |

## Contract-Changelog
Änderungen an `src/shared/**` (nur nach Freigabe durch den Koordinator).

| Datum | WP | Änderung |
|---|---|---|
| 15.10.2026 | 00 | `src/shared/product.ts` angelegt: `PRODUCT_NAME = 'Parallax'`, `PRODUCT_ID = 'parallax'` (Produktname an genau einer Stelle). |

## Offene Fragen an den Nutzer
- Keine aus WP-00.
- Vor WP-01: einmalige Bestätigung des ersten Live-Aufrufs (Haiku, Mini-Prompts, Abo-Login),
  siehe `docs/plan.md`, „Antworten des Nutzers vor WP-00“, Punkt 3.

## Nächste Schritte
1. WP-01 (SDK-Spike + Recorder) beauftragen; vorher Live-Freigabe des Nutzers einholen.
2. Danach WP-02 (Contracts, Plan → GP), dann Welle 1a (10, 11, 12, 14) in Worktrees `.worktrees/wp-xx`
   auf Branches `wp/xx`, jeweils `pnpm install --frozen-lockfile` im Worktree.
3. Nach ≥ 24 h: `react`/`react-dom` 19.3.1 prüfen und nachziehen (Koordinator, siehe WP-00.md).
