# src/server/sync – Sync-Protokoll (WP-10)

Handshake (`hello`), Session-Summaries an alle Clients, Transkript-Abos mit Sequenznummer und
Ringpuffer, Befehle mit `cmdId`/`ack`, Delta-Bündelung, Präsenz. Nachrichtentypen kommen aus
`@shared/protocol` (WP-02). Normativ: `docs/architecture.md` §3.1 und §5.

- **Port (eingefroren seit WP-02, Änderung nur per Contract-Änderung):** `ports.ts` –
  `SessionPublisher`, `SessionSource`, `ClientPresence`, `CommandError`, Stores
  (`TranscriptStore`, `BlobStore`, `RegistryStore`, `DecisionStore`, `SettingsStore`,
  `StoreWarnings`), `transcriptLogLineSchema`; feste WP-10-Modulnamen im Kopfkommentar.

| Datei | Exporte | Inhalt |
| --- | --- | --- |
| `hub.ts` | `createSyncHub({ source, instance, validation?, timing?, now?, logger? }) → SyncHub` (`SessionPublisher` + `attach(app, { authorizeUpgrade })`, `handleConnection`, `inspect`, `stats`, `dispose`), `HubSocket`, `DEFAULT_HUB_TIMING`, `HUB_LIMITS` | der Hub; die WS-Route prüft jedes Upgrade selbst (`preValidation` + WS-Handler, R1-01) |
| `memorySource.ts` | `createMemorySessionSource() → MemorySessionSource` | Test-Double für `SessionSource` (Host-State, Summaries, Views, Verlauf für `loadEarlier`, Aufruf-Protokolle, `setHandler`) |

Regeln des Hubs:
- **Handshake:** `hello` sofort; vor `clientHello` → `error` + Close 4400; andere
  `protocolVersion` → `error PROTOCOL_VERSION_MISMATCH` + Close 4409; danach `host.state`,
  `summaries.snapshot` (aus der Source).
- **Kanal 1:** `publishSummary` sendet sofort, wenn `urgent` oder sich etwas außer `context`,
  `lastActivityAt`, `lastResultExcerpt` geändert hat; sonst höchstens 1×/s je Eintrag
  (Trailing-Flush mit dem letzten Stand).
- **Kanal 2:** Seq je Eintrag ab 1 je Instanz (die Seq von `loadView` wird ignoriert, R0-20);
  Ringpuffer `LIMITS.ringBufferOps` (zusätzlich 16 Mi Zeichen) nur für „warme“ Einträge
  (Abonnenten, laufendes Laden oder Gnadenfrist 60 s nach dem letzten Abo); Antwort auf
  `subscribe` = Replay (`sinceSeq` im Puffer, auch leer) oder Snapshot (≤ 150 Items,
  ≤ `LIMITS.snapshotMaxChars`, das neueste Item bleibt) oder `session.unavailable`.
  **`loadView` muss alle Ops enthalten, die vor dem Auflösen veröffentlicht wurden.** Der Snapshot
  wird aus dem **aktuellen** View gebaut (Ops zwischen `loadView` und Antwort gehen nicht
  verloren, R1-02).
- **Deltas:** je `(itemId, field)` gepuffert, nach 40 ms oder vor jeder anderen Op des Eintrags
  als **eine** Op geflusht.
- **Befehle:** Idempotenz host-weit (LRU 1000, TTL 10 min ab Abschluss); Duplikat während der
  Ausführung wartet auf dasselbe `ack`; `VALIDATION_FAILED` wird ebenfalls gecacht; Ergebnis wird
  gegen `commandResultSchemas` geprüft (sonst `INTERNAL_ERROR`, `reason: invalid_result`).
- **Validierung (R0-28, R3-05):** `validation` `throw` (Modul-Default unter Vitest/`NODE_ENV=test`),
  `log` (der Server übergibt `config.validation`, Default auch im Prod-Betrieb: ungültige Werte
  werden verworfen, gezählt – `stats().invalidOutgoing` – und mit laufender Zahl geloggt, die
  ersten 20 und dann jeder 100.) oder `off`; geprüft werden Ops, Summaries, Host-State, Snapshots,
  Notifications – „übersteht `parse` unverändert“ (kein `undefined` statt `null`, alle Defaults).
  Ein verworfenes Op bekommt keine Seq (keine Lücke beim Client).
- **Schutz:** > 10 ungültige Nachrichten in 10 s → Close 4400; Client mit > 16 MiB
  ungesendeten Daten → Close 1013; Ping alle 30 s.
