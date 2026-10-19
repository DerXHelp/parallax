# Code-Review Phase 2 – Fix-Paket S1 Engine

- **Datum:** 19.10.2026. Branch `fix/cr2-s1` (Basis `main` `d8648ab`), Worktree `.worktrees/cr2-s1`.
- **Pfade:** `src/server/sessions/**` ohne `ports.ts` und `README.md` (Plan: `docs/wp/CODE-REVIEW-2.md`).
- **Vorgehen je Fund:** erst ein Test gegen den alten Code (rot), dann der Fix (grün); die Tests bleiben als
  Regression (Testname „CR2-0x: …“). Nur FakeBackend, Test-Doubles und virtuelle Uhr – kein Live-`claude`.
- Keine Contract-/Port-Änderung, keine neuen Fehlercodes, keine neuen Abhängigkeiten.

## Funde

| Nr. | Reproduziert | Fix | Regressionstest | Commit |
|---|---|---|---|---|
| CR2-02 | ja (2 Tests rot: der Plan war schon nach einem Profilfehler weg – `cancelContinue` lief vor `consoleLaunchFor` –, der Auto-Retry nach `EXTERNAL_CONSOLE_FAILED`) | `openExternal` (`external.ts`): erst die Konsolen-Spec (`consoleLaunchFor`), dann `closeRuntime` – ein Profilfehler (`PROFILE_INVALID`, `CLAUDE_NOT_FOUND` …) ändert nichts, die Query läuft weiter. `cancelContinue` und `cancelRetry` erst bei `result.kind === 'opened'`; das `cancelRetry` vor dem Lock entfällt. Scheitert `launcher.open`, ruht der Eintrag (Query ist schon zu, nie zwei Schreiber) und Plan/Retry greifen zu ihrer Zeit. | `external.integration.test.ts`: „CR2-02: a failed open keeps the scheduled continue (a profile error also the process); it still fires“ (Profilfehler: Plan + laufender Prozess bleiben; Konsole blockiert: Plan bleibt, zur Reset-Zeit Resume + `continue`), „CR2-02: a failed open keeps the auto-retry of an idle crash; an opened console drops it“, Wächter „CR2-02: an opened console still drops the scheduled continue“ (alt wie neu grün) | `c0098a0` |
| CR2-04 | teilweise: Titel und `promptTitle` ja (Test rot: Summary mit dem Titel des abgewiesenen Prompts, `session.rename null` holte ihn zurück). „Plan weg“ nein: jede Operation, die das Gate schließt (erfolgreiches `openExternal`, `setArchived`), verwirft den Plan ohnehin selbst; der vorgezogene Retry-Abbruch ist nicht beobachtbar (`startRuntime` lehnt externe/archivierte Einträge ab). | `sendPrompt` (`commands.ts`): `accept()` (Retry, Plan, Prompt-Titel) für Text- und Anhang-Prompts gleich – im Lock nach `assertEntryGate` und `resolveAttachments`. | `external.integration.test.ts`: „CR2-04: a text prompt refused after waiting for the lock changes neither the title nor the prompt title“ | `c0098a0` |
| CR2-05 | ja (2 Tests rot: nach Neustart mit geändertem `configDir` bzw. mit Katalog ohne Schlüssel lieferte `refreshModels` den alten Katalog) | `storedModelCatalogSchema.profileKey` (`string \| null`, Default `null`, `schemaVersion` bleibt 1); `CatalogStore.setModels` nimmt `profileKey`, der Manager speichert den Schlüssel, unter dem der Cache steht (`profileKeys`). Beim Start übernimmt `createSessionManager` nur Kataloge, deren Schlüssel zum Profil **jetzt** passt; die übrigen (anderes Konto, ältere Datei ohne Schlüssel, gelöschtes Profil) werden aus Datei und Cache entfernt (`info`-Log) und beim nächsten Start neu geholt. | `phase2b.integration.test.ts`: „CR2-05: a catalog persisted for another configuration of the profile is ignored after a restart“ (Standard-Profil behält seinen Katalog), „CR2-05: a persisted catalog without a profile key (older file) is ignored after a restart“; `catalogStore.test.ts`: „CR2-05: the profile key is stored with each catalog; an older file without it reads as null“ | `c0098a0` |
| CR2-09 | ja (Test rot: `scheduledTurn` blieb `true`, kein Schlaf-Timer mehr) | `deliverPrompt` (`runtime.ts`): `markScheduled('loop')` erst nach erfolgreichem `agent.send()`. | `phase2.integration.test.ts`: „CR2-09: a /loop prompt that send() refuses leaves the process unplanned – it still falls asleep“ | `c0098a0` |
| CR2-10 | nein – kein Fehler in `external.ts`, **zurückgestellt** (Begründung unten) | – | – | – |

