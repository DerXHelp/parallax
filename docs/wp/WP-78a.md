# WP-78a – Freigeben: Krypto, Fernzugang, Rolle

Auftrag des Koordinators (18.11.2026), Branch `wp/78a` von `feature/multi-host` @ `3998a88`. Normativ: `docs/wp/WP-76.md`
§B (Krypto-Spezifikation), dazu WP-75 §3, §4.1–4.2, ADR-205…208, 224, 225. Besitz: `src/server/{secure,remote,multihost}/**`
(ohne `ports.ts`).

## Stand

| Schritt | Stand |
| --- | --- |
| 1 `secure/**` | fertig (81 Tests) |
| 2 `remote/**` | fertig (70 Tests) |
| 3 `multihost/**` | fertig (10 Tests) |

## Abweichungen von §B (begründet)

1. **`kAuth`: `info = SHA-384(T)` statt `info = T`** (§B.7 Schritt 7.2). Node/OpenSSL begrenzt `info` von HKDF auf
   1024 Byte (`hkdfSync` → `ERR_OUT_OF_RANGE`, geprüft unter Node 26.12). `T` enthält zwei SPKI von ML-DSA-87 (je 2614
   Byte) und ist rund 5,3 KB lang. Der Hash des Transkripts ist die übliche Form (TLS 1.3 nutzt im Schlüsselplan
   ebenfalls den Transkript-Hash) und bindet `kAuth` genauso an `ekm`, `spkiB` und `spkiA`. Beide Seiten liegen in diesem
   Paket (`secure/pairingCrypto.ts`); WP-76 §B.7 sollte nachgezogen werden.
2. **PowerShell über `powerShellPath()` statt `resolveExecutable`.** §B.5 verlangt den absoluten System32-Pfad;
   `resolveExecutable` sucht über `PATH` und könnte ein untergeschobenes `powershell.exe` finden. `powerShellPath()`
   (`lib/process.ts`) ist die eine Stelle dieses Pfads (R4-14); `spawnHidden` prüft ihn (`assertSpawnableFile`).
3. **Exporter mit leerem Kontext** (`exportKeyingMaterial(48, label, Buffer.alloc(0))`): Die Typen von Node verlangen
   den Kontext. In TLS 1.3 sind „kein Kontext“ und „leerer Kontext“ gleich (RFC 8446 §7.5); beide Seiten rufen es gleich auf.
4. **Sitzungstickets:** OpenSSL schickt in TLS 1.3 trotz `SSL_OP_NO_TICKET` zustandsbehaftete Tickets. Node speichert
   ohne `newSession`/`resumeSession` keine Sitzungen, also wird ein angebotenes Ticket nie angenommen (Test
   `tlsProfile.test.ts`); zusätzlich lehnen beide Seiten `isSessionReused()` ab. Eine Node-Option für „keine Tickets“
   (`SSL_CTX_set_num_tickets(0)`) gibt es nicht.
5. **Version beim Koppeln** (Ergänzung zu §B.7): Mit richtigem Code, aber anderer Parallax- oder Protokollversion
   antwortet der freigebende Rechner 409 `HOST_INCOMPATIBLE` und speichert nichts; der Code ist verbraucht. So entsteht
   keine Kopplung, die die Gegenseite ohnehin ablehnt, und die Version erfährt nur, wer den Code kennt.

## Entscheidungen im Fernzugang (`remote/`)

- **Aufbau:** `net.Server` (Grenzen vor TLS, `maxConnections`, Ereignis `drop`) → `tls.Server` ohne Port →
  Klassifizierung → `peerHttp` (Fastify mit `serverFactory`, nie `listen`) bzw. `pairingHttp` (`http.Server` ohne Port).
  Die Prüfungen „Socket aktuell“, Browser-Header und Version laufen vor Fastify im Request-Handler des `http.Server`
  und vor jedem Upgrade.
- **Fenster abgelaufen während einer Anfrage** (Grund `lapsed`): Die Anfrage bekommt `PAIRING_EXPIRED`, die übrigen
  Sockets des Fensters werden geschlossen. Ein Fehlversuch zählt nur für das Fenster des Sockets.
- **Andere Pfade/Methoden, Browser-Header, zu großer Body** am Kopplungs-Socket: 404/403/413 ohne Fehlversuch.
- **`proof_failed`** bei falschem Beweis, Überlänge, Zeitlimit und fehlendem Transkript; ein bloßes Schließen der
  Gegenseite wird nicht protokolliert.
- **`unseenRejected`** zählt abgelehnte Zeilen (nicht Einzelversuche) mit `lastAt` nach `seenAt`.
- **`peer.connections`** = offene WebSockets des gekoppelten Rechners (Fenster + Wächter), `connected` = mindestens ein
  bewiesener Socket. Der letzte Kontakt ändert sich höchstens einmal je Minute (Datei entprellt).
- **`kAuth` auf dem freigebenden Rechner:** DPAPI-Zweck `auth:peer`; Klartext nur im Speicher, solange der Fernzugang an
  ist (beim Ausschalten, Aufheben und Ersetzen überschrieben).
