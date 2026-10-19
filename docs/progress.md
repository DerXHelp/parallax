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
| 20 | Integration + E2E: Verdrahtung, Playwright (msedge) auf FakeBackend | 10–16 | fertig | 20a `64c11c8`, 20b `449e7bb`, 20c `20f0278` (Merge-Commits `13c83d6`, `7dd9429`, siehe Log) | Komposition `app/compose.ts`, Web-Verdrahtung, Home-Lock (Exit 5), SDK lazy; 24 E2E-Fälle in Edge (FakeBackend) grün, 5 Integrations-Bugs behoben | architecture §3.3 um Home-Lock ergänzen; eigenes `e2e/tsconfig.json` (lib DOM); Live-Prüfpunkte siehe WP-20c.md |
| 21 | Betrieb/Launcher: unsichtbarer Start, Lock + Health-Ping, Edge-Profil, `/auth`-Cookie, „Server beenden“ | 10 | fertig | `15e16cf`, Merge `5c1bf1f` | Launcher (`src/server/launcher`): Single-Instance über Lockfile + Health, Build nur ohne laufenden Server, detached Start, Code über `/api/launcher/code`, Edge-App mit eigenem Profil, Exit-Codes 3/4/5, `parallax.cmd/.ps1`, Menü „Server beenden“ mit Rückfrage; `pnpm start` → Launcher (`0f553bd`) | Verdrahtung in WP-20 (siehe Sammelliste) |
| 22 | Live-Abnahme: Phase-1-Checks gegen echtes `claude`, Screenshots | 20, 21 | fertig | `638a218`, Fixes `6e201ad` (Merge siehe Log) | Live gegen echtes `claude` 2.1.300, Abo (`apiKeySource: none`), Haiku; 6 Sessions/58 Requests ≈ 0,25 USD; Checkliste 33/43 ok, 7 Befund, 3 ungeprüft; 0 Contract-Abweichungen; Live-Smoke `e2e/live` (nur `PARALLAX_LIVE=1`) 2× 6/6; `docs/sdk-upgrade.md` | 0 BLOCKER/9 SOLLTE/6 NIT (WP22-01…15), u. a. Benachrichtigungen im Edge-App-Fenster nicht aktivierbar (WP22-03), Permission-Default springt auf `auto` (WP22-04, Nutzer-Entscheidung), KI-Titel nie übernommen (WP22-02); ungeprüft F3/F5/F6. **Fixes gemergt:** `PARALLAX_*`-Isolation (ADR-083), Herzschlag-Waisen inkl. Kinder (ADR-081), Shutdown 3,7 s (ADR-084), Edge-Freigabe für Benachrichtigungen bzw. nativer Toast (ADR-082), KI-Titel, Modell vor erstem Start; F3/F5 per E2E; Live-Nachprüfung ≈ 0,03 USD ok; 2683 Tests, 26 E2E |
| R0 | Review nach WP-00…02 (Konventionen, Duplikate, i18n, Importgrenzen, Sicherheit) | 02 | fertig | `289a9ac` (Review), `3c324dc` (Fixes) | 30 Befunde (6 BLOCKER, 6 SOLLTE, 18 NIT); alle BLOCKER/SOLLTE behoben: HTTP-/Auth-Contract, `@shared/paths`, dateigenaue Ownership, Statusregeln, `needs-resume`; 553 Tests | NIT R0-22 (ESLint-Meldung shared), R0-23 (`assertNotRealHome` Präfix), R0-24 (`ws` → devDeps?) in R1-Fixes (Koordinator-Freigabe Root-Configs); R0-25 nach WP-11 in R1 |
| R1 | Review nach Welle 1a (10, 11, 12, 14) | Welle 1a | fertig | `3da4675`/`b8d928f` (Server), `a95a83f` (Web), V1 `1ab3cdd` | R1 Server 22 Befunde (1 BLOCKER: Auth-Bypass per `%xx`-Pfad), R1 Web 26 (3 BLOCKER), V1 15 (1 BLOCKER: WS ohne `Sec-Fetch-Site` abgelehnt) | `fix/r1-web` gemergt (`a158884`): Watcher wurzelverankert, Selektoren, Variante A, Notices, Feature-Grenzen, Code-Splitting; `fix/r1-server` gemergt (`b2978a5`): Guard nach Route (ADR-018), WS ohne Pflicht-`Sec-Fetch-Site` (ADR-019), Start-Abbruch bei neuerer `schemaVersion` (ADR-020), buildEnv ohne `AI_AGENT` + Registry-Ausnahme (ADR-021), nur absolute `.exe`; 1666 Tests | R1-15 Speicher, R1-17 lstat offen (später) |
| R2 | Review nach Welle 1b (13, 15, 16) | Welle 1b | fertig: Web fertig (`a251a18`, 0 BLOCKER/7 SOLLTE/14 NIT), Fixes gemergt (`632e7ed`, Merge `2c95b2c`: Ziel-Sperre ADR-040, Warteschlange ADR-041, Picker ADR-042, Labels ADR-043, `ui/disclosure`); Teil Server fertig (`f6e9ab7`, 1 BLOCKER/4 SOLLTE/11 NIT), Fixes gemergt (`beda448`, Merge `61e8e1f`: Lockfile-Retry, Waisen-Prüfung dreiwertig, Bereitschaft mit Retry → `CLAUDE_CONTROL_FAILED`, `lib/homeLock` (Exit 5), `lib/{async,fs}`, ADR-050…056) | Nach WP-22: Herzschlag `aliveAt` + Kinder-Pfad (R2-03); Doku architecture §2.2/§8, `store/README`, WP-21-Beispiel, WP-13 §3.5.13 | – | – | – |
| R3 | Review nach Welle 2/3 + `/code-review` | 20–22 | fertig: R3 `5f15036`, V2 `e8c8935`; Fixes Web `3b266db` (Merge `3f00ac3`: Versionsanzeige, Frage-Karte Strg+Enter, Update-Ansicht), Server `a8e9a58` (Edge ohne Konto/Sync, Fake-Schutz, Build-ID aus Build-Eingaben + UI-Kopie je buildId, Doppelstart, Crash-Handler, CSP in `@shared/http`); 2612 Tests, 24 E2E | Offen (nach WP-22): Vite-Dev-CSP, Build-Lock in E2E-Setup, `PARALLAX_VALIDATE=throw` in E2E, V2-12/14/15, R3-10/17, `cliVersionStatus` nach `@shared` (Kopie in `web/lib/version.ts`). **`/code-review` (high, `323a52f..main`): 12 Funde, alle reproduziert und behoben bzw. begründet** (`docs/wp/CODE-REVIEW.md`, ADR-090…094, Merge siehe Log); 2715 Tests, 26 E2E | – | – | – |