### CR2-10 – Begründung der Zurückstellung

- Der einzige produktive `TranscriptStore` (`store/transcripts.ts`, `createTranscriptStore`) faltet bei
  **jedem** Lesen – `readTail` wie `readBefore`, mit jedem `limit` – die ganze Datei (`sortedItems` →
  `readFold`) und hält das Ergebnis im LRU-Cache (8 Unterhaltungen). Mirror-Aufbau (`LIMITS.snapshotItems`),
  Recovery und Unterhaltungswechsel lesen genauso. Ein kleineres `limit` in `importConsoleTurns` spart nur das
  flache `slice` und das Id-Set (bei 50 000 Items ≈ 0,4 MB Zeiger), nicht das Parsen und nicht den Speicher.
- Eine exakte Grenze ist aus dem Contract nicht ableitbar: Doppelte sind Items der Parallax-Turns mit
  Zeitstempel ≥ `since − 5 s` (vor dem Handoff-Item, Order nicht an die Zeit gebunden: ein früh angelegtes
  Item kann eine späte Verlaufs-Nachricht haben) und Items eines unterbrochenen früheren Imports (nach dem
  Handoff-Item). `ExternalHandoff` trägt keine Order.
- Ein echter Gewinn bräuchte (a) einen Store, der den Tail ohne Volllesen liefert (`store/**`, nicht S1), und
  (b) die Order beim Handoff (Contract-Änderung `ExternalHandoff.handoffOrder`, Default `null`) oder Paging
  rückwärts per `readBefore` bis vor das Handoff-Item plus Zeitfenster. Erst mit (a) sinnvoll → Follow-up.

## Entscheidungen

1. **CR2-02:** `closeRuntime` bleibt vor `launcher.open` (nie zwei Schreiber, ADR-104); vorgezogen wird nur,
   was ohne Seiteneffekt scheitern kann (Spec). Feuert ein Retry- oder Fortsetzen-Timer während `open()`,
   reiht er sich hinter den Lock: nach geöffneter Konsole lehnt `startRuntime` ab (`SESSION_EXTERNAL`,
   R4-01, nur `warn`), nach einem Fehlschlag läuft er wie geplant. Abgelaufene Karten (`closeExpired`) werden
   unverändert vor `open()` erledigt.
2. **CR2-04:** Der Prompt-Titel erscheint, sobald der Prompt den Lock hält – vor seinem eigenen Start (der auf
   eine Waisenprüfung warten kann) also weiterhin sofort; nur hinter einer anderen Lifecycle-Operation
   (Start, Schließen, Konsole) später. Auch `cancelRetry` läuft jetzt im Lock (ein in der Wartezeit
   gefeuerter Retry reiht sich hinter den Prompt; `startRuntime` gibt dann den laufenden Prozess zurück).
3. **CR2-05:** Neues Feld mit Default statt `schemaVersion` 2 – eine Version-2-Datei würde ältere
   Parallax-Versionen am Start hindern (ADR-020/ADR-114), der Verlust eines Caches ist harmlos. Gespeichert
   wird der Schlüssel aus `profileKeys` („zuletzt gesehen“), nicht frisch berechnet: Datei und Speicher-Cache
   folgen derselben Regel wie `onProfileChanged`. Abo-Limits bleiben unverändert (ADR-102: nur ein gelöschtes
   Profil verliert sie).

