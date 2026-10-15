# Fortschritt Phase 1 (Durchstich)

Kritischer Pfad: 00 → 01 → 02 → 12 → 13 → 20 → 22. Aufträge und Ergebnisse: `docs/wp/WP-xx.md`.

Status: `offen` · `läuft` · `fertig` · `teilweise` · `blockiert`

## Arbeitspakete
| WP | Inhalt | Abhängig | Status | Commit | Ergebnis (eine Zeile) | Follow-ups |
|---|---|---|---|---|---|---|
| 00 | Bootstrap: Configs, pnpm-workspace, tsconfig-Referenzen, ESLint/Prettier, Vitest, Vite-Proxy, Tailwind + shadcn-Basis, Gerüst, alle Phase-1-Deps | – | fertig | `07fb0cf` | Gerüst lauffähig, `pnpm check`/`build` grün, keine SDK-Plattform-Binaries | React 19.3.1 nachziehen (≥ 24 h), ESLint 10/TS 7 sobald Plugins bereit; siehe WP-00.md |
| 01 | SDK-Spike + Recorder: `scripts/record`, Fixtures, `docs/sdk-findings.md` (live, Haiku) | 00 | fertig | `df4baa2` | Abo-Auth über SDK ok (`apiKeySource: none`), 12 Fixtures, Findings zu allen 17 Punkten; 13 Sessions, ~0,22 USD geschätzt | WP-11: echte `buildEnv()`, `.cmd`-Shim-Test, `scripts/README.md` um Recorder ergänzen; WP-13: Spawn-Wrapper muss stderr lesen; Spike-Transkripte/Scratch-Ordner liegen noch (Liste in Findings) |
| 02 | Contracts: `src/shared/{protocol,model,errors,status}` (zod), `AgentBackend`, `architecture.md`, CLAUDE.md v1 | 01 | fertig | `6d02d1a` (Design), `5282c16` | Contracts v1 eingefroren (`src/shared/*` + Server-Ports), `architecture.md`, CLAUDE.md v1, Build-ID; 433 Tests | Verweise auf `format.ts` in Findings/Fixture-README umstellen; Server-READMEs um Ports ergänzen; WP-10/14 nutzen `BUILD_ID` |
| 10 | Server-Plattform: App, Config, Auth, HTTP/WS, Sync (Seq, Ringpuffer), `JsonStore`, Logger | 02 | fertig | `b594f55`, Merge `c0c978e` | Fastify-App, Auth (Code→Cookie HMAC, Launcher-Code), Origin/Host/Sec-Fetch-Site auch beim WS-Upgrade, CSP, SyncHub (Seq, Ringpuffer, Drosselung, Idempotenz), JsonStore + Stores, pino mit Redaction; 159 Tests | Contract: `ROUTE_NOT_FOUND`, Port-Kommentar `createSyncHub({source, instance})`; `DEV_WEB_PORT` in importfreies Shared-Modul (Vite-Loader-Warnungen); `@fastify/cookie` entfernen; lib/README ergänzen |
| 11 | Claude-Integration: `resolveClaude`, Env-Builder, Profil „Standard“, `pnpm preflight` | 02 | fertig | `ef67969`, Merge `04b04b8` | resolveClaude (PATH×PATHEXT im Prozess, .cmd-Shim, .old ignoriert), buildEnv, Profil „Standard“, parseProfileArgs, parseAuthStatus, Versionsregel, lib/process, Preflight live ok; Recorder nutzt buildEnv; 977 Tests | R1-Fixes: dauerhaft gesetzte Env-Variablen (Registry) in buildEnv erhalten (Nexus, ADR), `findEdge` nach `lib/`, architecture §2.2 + lib/README um process-Exporte ergänzen |
| 12 | Normalizer + Status: zwei Adapter, Snapshots aller Fixtures, `deriveDisplayStatus` | 01, 02 | fertig | `ae06b26`, Merge `67da537` | Live- + Verlaufs-Adapter mit identischen Items, Kappung, Context-Schätzung, `reduceStatus`, Datei-Snapshots über alle Fixtures; 224 Tests | Contract: `context_estimate.contextWindow: number\|null`, `HistoryMessage.origin`, Kommentar `session_id`-Signal, architecture §6; Hinweise für WP-13 in WP-12.md (registerPrompt vor send, Reset-Reihenfolge, mergeByTime …) |
| 14 | Web-Shell + State: WS-Client mit Resync, Stores, Theme, i18n-Kern, Playground-Route | 02 | fertig | `af09e89`, Merge `0492779` | WS-Client mit Resync/Reconnect, Stores + Hooks (§10.3), i18n en/de mit `tError`, Theme, 27 UI-Primitives, Shell mit FeatureSlots, Playground (`pnpm dev:web` → `#playground`); 94 Web-Tests | Vite-Watcher ignoriert im Worktree alle Dateien (Ignore-Muster wurzelrelativ machen); `src/web/README.md` um shell/playground ergänzen; Chunk > 500 kB |
| 13 | Session-Engine: FakeBackend, Broker, Manager, SdkBackend | 11, 12 | fertig | 13a `6945574`, 13c `8f9ca67`/`eca2fc8`, 13b `b859a3f` (Merge `02634d2`); Design `d79305d` | FakeBackend (alle Fixtures), Broker, SdkBackend (gemockt), SessionManager mit virtueller Uhr, Recovery, Retry, Shutdown; 2434 Tests gesamt | Verdrahtung WP-20 laut WP-13b.md; Live-Prüfpunkte für WP-22 in WP-13b.md/WP-13c.md |
| 15 | Transkript-Renderer: Streaming-Markdown, Diff, Bash, Fallback, virtualisierte Liste | 14 | fertig | `db121a2`, Merge `5b6a06b` | Virtualisierte Liste, react-markdown mit Block-Memo (skipHtml, nur http(s), Bilder nie geladen), Shiki mit Token-Theme lazy, Diff, Bash/ANSI, Read/Grep, System-Items, Plan-Karte Variante A; 52 Tests | WP-20: `TRANSCRIPT_SLOTS` einbinden; Wunsch: `Disclosure`/`CodeBlock`/`DiffView` nach `ui/`, virtua-Stub nach `test/setup`; doppelte Queue-Anzeige 15/16 klären |
| 16 | Entscheidungen + Composer: Karten, Leiste, Queue, Stop, Entwürfe, Picker, Gauge | 14 | fertig | `8202dbe`, Merge `75842e7` | DecisionBar (einzige bedienbare Instanz, Mod+Enter nur mit Fokus, 600 ms Sperre), Karten Permission/Frage/Plan, PlanSidePanel, Composer (Enter = Ablehnung/Feedback, nie Freigabe), Mode-/Model-Picker, Gauge; 89 Tests | WP-20: Slots setzen; Wunsch WP-14: Label „Manual/Manuell“, Shortcut-Hilfe Mod+Enter; `autoCompactThreshold` als Token-Zahl dokumentieren |
| 20 | Integration + E2E: Verdrahtung, Playwright (msedge) auf FakeBackend | 10–16 | offen | – | – | – |
| 21 | Betrieb/Launcher: unsichtbarer Start, Lock + Health-Ping, Edge-Profil, `/auth`-Cookie, „Server beenden“ | 10 | fertig | `15e16cf`, Merge `5c1bf1f` | Launcher (`src/server/launcher`): Single-Instance über Lockfile + Health, Build nur ohne laufenden Server, detached Start, Code über `/api/launcher/code`, Edge-App mit eigenem Profil, Exit-Codes 3/4/5, `parallax.cmd/.ps1`, Menü „Server beenden“ mit Rückfrage; `pnpm start` → Launcher (`0f553bd`) | Verdrahtung in WP-20 (siehe Sammelliste) |
| 22 | Live-Abnahme: Phase-1-Checks gegen echtes `claude`, Screenshots | 20, 21 | offen | – | – | – |
| R0 | Review nach WP-00…02 (Konventionen, Duplikate, i18n, Importgrenzen, Sicherheit) | 02 | fertig | `289a9ac` (Review), `3c324dc` (Fixes) | 30 Befunde (6 BLOCKER, 6 SOLLTE, 18 NIT); alle BLOCKER/SOLLTE behoben: HTTP-/Auth-Contract, `@shared/paths`, dateigenaue Ownership, Statusregeln, `needs-resume`; 553 Tests | NIT R0-22 (ESLint-Meldung shared), R0-23 (`assertNotRealHome` Präfix), R0-24 (`ws` → devDeps?) in R1-Fixes (Koordinator-Freigabe Root-Configs); R0-25 nach WP-11 in R1 |
| R1 | Review nach Welle 1a (10, 11, 12, 14) | Welle 1a | fertig | `3da4675`/`b8d928f` (Server), `a95a83f` (Web), V1 `1ab3cdd` | R1 Server 22 Befunde (1 BLOCKER: Auth-Bypass per `%xx`-Pfad), R1 Web 26 (3 BLOCKER), V1 15 (1 BLOCKER: WS ohne `Sec-Fetch-Site` abgelehnt) | `fix/r1-web` gemergt (`a158884`): Watcher wurzelverankert, Selektoren, Variante A, Notices, Feature-Grenzen, Code-Splitting; `fix/r1-server` gemergt (`b2978a5`): Guard nach Route (ADR-018), WS ohne Pflicht-`Sec-Fetch-Site` (ADR-019), Start-Abbruch bei neuerer `schemaVersion` (ADR-020), buildEnv ohne `AI_AGENT` + Registry-Ausnahme (ADR-021), nur absolute `.exe`; 1666 Tests | R1-15 Speicher, R1-17 lstat offen (später) |
| R2 | Review nach Welle 1b (13, 15, 16) | Welle 1b | läuft: Web fertig (`a251a18`, 0 BLOCKER/7 SOLLTE/14 NIT), Fixes gemergt (`632e7ed`, Merge `2c95b2c`: Ziel-Sperre ADR-040, Warteschlange ADR-041, Picker ADR-042, Labels ADR-043, `ui/disclosure`); Teil Server nach 13b | – | – | – |
| R3 | Review nach Welle 2/3 + `/code-review` | 20–22 | offen | – | – | – |