## Phase 2 „Mission Control“ – Arbeitspakete (Design: `docs/wp/WP-30.md`, Wellenplan §7)
Kritischer Pfad: 30 → 31 → 34 → 40 → R4/V3 → 41.

| WP | Inhalt | Welle | Abhängig | Status | Commit | Ergebnis (eine Zeile) | Follow-ups |
|---|---|---|---|---|---|---|---|
| 30 | Design, Contracts v2, Gerüst, Doku (ADR-100…119, Ownership Phase 2) | 0 | – | fertig | `7a3530f`, `0215740`, `52912ec`, Merge `1488b83` | Lückenanalyse, Aufträge WP-31…41, `PROTOCOL_VERSION` 2, Registry v2, Anfragekanal `shell/requests.ts`, Slots; 2778 Tests, 26 E2E | Hinweis an alle Pakete: PowerShell 5.1 zerstört Umlaute bei `Get-Content`/`WriteAllText` |
| 31 | Engine: Lebenszyklus, Archiv, Unterhaltungen, Einstellungs-Wirkung | 1 | 30 | fertig | `7848648`, Merge `67f77bb` | Leerlauf-Schlaf (ab `sleepSince`), Archiv/Pin, `switchConversation`, Fast-Modus, Git-Branch persistent, Slash-/Modell-Kataloge + Abo-Limits persistent, Notifier-Regeln, Host-Befehls-Routing; 937 Tests sessions/backend | WP-40: Verdrahtung laut WP-31.md §2.4 (`openCatalogStore` Exit 3, `port`, `systemIntegration`, `hostCommands`, `onSettingsChanged`, `extraWarnings`); README `sessions` (Koordinator) |
| 32 | Profile und Claude-Integration | 1 | 30 | fertig | `0028d28`, Merge `69fa57d` | `profiles.json`-Store (ADR-102), Profil-Issues, Befehle `profile.*`, `consoleLaunchFor` + Kopierbefehl (PS 5.1 Legacy-Quoting), Preflight aller Profile; 587 Tests claude | WP-40: `store.close()` beim Beenden; README `claude` (Koordinator) |
| 33 | Host-Dienste, Upload, Ordner-Browser, Windows-Integration, Launcher | 1 | 30 | fertig | `5eaae42`, `769426c` (Hub-Test 415), Merge `67f77bb` | `fs.listDirectory` (lstat je Segment, R1-17), Upload mit Magic-Bytes, `system/` (Konsole via PowerShell, Autostart, `parallax:`-Handler, doppelter Testschutz), Port aus Settings, Launcher `--open` (letztes Arg); 576 Tests | Toast-Klick blitzt kurz eine Konsole auf (L8); WP-40/34 Verdrahtung laut WP-33.md; `lib/README` + architecture §2.2 (Koordinator) |
| 35 | Navigation: Sidebar, Strg+K, Kopfzeile, Fenster | 1 | 30 | fertig | `9361e51`, Merge `6cd45af` | Sidebar flach/gruppiert zweizeilig, Kontextmenü (+ Umschalt+F10), Inline-Umbenennen, Quick-Switcher, Alt+1..9/Alt+N, neues Fenster (`popup,noopener`), Frühere Unterhaltungen, Session-Info, Abo-Limits; `ui/{context-menu,command-list}`, `lib/fuzzy`; 73 neue Tests; 3213 Tests gesamt | READMEs `ui`/`shell` + architecture §2.3(l) (Koordinator); offener modaler Dialog blendet Hinweis-Region für Screenreader aus (R4); `server/lib/process.test.ts` Hook-Timeout unter Last |
| 34 | Engine: externe Konsole, Rate-Limit-Fortsetzen, Bild-Anhänge, Toast-Klick | 2 | 31 (32/33 Ports) | fertig | `f6fae4d`, Merge `aa7d6cd` | `openExternal`/Rückkehr mit Import der Konsolen-Turns/Serverstart (ADR-104), `continueAt` + `wakeup` mit Gnadenfrist (ADR-112), Bild-Anhänge als `image`-Blöcke (ADR-103), Toast mit Klick-URI und `silent` (ADR-109), `onProfileChanged` (ADR-102), Secrets nie geloggt; FakeBackend `fake:image`/`fake:ratelimit`/`simulateConsoleTurn`; 3256 Tests nach Merge | WP-40: Verdrahtung laut WP-34.md §2.4 (`consoleLauncher`, `systemIntegration`, `profileStore.onChange` → `onProfileChanged`); WP-41 (L7): Zeitstempel der Konsolen-Turns live prüfen |
| 36 | Neue Session, Ordner-Browser-UI, Profil-Editor | 2 | 30 | fertig | `f1af3e9`, Merge `5f0d0cf` (mit 37) | Dialog mit Pfadfeld, Ordner-Browser (`fs.listDirectory`), bis 8 zuletzt genutzten Projekten, Profilwahl (Default vorausgewählt, `session.create {cwd, profileId}`), Profil-Editor (Liste, Anlegen, Bearbeiten, Testen, Löschen mit Schutz, maskierte Secrets) als Slot `ProfilesSettings`; 68 eigene Tests | siehe Sammelliste Welle 2 |
| 37 | Composer und Transkript: Slash-Menü, Screenshots, Lightbox | 2 | 30, 35 | fertig | `0bca858`, Merge `5f0d0cf` (mit 36) | Slash-Menü (Fuzzy, native Befehle, Durchreichen, Terminal-Hinweis), Screenshots per Einfügen/Ziehen/Büroklammer mit Verkleinern, Upload und Chips, Ghost-Text, Rate-Limit-Banner, Composer gesperrt bei Konsole/Archiv, `ui/lightbox` (eine je Transkript, außerhalb der virtualisierten Liste), `handoff`-Zeile, Windows-Pfade (V2-12); 238 eigene Tests, Sichtprüfung dark/light × en/de | siehe Sammelliste Welle 2 |
| 38 | Einstellungen und Benachrichtigungen (Töne) | 2 | 30 | fertig | `7b94e76`, Merge `42b29af` | Einstellungsseite (Dialog, vertikale Tabs, sofort speichern mit Overlay und Rücknahme), `ui/slider`, fünf synthetisierte Töne (Web Audio, Unlock nach Interaktion), Zustellung mit `focusedElsewhere`/„Nicht stören“/`silent`, Menüeintrag „Einstellungen…“, `HostFacts`; 130 eigene Tests | siehe Sammelliste Welle 2 |
| 40 | Integration + E2E Phase 2 | 3 | 31–38 | fertig | `f106ec3`…`a61f813` (7 Commits), Merge `6373625` | Server-Verdrahtung (Profil-Store, Kataloge, Konsole, Systemintegration, Host-Befehle, Port, `onProfileChanged`), Web-Slots `PREFERENCES_SLOTS`/`ProfilesSettings`, V2-15; Integrationsfehler: neue Profile blieben auf `checking` (jetzt alle ungeprüften Profile prüfen); Fixes ADR-120 (Autoplay) und `openNewSession({cwd})`; 15 neue E2E-Fälle (41 gesamt, 2× grün, 1× unter Last); 3520 Tests | R4: Einstellungen/Profil-Editor im Start-Chunk (412 kB, `lazy()`), veraltete Kommentare „Optional until WP-40“ in `sessions/manager.ts`; V3: deaktivierter eingeschalteter Switch wirkt aktiv, Bild im `Read`-Ergebnis erst nach Aufklappen; WP-41: L9, L12, Ton im App-Fenster aus Autostart |
| R4/V3 | Review + Verifier, Fix-Runde | 3b | 40 | fertig | R4 `10ff433`, V3 `9231448` (Merge `1f2e866`); Fix-Runde (`docs/wp/FIX-R4.md`): K `29f3256`, F4 `9ba8092`, F3 `80ee1e8`, F2 `6be4d0e`, F1 `a617e0a`, Nacharbeit `150d2e2`, F5 `07d7197` | R4-Server 16 Befunde (2 BLOCKER: R4-01 Konsolen-Gate im Lock, R4-02 Schlaf ohne Wakeup-Erkennung; 5 SOLLTE, 9 NIT), R4-Web 28 (0/10/18), V3 15 (0/8/7); Entscheidungen ADR-121…127; Fix-Runde: alle BLOCKER/SOLLTE behoben (Ergebnisse `FIX-R4-F1…F5.md`), Endstand 3702 Tests, 45/45 E2E (3× grün, davon 1× unter Last), Start-Chunk `index` 435,7 → 378,0 kB | siehe „Zurückgestellt nach der Fix-Runde“ unten; Live-Prüfpunkte A19–A26 in WP-41 |
| 41 | Live-Abnahme Phase 2 (freigegeben, F2) | 4 | 40 + Fixes | teilweise | `fc019d8`…`281a555`, Merge `31a1fe7` | Live gegen `claude` 2.1.300 (Abo, Haiku), 0,063 USD: 18 ok (5 mit Befund; A18 Live-Smoke 6/6 am 19.10. nachgeholt), 2 teilweise, 1 notiert (RAM: je `claude.exe` ≈ 220 MB WS), Rückbau vollständig; Befunde WP41-01…08 (0 BLOCKER, 2 SOLLTE, 6 NIT) → FIX-41 | **A18 Live-Smoke offen** (Auto-Modus blockiert den Start des echten `claude` – Nutzer-Bestätigung, nach FIX-41); A16/A17/A22/A23/A26 ungeprüft (Desktop-Bedienung verboten, Nutzer-Regel 18.10.) → Nutzer-Checkliste WP-41 §2.6 |
| FIX-41 | Fix-Runde nach WP-41 (`docs/wp/FIX-41.md`): F1 Server (WP41-04, -08/ADR-128), F2 Web (WP41-01, -02, -05, -06, -07) | 4b | 41 | fertig | F1 `f5863b6`/`378a228` (Merge `7c8dbe1`), F2 `85c0a00` (Merge `4794352`), Nacharbeit siehe Log | Alle 7 Befunde behoben mit Test (Gegenproben rot): Töne ohne Geste im App-Fenster, `PathTail` (Sidebar-Zeile, Gruppenüberschrift, Kopfzeile, Strg+K), Limits je Konto (`windowsPathKey`), Hinweis `.claude.json`, Handoff-Sperre im Composer + Cursor am Ende, `PSExecutionPolicyPreference` (ADR-128), Benachrichtigungsziel bei Gleichstand + Fokus-Gedächtnis im Hub + `debug`-Zeile (ADR-129); 3760 Tests, 45/45 E2E | Live-Nachprüfung in der Nutzer-Checkliste WP-41 §2.6; Ergebnisse `FIX-41-F1.md`, `FIX-41-F2.md`; ein ausdrücklich eingetragener Standardordner zählt bei den Limits als eigenes Konto (bewusst) |