- **Generation** steigt bei Kopplung, Aufheben, Erneuern und beim Stoppen des Listeners.
- **Schreibfehler beim Aufheben:** Listener aus, `error = REMOTE_ACCESS_FAILED {reason:'store'}`; `remoteAccess.check`
  (oder ein erneutes Aufheben) schreibt erneut und startet den Listener, sobald es gelingt.

## Entscheidungen zur Rolle (`multihost/`)

- **Exklusiv, streng:** Zielrolle `share` oder `control` wird mit `REMOTE_ROLE_CONFLICT {role: <andere Seite>}`
  abgelehnt, solange die andere Seite Kopplungen hat – auch auf dem Umweg über „aus“. „Aus“ selbst ist immer erlaubt
  (Kopplungen bleiben, alles wird geschlossen).
- **Reihenfolge:** alte Seite deaktivieren → neue Seite aktivieren (beim Wechsel zu `share` laufen die Prüfungen) →
  `multi-host.json` schreiben. Scheitert ein Schritt, wird die alte Seite mit der alten Konfiguration wieder aktiviert
  und der Fehler zurückgegeben (Prüffehler unverändert, Schreibfehler `STORE_WRITE_FAILED {file}`).
- **Start:** `start()` ruft `prepare()` beider Seiten (Kopplungen lesen), liest die Datei und aktiviert die gespeicherte
  Rolle; ein Fehler dabei wird nur protokolliert, die Seite zeigt ihn selbst (`remoteAccess.error`, Nachholen per
  `remoteAccess.check`).
- **Neuere Schema-Version oder unlesbare Datei:** Rolle aus, Host-Warnung (`STORE_VERSION_TOO_NEW` bzw.
  `STORE_WRITE_FAILED {reason:'unreadable'}`), jedes `multiHost.configure` wird mit diesem Fehler abgelehnt; die Datei
  bleibt unverändert. Der Serverstart wird – anders als bei `JsonStore` – nicht abgebrochen.
- **Ohne steuernde Seite** (vor WP-79) lehnt `configure` die Rolle `control` mit `NOT_IMPLEMENTED` ab.

## Beobachtungen (Node 26.12, OpenSSL 3.5.9)

- TLS-Schlüssel nimmt OpenSSL nur als PEM (kein `KeyObject`); der PEM-Puffer wird nach dem Aufbau des Kontexts
  überschrieben, der Zwischen-String von `export()` nicht (V8). PKCS#8 von ML-DSA-87 ist die Seed-Form (54 Byte).
- Nach dem Lesen des Verbindungsbeweises im `readable`-Modus übernehmen `http.Server`, Fastify (`serverFactory`, ohne
  `listen`), `https.Agent` und `ws` den Socket ohne Byteverlust (der Wechsel `readable` → `data` geschieht in
  `process.nextTick`). Explizites `pause()` darf nicht verwendet werden: danach startet der HTTP-Parser nicht.
- Ein Client mit Ed25519- oder ML-DSA-65-Zertifikat schickt gegen `sigalgs: 'mldsa87'` gar kein Zertifikat; der
  Handshake gelingt, die Klassifizierung lehnt ab (`bad_certificate`).
- Der Client meldet `secureConnect` vor dem `secureConnection` des Servers; Tests warten deshalb auf die
  Klassifizierung (`connectionCounts()`).
- HTTP/1.1-Server von Node verlangen einen `Host`-Header (`requireHostHeader`); die Kopplung schickt `address:port`.
- Die Firewall-Abfrage (`Get-NetFirewallApplicationFilter` + `Get-NetFirewallRule`) dauert rund 1 s.

## API für WP-79 (steuernder Rechner)

| Baustein | Aufruf |
| --- | --- |
| Schlüssel der Kopplung | `generateIdentity('coupling:<hostId>')` (nur im Speicher) → nach Erfolg `identityStore.save(identity)`; laden mit `identityStore.load(...)`; entfernen mit `remove(...)`. `createIdentityStore({home, keyStore, warnings})` liefert `FileIdentityStore` (= Port + `save`). |
| Kopplung | `pairWithHost({address, port, code, deviceName, identity, appVersion, timeoutMs?, signal?})` → `{peerCertificateDer, peerPin, authKey, hostName, appVersion, protocolVersion}`; Fehler `PairingClientError.error`: `VALIDATION_FAILED {reason:'code'}` (lokal, kein Fehlversuch), `PAIRING_INVALID`/`PAIRING_EXPIRED`/`PAIRING_RATE_LIMITED`, `HOST_UNREACHABLE {reason: refused/timeout/tls/network/closed/status_<n>}`, `HOST_INCOMPATIBLE {version, protocol}`, `REMOTE_ACCESS_FAILED`. Danach `keyStore.protect('auth:<hostId>', authKey)` in `hosts.json`, `authKey.fill(0)` nach dem Bau des Agents. |
| Verbindungen | `new PinnedAgent({identity, peerCertificateDer, peerPin, authKey})` je Kopplung; `https.request({agent, host, port, path, headers: remoteVersionHeaders(appVersion)})`; `new WebSocket(url, {agent, ...REMOTE_WS_CLIENT_OPTIONS, headers: remoteVersionHeaders(appVersion)})`. Fehler beim Aufbau: `PinnedConnectionError.reason` – `network`/`timeout`/`tls` → unreachable; `proof_closed` (Gegenseite trennt nach dem Handshake: unbekannter/aufgehobener Schlüssel) und `proof_mismatch` → revoked bzw. Warnung; `pin`/`unauthorized` → falscher Rechner unter der Adresse. `agent.destroy()` beim Entfernen/Neu-Koppeln (überschreibt `kAuth`). |
| Tests | `createMemoryKeyStore()`, `secure/testKit.ts` (`startTlsServer`, `tryConnect`, `foreignCredentials`), `remote/testKit.ts` (freigebender Rechner auf `127.0.0.1:0`). |