## Contract-Changelog
Änderungen an `src/shared/**` (nur nach Freigabe durch den Koordinator).

| Datum | WP | Änderung |
|---|---|---|
| 15.10.2026 | 00 | `src/shared/product.ts` angelegt: `PRODUCT_NAME = 'Parallax'`, `PRODUCT_ID = 'parallax'` (Produktname an genau einer Stelle). |
| 15.10.2026 | 02 | Contracts v1 eingefroren: `src/shared/{common,errors,status,model,protocol,sync,build,samples}.ts` und Server-Ports `backend/{types,fixture}.ts`, `sessions/ports.ts`, `sync/ports.ts`, `claude/ports.ts`. `PROTOCOL_VERSION 1`, Schema-Versionen 1, Transkript-Log `v1`. Fixture-Format nur noch in `backend/fixture.ts` (Recorder re-exportiert). Build-ID per `define` (ADR-013). „Regel merken“ mit vier Zielen, Server baut `updatedPermissions` (ADR-012). Patch-Schemas ohne Defaults. |
| 15.10.2026 | R0 | Additiv/Bugfix, `PROTOCOL_VERSION` und Schema-Versionen bleiben 1: neu `src/shared/http.ts` (HTTP-/Auth-Contract, Launcher-Code, Lockfile; ADR-015) und `src/shared/paths.ts` (Pfadregeln; ADR-017); Codes `LAUNCHER_TOKEN_INVALID`, `SESSION_HELD_ELSEWHERE`, 9 × `PROFILE_*` + `PROFILE_ARG_INVALID_REASONS`; Anzeige-Status `needs-resume` (ADR-016), `notificationFor` mit Art der neuen Entscheidung; `LIMITS` für Eingaben + `itemTotalChars`/`snapshotMaxChars`, `modelNameSchema`; `sessionInitInfo.permissionMode` nullable + tolerante Enum-Leser; `decisionRecord.decision`, `Entry.unread`/`context` (Defaults); `applyDelta` nur auf streamende Items; Ports: `StatusSignal` (`permissionMode` nullable, `turn_result.startupFailure`), `ReduceStatusContext`, `ParseProfileArgs`, `ProfileArgIssueParams`, Regelkommentare. |
| 15.10.2026 | R1 | Additiv, Versionen bleiben 1: Codes ROUTE_NOT_FOUND, PROMPT_NOT_DELIVERED, STORE_VERSION_TOO_NEW (+ Texte en/de); Ports: StatusSignal.context_estimate.contextWindow, HistoryMessage.origin?, BackendSessionInfo.firstPrompt, DecisionStore.flush(), Kommentare session_id/createSyncHub/Plan-Version je Eintrag; HTTP-Guard nach Route (ADR-018), WS ohne Pflicht-Sec-Fetch-Site (ADR-019), Start-Abbruch bei neuerer schemaVersion (ADR-020); architecture §2.2/§5.1/§6/§8/§9. Neu `src/shared/devPorts.ts` (DEV_WEB_PORT importfrei, ADR-03x). |
| 15.10.2026 | R2 | Additiv, Werte unverändert: `LIMITS.decisionMessageChars` (10 000), `LIMITS.planFeedbackChars` (50 000) in `common.ts`; Antwort-Schemas in `model.ts` nutzen sie; Kommentar `autoCompactThreshold` = Token-Zahl (ADR-045). |

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