### Sammelliste Welle 2 (Stand 18.10.2026, nach Merge `5f0d0cf`: 199 Dateien, 3509 Tests)
- **WP-40 (Naht, beauftragt):** Slots `SettingsPage`/`PREFERENCES_SLOTS` (WP-38) und `ProfilesSettings` (WP-36)
  in `App.tsx`; Verdrahtung laut WP-31/32/33/34 §2.4; `profileStore.onChange → manager.onProfileChanged()`;
  Edge mit `--autoplay-policy=no-user-gesture-required` (ADR-120, `launcher/edgeWindow.ts`);
  `shell/navigation/session-actions.tsx` verliert im Rückfall das `cwd` → `openNewSession({cwd})` (WP-36-Befund).
- **R4/Fix-Runde:** `isSecretEnvKey` nach `@shared` (Contract-Wunsch WP-36; Kopie in
  `features/profiles/lib/secrets.ts`); Feature `profiles` importiert `shell/new-session` (Grenze prüfen);
  unbenutzte Schlüssel `shell.newSession.{description,hint,starting}`, `shell.empty.recentProjects`;
  Esc auf der Einstellungsseite verwirft ungespeicherte Profiländerungen ohne Rückfrage;
  `state/settings.ts` alle Top-Level-Felder optimistisch (WP-38); Hinweis mit Aktion (`ClientNotice`)
  für „Töne aktivieren“ und Hinweis-Region hinter Modals (z-40, `aria-hidden`; WP-35/38);
  Kommentar in `server/lib/powershell.ts` nennt `lib/process.ts` statt `system/console.ts`.
