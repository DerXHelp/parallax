# Fortschritt Phase 1 (Durchstich)

Kritischer Pfad: 00 → 01 → 02 → 12 → 13 → 20 → 22. Aufträge und Ergebnisse: `docs/wp/WP-xx.md`.

Status: `offen` · `läuft` · `fertig` · `teilweise` · `blockiert`

## Arbeitspakete
| WP | Inhalt | Abhängig | Status | Commit | Ergebnis (eine Zeile) | Follow-ups |
|---|---|---|---|---|---|---|
| 00 | Bootstrap: Configs, pnpm-workspace, tsconfig-Referenzen, ESLint/Prettier, Vitest, Vite-Proxy, Tailwind + shadcn-Basis, Gerüst, alle Phase-1-Deps | – | fertig | `07fb0cf` | Gerüst lauffähig, `pnpm check`/`build` grün, keine SDK-Plattform-Binaries | React 19.3.1 nachziehen (≥ 24 h), ESLint 10/TS 7 sobald Plugins bereit; siehe WP-00.md |
| 01 | SDK-Spike + Recorder: `scripts/record`, Fixtures, `docs/sdk-findings.md` (live, Haiku) | 00 | fertig | `df4baa2` | Abo-Auth über SDK ok (`apiKeySource: none`), 12 Fixtures, Findings zu allen 17 Punkten; 13 Sessions, ~0,22 USD geschätzt | WP-11: echte `buildEnv()`, `.cmd`-Shim-Test, `scripts/README.md` um Recorder ergänzen; WP-13: Spawn-Wrapper muss stderr lesen; Spike-Transkripte/Scratch-Ordner liegen noch (Liste in Findings) |
| 02 | Contracts: `src/shared/{protocol,model,errors,status}` (zod), `AgentBackend`, `architecture.md`, CLAUDE.md v1 | 01 | fertig | `6d02d1a` (Design), `5282c16` | Contracts v1 eingefroren (`src/shared/*` + Server-Ports), `architecture.md`, CLAUDE.md v1, Build-ID; 433 Tests | Verweise auf `format.ts` in Findings/Fixture-README umstellen; Server-READMEs um Ports ergänzen; WP-10/14 nutzen `BUILD_ID` |
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
| 15.10.2026 | 02 | Contracts v1 eingefroren: `src/shared/{common,errors,status,model,protocol,sync,build,samples}.ts` und Server-Ports `backend/{types,fixture}.ts`, `sessions/ports.ts`, `sync/ports.ts`, `claude/ports.ts`. `PROTOCOL_VERSION 1`, Schema-Versionen 1, Transkript-Log `v1`. Fixture-Format nur noch in `backend/fixture.ts` (Recorder re-exportiert). Build-ID per `define` (ADR-013). „Regel merken“ mit vier Zielen, Server baut `updatedPermissions` (ADR-012). Patch-Schemas ohne Defaults. |

## Offene Fragen an den Nutzer
- Keine offenen Fragen.
- Erledigt (15.10.2026): Live-Freigabe für WP-01 erteilt (Haiku, Mini-Prompts, Scratch-Ordner,
  Abo-Login, kein API-Key). Bei Auth-Fehler/`credits_required` sofort stoppen und melden.

## Wichtige Befunde aus WP-01 (Details: `docs/sdk-findings.md`)
- „Immer erlauben“ darf nicht pauschal alle `suggestions` zurückgeben: Das schaltet die Session in
  `acceptEdits` und schreibt Regeln in `localSettings`. Optionen getrennt anbieten.
- Ohne `permissionMode` startet die Session hier in `default` (nicht `auto`).
- `getSessionMessages` liefert Timestamps, aber kein `tool_use_result`; `CLAUDE_CONFIG_DIR` wird pro
  Aufruf gelesen (Worker isoliert).
- Session-ID nach `/clear` kommt aus dem nächsten `init`, nicht aus `new_conversation_id`.
- Untypisierte Messages: `command_lifecycle`, `system/session_title_changed`.
- Plan-Modus mit Haiku plant auf einem anderen Modell (Sonnet) → Modell pro Assistant-Message zeigen.

## Nächste Schritte
1. R0 (Review WP-00…02, Schwerpunkt Contracts) vor Welle 1a, danach Fixes inkl. Doku-Follow-ups.
2. Danach Welle 1a (10, 11, 12, 14) in Worktrees `.worktrees/wp-xx`
   auf Branches `wp/xx`, jeweils `pnpm install --frozen-lockfile` im Worktree.
3. Nach ≥ 24 h: `react`/`react-dom` 19.3.1 prüfen und nachziehen (Koordinator, siehe WP-00.md).