## Überholte Plan-Stellen (Rangfolge: Contracts/`architecture.md`/ADRs > `sdk-findings.md` > `plan.md`)
- C.5 „`new_conversation_id` als Session-ID“ → Session-ID aus dem nächsten `init` (Findings F.7).
- A.3 „`getSessionMessages` ohne Timestamps“ → Timestamps vorhanden (F.15); `tool_use_result` fehlt weiterhin.
- A.3 Pfad `entries/<id>/transcript.jsonl` → `entries/<id>/<conversationId>.transcript.jsonl`.
- „Immer erlauben = `suggestions`“ → vier Ziele, Server baut `updatedPermissions` (ADR-012).
- WP-02 §9.5/§10.1/§13 sind durch `architecture.md` §2.2 und ADR-013 überholt.
- Koordinator-Entscheidungen 15.10.2026: Launcher-Code über Lockfile-Token (ADR-015);
  `interrupted` mit abgelaufener Karte zählt zu „Wartet auf dich“ (`needs-resume`, ADR-016);
  `parseProfileArgs` als reine Funktion schon in WP-11, ohne UI.
- Koordinator-Entscheidungen R2 (15.10.2026): Enter bei offener Entscheidung mit Ziel-Sperre (Variante B,
  nur die beim Entwurfsbeginn offene Entscheidung); Warteschlange nur im Transkript + Badge in der Kopfzeile;
  Modus/Modell bedienbar im Composer, Kopfzeile nur Status; Label „Manual/Manuell“ für `default`.