- **WP-41 live:** L1, L3, L5 (WP-37), Einfügen eines Screenshots aus Win+Umschalt+S, L7 (Zeitstempel
  der Konsolen-Turns, WP-34).
- **Koordinator-Entscheidung 18.10.2026:** `/config` (und Aliase wie `/settings`) ohne `key=value`
  bleibt ein Terminal-Befehl mit Hinweis „In externer Konsole öffnen“ (ADR-108 unverändert): er
  betrifft die Einstellungen von Claude Code, nicht die von Parallax; die Parallax-Einstellungen sind
  über das Menü erreichbar.

### Zurückgestellt nach der Fix-Runde R4 (Stand 18.10.2026, `07d7197`)
- V3-14: Sidebar klappt bei schmalem Fenster (700 px) nicht ein – Gestaltungsfrage, Phase 3.
- R4W-02 optional: Drop-Zone über dem ganzen Session-Bereich (der globale Drop-Schutz ist umgesetzt).
- R4W-25: Lightbox „Speichern unter“ im Edge-Profil – Live-Prüfpunkt A24, Entscheidung nach WP-41.
- V3-15 (a): `pnpm start -- --print-url` mit umgeleiteter Ausgabe kehrt erst mit dem Serverende zurück
  (Handle-Vererbung, ohne native Hilfe nicht lösbar) – nur README-Hinweis.