## ADR-Vorschläge (für `docs/decisions.md`)

## ADR-130 – Externe Konsole: geplantes Weiter und Auto-Retry erst nach geöffneter Konsole verwerfen
- **Datum/WP:** 19.10.2026, Code-Review Phase 2, Fix-Paket S1 (CR2-02). Ergänzt ADR-104 und ADR-112 (Texte
  bleiben).
- **Kontext:** `session.openExternal` verwarf ein geplantes „Weiter nach Rate-Limit“ (`continueAt`,
  `wakeupAt`) und einen anstehenden Auto-Retry, bevor die Konsolen-Spec gebaut und die Konsole geöffnet war.
  Scheiterte einer dieser Schritte (`PROFILE_INVALID`, `CLAUDE_NOT_FOUND`, AppLocker →
  `EXTERNAL_CONSOLE_FAILED`), blieb der Eintrag in Parallax, aber zur Reset-Zeit setzte nichts fort.
- **Entscheidung:** Reihenfolge im Lock: Gates, Vorbedingungen, `checkCwd`, **Konsolen-Spec**
  (`consoleLaunchFor`), Query schließen, Waisenprüfung abwarten, `launcher.open`. Plan und Retry werden erst
  bei `result.kind === 'opened'` verworfen. Ein Profilfehler ändert nichts (die Query läuft weiter); scheitert
  `open()`, ruht der Eintrag mit erhaltenem Plan/Retry.
- **Folgen:** Ein während `open()` fälliger Timer wartet auf den Lock; nach geöffneter Konsole lehnt
  `startRuntime` ihn ab (R4-01). Umsetzung und Tests: `sessions/external.ts`,
  `external.integration.test.ts` „CR2-02: …“.

## ADR-131 – Wirkungen eines Prompts erst, wenn er angenommen ist
- **Datum/WP:** 19.10.2026, Code-Review Phase 2, Fix-Paket S1 (CR2-04, CR2-09). Ergänzt ADR-112, ADR-121 und
  R4-01.
- **Kontext:** Ein reiner Text-Prompt verwarf Plan und Retry und setzte den Prompt-Titel vor dem
  Lifecycle-Lock; wies die zweite Gate-Prüfung im Lock ihn ab (`SESSION_EXTERNAL`, `SESSION_ARCHIVED`), blieben
  Titel und `promptTitle` geändert. `deliverPrompt` markierte einen `/loop`-Prozess als geplant, bevor
  `send()` den Prompt angenommen hatte; ein abgelehnter Prompt ließ den Prozess nie mehr schlafen.
- **Entscheidung:** `session.sendPrompt` ändert Retry, Plan und Prompt-Titel – für Text- und Anhang-Prompts
  gleich – erst im Lock nach `assertEntryGate` und der Anhangprüfung. `deliverPrompt` markiert einen
  `/loop`-Prozess erst nach erfolgreichem `send()` als geplant.
- **Folgen:** Hinter einer anderen Lifecycle-Operation erscheint der Prompt-Titel erst mit dem Lock; vor dem
  eigenen Start (Waisenprüfung) weiterhin sofort. Umsetzung und Tests: `sessions/commands.ts`,
  `sessions/runtime.ts`, `external.integration.test.ts` „CR2-04: …“, `phase2.integration.test.ts` „CR2-09: …“.

## ADR-132 – Persistierte Modellkataloge tragen den Profil-Schlüssel
- **Datum/WP:** 19.10.2026, Code-Review Phase 2, Fix-Paket S1 (CR2-05). Ergänzt ADR-102 und ADR-114.
- **Kontext:** `model-catalogs.json` speicherte Kataloge und Alias-Auflösungen nur je Profil-ID; der Manager
  säte `profileKeys` aus den Profilen beim Start. Wurde `profiles.json` bei gestopptem Parallax geändert oder
  aus `.bak` geholt (andere `.exe`, anderes `CLAUDE_CONFIG_DIR` = anderes Konto), lieferte der Cache Modelle
  und Aliasse des alten Kontos, und `onProfileChanged` verwarf nie.