## Freigegebene Contract-Wünsche (umgesetzt in den R1-Fixes, `b2978a5`/`a158884`)
- `errors.ts`: `ROUTE_NOT_FOUND` (WP-10), `PROMPT_NOT_DELIVERED` (WP-13).
- `sessions/ports.ts`: `context_estimate.contextWindow: number | null`; Kommentar zum `session_id`-Signal (WP-12).
- `backend/types.ts`: `HistoryMessage.origin` (WP-12), `BackendSessionInfo.firstPrompt` (WP-13).
- `sync/ports.ts`: `DecisionStore.flush()` (WP-13); Port-Kommentar `createSyncHub({source, instance})` (WP-10).
- `model.ts`: Kommentar „Plan-Versionen zählen je Eintrag“ (WP-13).
- `DEV_WEB_PORT` in ein importfreies Shared-Modul (Vite-Loader-Warnungen, WP-10).
- `architecture.md`: §6 (rejected → `assistant_error`, Reset-Marker nach `startConversation`), §8 `processes.json`, §2.2 + `lib/README` um `lib/process`-Exporte.
- WP-12-Dateien: `capText`/`capInput` aus `normalizer/index.ts` re-exportieren; `lib/process.ts`: optional `childProcesses()`.
- Koordinator-Entscheidungen: Auto-Retry nur nach Absturz im Leerlauf (A.10, max. 3, Backoff);
  `buildEnv` erhält Variablen, die dauerhaft in HKCU/HKLM `Environment` gesetzt sind (Nexus); `findEdge` nach `lib/`.