- V3-12: Radix-Hilfsinputs ohne `id`/`name` (ui-intern).
- Bundle: `index` < 360 kB nur mit lazy geladenen de-Wörterbüchern (R2W-21); Fehlergrenze für
  Lazy-Slots (Chunk-Ladefehler reißt sonst den React-Baum); eigenes `e2e/tsconfig.json` (lib DOM).
- Optional: `focusSessionInput` nach `src/web/lib`; `useReturnFocus` auch in `NewSessionDialog`,
  `HelpDialog`, `SettingsPage` (haben eigene, getestete Fokus-Rückgabe); i18n-Wächtertest für
  unbenutzte Schlüssel; feste Wartezeiten in Phase-1-E2E-Specs.

## Contract-Changelog
Änderungen an `src/shared/**` (nur nach Freigabe durch den Koordinator).

| Datum | WP | Änderung |
|---|---|---|
| 15.10.2026 | 00 | `src/shared/product.ts` angelegt: `PRODUCT_NAME = 'Parallax'`, `PRODUCT_ID = 'parallax'` (Produktname an genau einer Stelle). |
| 15.10.2026 | 02 | Contracts v1 eingefroren: `src/shared/{common,errors,status,model,protocol,sync,build,samples}.ts` und Server-Ports `backend/{types,fixture}.ts`, `sessions/ports.ts`, `sync/ports.ts`, `claude/ports.ts`. `PROTOCOL_VERSION 1`, Schema-Versionen 1, Transkript-Log `v1`. Fixture-Format nur noch in `backend/fixture.ts` (Recorder re-exportiert). Build-ID per `define` (ADR-013). „Regel merken“ mit vier Zielen, Server baut `updatedPermissions` (ADR-012). Patch-Schemas ohne Defaults. |
| 15.10.2026 | R0 | Additiv/Bugfix, `PROTOCOL_VERSION` und Schema-Versionen bleiben 1: neu `src/shared/http.ts` (HTTP-/Auth-Contract, Launcher-Code, Lockfile; ADR-015) und `src/shared/paths.ts` (Pfadregeln; ADR-017); Codes `LAUNCHER_TOKEN_INVALID`, `SESSION_HELD_ELSEWHERE`, 9 × `PROFILE_*` + `PROFILE_ARG_INVALID_REASONS`; Anzeige-Status `needs-resume` (ADR-016), `notificationFor` mit Art der neuen Entscheidung; `LIMITS` für Eingaben + `itemTotalChars`/`snapshotMaxChars`, `modelNameSchema`; `sessionInitInfo.permissionMode` nullable + tolerante Enum-Leser; `decisionRecord.decision`, `Entry.unread`/`context` (Defaults); `applyDelta` nur auf streamende Items; Ports: `StatusSignal` (`permissionMode` nullable, `turn_result.startupFailure`), `ReduceStatusContext`, `ParseProfileArgs`, `ProfileArgIssueParams`, Regelkommentare. |
| 15.10.2026 | R1 | Additiv, Versionen bleiben 1: Codes ROUTE_NOT_FOUND, PROMPT_NOT_DELIVERED, STORE_VERSION_TOO_NEW (+ Texte en/de); Ports: StatusSignal.context_estimate.contextWindow, HistoryMessage.origin?, BackendSessionInfo.firstPrompt, DecisionStore.flush(), Kommentare session_id/createSyncHub/Plan-Version je Eintrag; HTTP-Guard nach Route (ADR-018), WS ohne Pflicht-Sec-Fetch-Site (ADR-019), Start-Abbruch bei neuerer schemaVersion (ADR-020); architecture §2.2/§5.1/§6/§8/§9. Neu `src/shared/devPorts.ts` (DEV_WEB_PORT importfrei, ADR-03x). |
| 16.10.2026 | 30 | **Contracts v2** (Spezifikation `docs/wp/WP-30.md` §4, ADR-100…119): `PROTOCOL_VERSION` 1 → 2 (neue Fehlercodes, System-Event `handoff`, Befehle); `REGISTRY_SCHEMA_VERSION` 1 → 2 (`conversationEndReason 'switched'`, Migration = Identität); Settings v1 additiv (Benachrichtigungen, Leerlauf-Schlaf, `promptSuggestions`, Port, Autostart; kein `editor`, F1); `ProfileSummary` erweitert, neu `ProfileInput`/`ProfileIssue`; Entry `gitBranch`/`external`/`continueAt`/`fastMode`; `Summary.external`; 12 neue Befehle + `HOST_COMMAND_NAMES`; `conversation.reset.hasEarlier`; 8 Fehlercodes; Upload-/Protokoll-Helfer in `@shared/http`; neu `@shared/version`. Ports: `consoleLaunchFor`, `HostCommandHandler`, `BlobStore.put(…, size)`, Status-Event `wakeup`, `StartSessionRequest.fastMode?`, neu `system/ports.ts`. |
| 18.10.2026 | R4 (K) | Additiv, Versionen unverändert: neu `src/shared/secrets.ts` (`isSecretEnvKey`, `SECRET_NAME_PARTS`, `SECRET_NAMES`; erweiterte Regel, ADR-124), `LIMITS.attachmentsTotalBytes` 20 000 000 (ADR-125), `DEFAULT_PORT` 4711 in `model.ts` (R4W-21); Web-Slot `ProfilesSettingsSlotProps.onDirtyChange?` (R4W-01, `shell/slots.tsx`). Kopien (`server/claude/profiles.ts`, `web/features/profiles/lib/secrets.ts`, `server/config.ts`, `preferences/lib/limits.ts`) entfernen die Fix-Pakete. |
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
- Koordinator-Entscheidungen R2 Server: Kinder-Pfad der Waisen-Bereinigung bis nach WP-22 abgeschaltet
  (nur verifizierter Wurzelprozess); `PARALLAX_HOME`-Rechte nur warnen; Home-Lock als Modul, Verdrahtung in WP-20c.

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