- **Entscheidung:** Jeder gespeicherte Katalog trägt `profileKey` (`profileCacheKey` des Profils, unter dem
  der Cache steht; Feld mit Default `null`, `schemaVersion` bleibt 1). Beim Start übernimmt der Manager nur
  Kataloge, deren Schlüssel zum Profil jetzt passt; andere – auch ältere Dateien ohne Schlüssel und Kataloge
  gelöschter Profile – werden aus Datei und Cache entfernt und beim nächsten Start neu geholt.
- **Folgen:** Nach einem Update auf diese Version fehlen die Kataloge einmalig bis zum ersten Start je Profil
  (Rückfall auf die CLI-Aliasse, WP22-01). Abo-Limits unverändert. Umsetzung und Tests:
  `sessions/catalogStore.ts`, `sessions/manager.ts`, `phase2b.integration.test.ts` und `catalogStore.test.ts`
  „CR2-05: …“.

## Vorschläge für `src/server/sessions/README.md` (Koordinator)

- Zeile `manager.ts`, Inhalt: nach „geänderte Profile verwerfen Modell-Katalog und Launch-Env
  (`onProfileChanged`, ADR-102)“ ergänzen: „; beim Start nur persistierte Kataloge, deren `profileKey` zum
  Profil passt (CR2-05, ADR-132)“.
- Zeile `catalogStore.ts`, Inhalt: „Modell-Kataloge (je Katalog `profileKey`, CR2-05/ADR-132) und Abo-Limits
  je Profil (ADR-114) …“.
- Zeile `external.ts`, Inhalt: „… `checkCwd` und Konsolen-Spec vor dem Schließen (R4-09, CR2-02), Query
  schließen, nach Shutdown-Beginn nichts öffnen (R4-03), `claude --resume` über den `ConsoleLauncher`;
  geplantes Weiter und Auto-Retry erst nach geöffneter Konsole verwerfen (ADR-130) …“.
- Zeile `commands.ts`, Inhalt: „… `sendPrompt` ändert Retry, Plan und Prompt-Titel erst nach den Prüfungen im
  Lock (CR2-04, ADR-131) …“.
- Zeile `runtime.ts`, Inhalt: „… oder ein gesendeter Prompt, der mit `/loop` beginnt (erst nach erfolgreichem
  `send()`, CR2-09) …“.
- Absatz Integrationstests: „… `external.integration.test.ts` (… Fix-Runde R4 …; Fix-Runde CR2: Plan/Retry
  bei gescheitertem Öffnen, abgewiesener Prompt im Lock)“, `phase2b` „… Profil-Caches inkl. Profil-Schlüssel
  nach Neustart (CR2-05)“.
- Außerhalb S1, ebenfalls Koordinator: `docs/architecture.md` Zeile „Kataloge (WP-31)“ – `model-catalogs.json`
  „mit `resolved` und `profileKey`“.

## Follow-ups

- CR2-10 (s. o.): erst mit einem Store, der Tails ohne Volllesen liefert, plus Handoff-Order bzw. Paging.
- Klein, nicht im Review: `deliverPrompt` setzt `pendingRename` (`/rename X`) ebenfalls vor `send()`; ein
  abgelehnter Prompt lässt es stehen (ein späteres gleichlautendes `title_changed` gälte als Echo → `custom`).

## Checks

- `pnpm check` (im Worktree): typecheck ok, lint ok (`--max-warnings=0`), Tests **3768 bestanden** in 215
  Dateien (davon `src/server/sessions` 704 in 35 Dateien).
- `pnpm build`: ok (`dist/web` + `dist/server.js`).
- Neue Regressionstests: 8 (gegen den alten Code 7 rot; der Wächter „CR2-02: an opened console still drops
  the scheduled continue“ alt wie neu grün). Danach nur ein Prettier-Umbruch in
  `external.integration.test.ts` (Datei erneut grün, ESLint ok).