## Verdrahtung (Koordinator, WP-82)

1. **Schlüsselspeicher:** `const keyStore = createDpapiKeyStore({ logger })` (`secure/keyStore.ts`), einmal je Server.
2. **Freigebende Seite:**
   ```ts
   const share = createRemoteAccessService({
     home, instance,                       // ServerInstance aus config.ts (Version für Header/Health)
     hub,                                  // RemoteHubAttach des Sync-Hubs (WP-78b, sync/hub.ts)
     keyStore,
     registerContent,                      // aus src/server/http/content.ts (WP-78b)
     currentRole: () => multiHost.config().role,
     warnings,                             // StoreWarningRegistry des Hosts
     logger,
   });
   ```
   `registerContent(app, context)` bekommt die Fastify-Instanz des gekoppelten Rechners; jede Route prüft vor ihrer
   Wirkung `context.isCurrent(request)` (die Allowlist in `peerHttp.ts` lässt nur Health, Blob, Datei, Anhänge und
   `DELETE peer/self` zu – weitere Routen dort ergänzen).
3. **Rolle:** `const multiHost = createMultiHostService({ home, share, control: hostsService /* ab WP-79 */, warnings, logger })`.
4. **Befehle:** `multiHost.commands` (`multiHost.configure`) und `share.commands` (`remoteAccess.*`, Liste
   `REMOTE_ACCESS_COMMANDS`) in das Host-Befehls-Routing. Die Antwort auf `remoteAccess.pair` enthält den Code: nur an den
   anfragenden Client, nie loggen, nie in Ops/Broadcasts.
5. **HostState:** `remoteAccess = share.state()`, `multiHost = multiHost.config()`; `multiHost.onChange(() => republish())`
   (leitet auch die Änderungen der Seiten weiter).
6. **Start/Stopp:** nach dem Hub `await multiHost.start()` (nie fatal); beim Herunterfahren `await multiHost.stop()`, danach
   `await share.close()` (Stores flushen, Peer-App schließen).
7. **Hub (WP-78b):** Sockets aus `handleRemoteConnection` sind `GuardedHubSocket`s; vor jeder Wirkung eines Befehls
   `share.isCurrentConnection(socket)` prüfen (Generation, §B.8). `closeRemote(code)` schließt alle Fern-Sockets –
   `HOST_REVOKED` (Aufheben, Erneuern, Ersetzen) bzw. `SERVER_SHUTDOWN` (Fernzugang aus).
8. **Firewall-Prüfung:** liest Regeln für `process.execPath`; der Installer bzw. die Anleitung legt die Regel an
   (nur lesen, nie ändern).

## Prüfungen und Tests

- Tests (nur `127.0.0.1`, Port 0, Temp-Home, `MemoryKeyStore`; DPAPI-Tests mit Dateien im Temp-Home):
  `secure/` 81, `remote/` 70, `multihost/` 10 – zusammen 161.
- Pflichttests §B.12: Listener (unbekannter/aufgehobener Schlüssel, Anfrage im selben Flug, falsche Zertifikate auch bei
  offenem Fenster, falscher Beweis), Kopplung (MITM-Relay, Replay, Fehlversuche, Ablauf, Einmaligkeit, Ratenbegrenzung),
  Aufheben (WebSocket und laufende Anfrage sofort weg, Schreibfehler stoppt den Listener), Browserschutz, Schlüsselspeicher,
  DoS (Grenzen vor TLS, Handshake-Zeitlimit), Rolle, Protokoll.

## Schnittstellen über die Ports hinaus

- `FileIdentityStore` = Port `IdentityStore` + `save(identity)` (WP-79 speichert erst nach erfolgreicher Kopplung).
- `RemoteAccess` = Port `RemoteAccessService` + `prepare()`, `isCurrentConnection(socket)`, `close()`,
  `connectionCounts()`; `createMultiHostService` nimmt Seiten mit optionalem `prepare()`/`onChange()` (`ManagedRoleSide`).
- Der Hub muss die Generation prüfen (`isCurrentConnection`) – im Port `RemoteHubAttach` nicht beschrieben.
- Vorschlag Contract/Spezifikation: WP-76 §B.7 auf `kAuth`-`info = SHA-384(T)` und die Versionsprüfung beim Koppeln
  nachziehen; optional `isCurrentConnection` in `RemoteAccessService` aufnehmen.