## Sammelliste für WP-20 (Verdrahtung erledigt in 20a/20b; offen für 20c: E2E, Home-Lock aus R2-Fixes verdrahten, Bugs unten)
- Slots: `TRANSCRIPT_SLOTS` (WP-15) und `{DecisionBar, DecisionCard, SidePanel: PlanSidePanel, Composer}` (WP-16) in `APP_SLOTS`.
- i18n-Namespace `serverShutdown` in `src/web/i18n/index.ts` registrieren (WP-21 nutzt bis dahin `useShutdownT`).
- Server-`main.ts`: nach `listen` `writeServerLock` (tatsächlicher Port, `auth.launcherToken`); `onShutdownRequested` →
  `shutdown.stop('command')` mit Engine-Shutdown (13b); Signale; Exit 4 bei EADDRINUSE, Exit 3 bei `StoreVersionTooNewError`.
- Backend nach `--backend`: `createFakeBackend` (Default dev/E2E) bzw. `createSdkBackend()` (SDK nur dann dynamisch laden), `dispose()` beim Shutdown.
- E2E (Playwright `msedge`, FakeBackend): Permission-, Frage-, Plan-Flow, Stop, Reload mit offener Karte, „Server beenden“.
- Doku: CLAUDE.md/README „Installation und Start“, `src/web/shell/README.md`, architecture §5.1 (h) (Launcher holt Code auch beim ersten Start über `/api/launcher/code`).
- Engine (13b): `openProcessStore` (Exit 3 bei `StoreVersionTooNewError`), `attachPublisher` vor `start()`, `warnings.onChange`/`checkProfile` → `publishHostState`, Stop-Reihenfolge `manager.shutdown()` → `app.close()` → Stores schließen.
- Bekannt: Bis zur Verdrahtung endet ein echter `pnpm start` nach 30 s mit Zeitüberschreitung (Bootstrap-Stub).
- Bugs aus WP-20a (für 20c): SDK wird im Bundle immer geladen (esbuild hebt statischen Import; `sdkBackend.ts` lazy oder `splitting`); `pnpm start -- --port=…` scheitert an wörtlichem `--` (`args.ts`).
- Offen für später: `processInfo` per PowerShell braucht unter Last bis ≈23 s (Waisen-Bereinigung beim Start) – schnellere Methode prüfen; Web-Default-Timeout in Vitest statt Limits je Datei; Importkosten `radix-ui` in Tests.