## WP-13 Aufteilung (Design `d79305d` auf `wp/13`, `docs/wp/WP-13.md`)
13a FakeBackend + Broker + Basismodule/Test-Doubles und 13c SdkBackend parallel; 13b SessionManager nach Merge von 13a.

## Sammelliste für WP-20 (Verdrahtung + E2E)
- Slots: `TRANSCRIPT_SLOTS` (WP-15) und `{DecisionBar, DecisionCard, SidePanel: PlanSidePanel, Composer}` (WP-16) in `APP_SLOTS`.
- i18n-Namespace `serverShutdown` in `src/web/i18n/index.ts` registrieren (WP-21 nutzt bis dahin `useShutdownT`).
- Server-`main.ts`: nach `listen` `writeServerLock` (tatsächlicher Port, `auth.launcherToken`); `onShutdownRequested` →
  `shutdown.stop('command')` mit Engine-Shutdown (13b); Signale; Exit 4 bei EADDRINUSE, Exit 3 bei `StoreVersionTooNewError`.
- Backend nach `--backend`: `createFakeBackend` (Default dev/E2E) bzw. `createSdkBackend()` (SDK nur dann dynamisch laden), `dispose()` beim Shutdown.
- E2E (Playwright `msedge`, FakeBackend): Permission-, Frage-, Plan-Flow, Stop, Reload mit offener Karte, „Server beenden“.
- Doku: CLAUDE.md/README „Installation und Start“, `src/web/shell/README.md`, architecture §5.1 (h) (Launcher holt Code auch beim ersten Start über `/api/launcher/code`).
- Engine (13b): `openProcessStore` (Exit 3 bei `StoreVersionTooNewError`), `attachPublisher` vor `start()`, `warnings.onChange`/`checkProfile` → `publishHostState`, Stop-Reihenfolge `manager.shutdown()` → `app.close()` → Stores schließen.
- Bekannt: Bis zur Verdrahtung endet ein echter `pnpm start` nach 30 s mit Zeitüberschreitung (Bootstrap-Stub).
- Offen für später: `processInfo` per PowerShell braucht unter Last bis ≈23 s (Waisen-Bereinigung beim Start) – schnellere Methode prüfen; Web-Default-Timeout in Vitest statt Limits je Datei; Importkosten `radix-ui` in Tests.

## Nächste Schritte
1. Erledigt: WP-21, Flake-Fix-Runde (`89ad9bb`, `docs/wp/FLAKES.md`). R2-Web-Fixes gemergt. Läuft: WP-13b. Danach R2 Server, R2-Fixes, WP-20 (Verdrahtung + E2E), V2, WP-22 (Live-Abnahme).
2. Danach Welle 1a (10, 11, 12, 14) in Worktrees `.worktrees/wp-xx`
   auf Branches `wp/xx`, jeweils `pnpm install --frozen-lockfile` im Worktree.
3. Nach ≥ 24 h: `react`/`react-dom` 19.3.1 prüfen und nachziehen (Koordinator, siehe WP-00.md).