## Nutzer-Freigaben
- 16.10.2026: Privates GitHub-Repo `DerXHelp/parallax` angelegt und `main` gepusht (Stand `c821118`) – auf ausdrücklichen Wunsch des Nutzers.
- 15.10.2026: Live-Abnahme WP-22 freigegeben (echter Abo-Login; Haiku, Mini-Prompts, Scratch-Ordner, Temp-Home, kein API-Key; bei Auth-Fehler sofort stoppen).

- 16.10.2026 (Phase 2, WP-30 F1): Editor-Einstellung erst in Phase 3 zusammen mit „Im Editor öffnen“.
- 16.10.2026 (Phase 2, WP-30 F2): Live-Abnahme WP-41 freigegeben – Abo-Login, Haiku, Mini-Prompts, Scratch-Ordner, Temp-Home,
  Budget ≤ 1 USD, bei Auth-Fehler sofort stoppen; inkl. sichtbarem Konsolenfenster (`claude --resume`), HKCU-Protokoll-Handler
  `parallax:` und Autostart-Verknüpfung, alles mit Rückbau am Ende.
- 16.10.2026: WP22-04 – neue Sessions bekommen **keinen** von Parallax gesetzten Permission-Modus; CLI bzw. `defaultMode` entscheidet (Plan C.3 bleibt).
- 16.10.2026: Kurze Live-Nachprüfung der WP-22-Fixes erlaubt (Rahmen wie WP-22, Budget ≤ 0,50 USD).

## Koordinator-Entscheidungen R3/V2 (15.10.2026)
- V2-01: Parallax-Edge-Profil nie mit Microsoft-Konto anmelden/synchronisieren (Flags/Profil-Präferenzen, keine Policies).
- R3-02: FakeBackend auf dem echten Datenverzeichnis verboten; Launcher meldet Backend-Abweichung eines laufenden Servers.
- R3-05: Prod-Validierung eingehender Daten dauerhaft „log“. R3-13/V2-03: Build-ID nur aus Build-Eingaben; Build überschreibt kein `dist` eines laufenden Servers.
- R3-01: CLI-/SDK-Version in der UI (Versionsregel C.7).

## Koordinator-Regeln (Ablauf)
- Merges ab 15.10.2026 nur noch mit `git merge --no-ff --no-commit`, dann `pnpm check` + `pnpm build`, erst bei Grün committen
  (Anlass: semantischer Bruch `ProcessQueryResult` nach Merge `61e8e1f`, behoben in `2c3fb70`).
- Doku nach R1/R2 nachgezogen (`d961201`); offen: `WP-13b.md` beschreibt noch den Kinder-Pfad (historisch).

## Nächste Schritte
1. **Phase 1 abgeschlossen (16.10.2026).** Alle WPs, Reviews R0–R3, Verifier V1/V2, Live-Abnahme WP-22 und `/code-review` erledigt und gemergt.
2. **Phase 2 „Mission Control“ beauftragt (16.10.2026, Nutzer: „Setze die Phase 2 um“).** Umfang = Plan „Phasen – Phase 2“.
   WP-30 gemergt (`1488b83`). Welle 1 (31, 32, 33, 35) und Welle 2 (34, 36, 37, 38) gemergt (`5f0d0cf`, 18.10.2026);
   WP-40 (Integration + E2E) gemergt (`6373625`, 18.10.2026). R4/V3 und Fix-Runde (K, F1–F5) gemergt
   (`07d7197`, 18.10.2026). WP-41 (Live-Abnahme) teilweise gemergt (`31a1fe7`, 18.10.2026).
   FIX-41 gemergt (19.10.2026). A18 Live-Smoke nach Nutzer-Freigabe nachgeholt (19.10.2026, `0d81e5b`,
   6/6, 0,0105 USD). **Offen beim Nutzer:** Checkliste WP-41 §2.6. `/code-review` (high) über
   `fdc44f7..main`: 10 Funde (`docs/wp/CODE-REVIEW-2.md`). **Läuft:** Fix-Runde S1 Engine / S2
   System+Upload (Branches `fix/cr2-s1`, `fix/cr2-s2`).
3. **Nutzer-Regel 18.10.2026:** keine Desktop-Bedienung per Skript (Klicks, Tastatur, Fenster-Fokus,
   Bildschirmfotos, UI Automation, Prozessspeicher) – auch nicht in freigegebenen Live-Tests; gilt für jeden
   Subagenten (in jeden Auftrag für Live-/UI-Arbeit schreiben). UI-Prüfung nur über Vitest/Playwright.
4. **Ablauf-Regel 18.10.2026:** lange Läufe (`pnpm check`, `pnpm e2e`) im Hintergrund mit Ausgabe in Dateien
   starten, nicht blockierend durch die Tool-Pipe (Absturz der Koordinator-Session während A18).
5. Nach ≥ 24 h: `react`/`react-dom` 19.3.1 prüfen und nachziehen (Koordinator, siehe WP-00.md).
