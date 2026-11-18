# WP-78b – Freigeben: Hub, Inhaltsrouten, Einstellungen

Teilpaket von WP-78 (Feature „Mehrere Rechner“, Plan `docs/wp/WP-75.md`, Spezifikation `docs/wp/WP-76.md` §B.6–§B.8,
§C, §D). Branch `wp/78b` von `feature/multi-host`, parallel zu WP-78a (Listener, Kopplung, Peer-Store) und WP-77.

## 1. Auftrag

1. **Hub** (`src/server/sync/hub.ts`): `RemoteHubAttach` aus `src/server/remote/ports.ts` umsetzen. Eine Fernverbindung
   ist ein normaler Client mit diesen Ausnahmen: Befehle nur aus `REMOTE_ALLOWED_COMMANDS` (fail closed, auch
   unbekannte), Wächter (`clientHello.kind: 'relay'`) nur über den Fernzugang und höchstens einer, ohne Abos und
   Befehle; `host.state` mit `remoteAccess: null`; Presence mit `origin: 'remote'` und `kind`. `closeRemote(code)`
   schließt alle Fernverbindungen sofort, danach läuft kein Befehl mehr an. Lokale Verbindungen genau wie bisher.
2. **Inhaltsrouten** (neu `src/server/http/content.ts`): Blob-, Datei- und Upload-Route aus `app.ts` als
   wiederverwendbare Fastify-Registrierung mit Pfaden als Parameter; `app.ts` nutzt sie für `API_PATHS` ohne
   Verhaltensänderung; der Listener des Fernzugangs registriert sie unter `REMOTE_PATHS` mit `beforeEffect`.
3. **Einstellungen** (`src/web/features/preferences/**`): Bereich „Mehrere Rechner“ mit Rollenwahl und dem Teil
   „Freigeben“; Teil „Andere steuern“ als benannter Platz für WP-80.
4. Diese Datei, READMEs von `src/server/http` und `features/preferences`.

## 2. Ergebnis

### 2.1 Hub (`src/server/sync/hub.ts`)
- `SyncHub extends SessionPublisher, RemoteHubAttach`. Jede Verbindung trägt `origin` (`local`/`remote`), `kind`
  (`window`/`relay`) und für Fernverbindungen Adresse und Port. `handleConnection` (lokal) und
  `handleRemoteConnection(socket, info)` laufen über dieselbe Zustandsmaschine; lokal ist Byte für Byte unverändert
  (bestehende Tests grün, zusätzlicher Test auf die alte Presence-Form).
- **Allowlist:** Vor dem Ausführen prüft der Hub `isRemoteAllowedCommand`. Unbekannter, verbotener oder fehlender
  Name → Ack `REMOTE_NOT_ALLOWED {command}` (bei fehlendem Namen `'unknown'`), Verbindung bleibt offen, Log `warn`.
  Erlaubter Name mit ungültigen Argumenten → `VALIDATION_FAILED` wie lokal. Die Antwort auf ein ungültiges Kommando
  einer Fernverbindung verrät also nicht, ob ein verbotener Befehl gültig gewesen wäre.
- **cmdId-Cache:** Fernverbindungen haben einen eigenen Namensraum im host-weiten Idempotenz-Cache. Eine Fernverbindung
  kann so nie das Ack eines lokalen Befehls (z. B. den Kopplungscode aus `remoteAccess.pair`) über dieselbe `cmdId`
  abrufen.
- **Wächter:** `kind: 'relay'` von einer lokalen Verbindung → `INVALID_MESSAGE {reason: 'relay_local'}` und Close 4400.
  Ein zweiter Wächter über den Fernzugang → `INVALID_MESSAGE {reason: 'relay_exists'}` und Close 4400; der erste
  bleibt (ein hängender verschwindet nach höchstens zwei Heartbeats, dann ist Platz). Ein Wächter darf weder
  `subscribe` (Fehler `REMOTE_NOT_ALLOWED {command: 'subscribe'}`) noch Befehle; er bekommt Summaries, Presence und
  Benachrichtigungen.
- **Schwärzung:** `host.state` an Fernverbindungen immer mit `remoteAccess: null` (Hello und jede Änderung; der
  geschwärzte Text wird je Veröffentlichung einmal gebaut).
- **Presence:** Fernverbindungen mit `origin: 'remote'` und `kind`; lokale ohne die Felder (alte Form).
- **`closeRemote(code)`:** trennt alle Fernverbindungen synchron vom Hub (Zustand `closed`, Abos und Presence weg),
  dann Close mit `code` (Grund „coupling revoked“ bei `WS_CLOSE.HOST_REVOKED`). Direkt vor `source.handleCommand`
  prüft der Hub, dass die Fernverbindung noch offen ist; ein Befehl, der in derselben Runde ankam, läuft nicht mehr an
  (Ack `HOST_REVOKED`, das niemand mehr liest). Ein bereits laufender Befehl läuft zu Ende, sein Ack geht nicht mehr
  raus. Das ersetzt im Hub die Generationsprüfung aus §B.8. `remoteConnections()` zählt alle Fernverbindungen
  (auch vor dem Hello).

### 2.2 Inhaltsrouten (`src/server/http/content.ts`)
- `registerContentRoutes(app, {paths, blobs, files?, beforeEffect?, logger?})` registriert in einem eigenen
  Fastify-Scope `GET paths.blob` (muss `:blobId` enthalten, sonst wirft die Registrierung), `GET`/`HEAD paths.file` und
  `POST paths.attachments` (eigener Buffer-Parser, `bodyLimit = UPLOAD_BODY_LIMIT_BYTES`). Logik, Header und Fehler
  1:1 aus `app.ts` übernommen.
- **Header-Politik in einer Hand:** Die Routen setzen ihre Header wie bisher; ein `onSend`-Hook des Scopes setzt
  `nosniff` immer und `X-Frame-Options: DENY`, `BLOB_CSP`, CORP `same-origin`, `Referrer-Policy: no-referrer`,
  `Cache-Control: no-store` als Vorgabe, wenn weder Route noch einbettende App sie gesetzt haben. In `app.ts` laufen
  die App-Hooks zuerst (Fastify: Eltern vor Kind) – die lokalen Antworten sind unverändert (`pageCsp` und COOP auf
  Fehlerantworten, `BLOB_CSP` auf Blobs). Auf einer nackten Instanz (Listener) haben auch Fehlerantworten den
  strengen Satz.
- **Fehler:** `contentErrorHandler` des Scopes (413 → `PAYLOAD_TOO_LARGE`, 415 → `UNSUPPORTED_MEDIA_TYPE`, andere 4xx →
  `VALIDATION_FAILED {reason}`, sonst `INTERNAL_ERROR` mit Log); `app.ts` nutzt denselben Handler.
- **`beforeEffect(request)`:** geprüft im `onRequest` (vor dem Lesen des Körpers) und direkt vor der Wirkung – nach
  `blobs.get`, nach `files.open` (Stream wird zerstört), unmittelbar vor `blobs.put`. `false` → 403 `HOST_REVOKED`,
  nichts ausgeliefert, nichts gespeichert.
- Cookie, `Origin`, `Sec-Fetch-*` prüft die einbettende App (lokal der Guard aus `origin.ts`); `content.ts` prüft nie
  Anmeldung.
- `app.ts`: nur die Extraktion; die Hilfsfunktionen (`safeMediaType` …) werden aus `content.ts` weiter exportiert,
  damit bestehende Importe gelten.

### 2.3 Einstellungen „Mehrere Rechner“
- **Seite:** `SettingsPage.tsx` führt den Bereich nach „Server“ (`NetworkIcon`). `SETTINGS_SECTIONS` in
  `src/web/shell/requests.ts` gehört dem Koordinator; die Seite ergänzt den Bereich lokal und verwirft das Duplikat,
  sobald die Shell ihn selbst führt (siehe §3).
- **Rolle** (`sections/MultiHostSection.tsx`): Radiogruppe Aus / Freigeben / Andere steuern mit Beschreibung,
  `multiHost.configure {role}`; die Wahl wird sofort angezeigt, nach dem Ack gilt dessen Stand, bis `HostState`
  folgt (`use-configure.ts`). Fehler als `Alert role="alert"` unter der Gruppe; bei `REMOTE_ROLE_CONFLICT` mit Hinweis
  je verlassener Rolle und – bei gekoppeltem Rechner – Knopf „Kopplung aufheben…“, der die Rückfrage im Teil
  „Gekoppelter Rechner“ öffnet.
- **Teil „Freigeben“** (`sections/multi-host/`):
  - `AccessStatus`: erreichbar ja/nein, Port, Adressen, Rechnername, `remoteAccess.error` mit Grund
    (`port_in_use`, `bind`, `tls_unsupported`, `listen`, `store`), Prüfungen in Contract-Reihenfolge mit Text je
    Status, „Erneut prüfen“ (`remoteAccess.check`), Firewall-Hinweis beim ersten Start (Firewall-Prüfung nicht `ok`,
    ohne Firewall-Ergebnis solange nie gekoppelt).
  - `PeerPanel`: Name, verbunden (mit Anzahl) / nicht verbunden, andere Version (mit Version), gekoppelt seit, letzter
    Kontakt, letzte Adresse; „Kopplung aufheben…“ und „Schlüssel erneuern…“ je mit Rückfrage inline (Fokus auf
    „Abbrechen“, nach „Abbrechen“ zurück auf den Auslöser).
  - `PairingPanel`: „Rechner koppeln“ (`remoteAccess.pair`); der Code steht nur im Ack und im Zustand der Komponente,
    nie im Store. Anzeige groß in 7 Gruppen (Trennstriche `aria-hidden`), Countdown sichtbar (`role="timer"`), für
    Screenreader eine `aria-live="polite"`-Zeile, die sich nur minütlich ändert; Rechnername, Adressen, Port,
    „Koppeln abbrechen“ (`cancelPairing`). Eine bestehende Kopplung wird nur nach Rückfrage ersetzt. Ende: Erfolg (neues
    `peer.pairedAt` → „Gekoppelt mit …“), Ablauf, Abbruch oder vom Server geschlossen (zu viele falsche Codes). Ein in
    einem anderen Fenster geöffnetes Fenster (`pairingExpiresAt` ohne eigenen Code) zeigt einen Hinweis mit „Neuen Code
    anzeigen“ und „Koppeln abbrechen“. Ohne Listener ist „Rechner koppeln“ aus.
  - `ListenerSettings`: Port (`NumberField`, Grenzen aus `multiHostConfigSchema`) und Adresse (alle `0.0.0.0` oder eine
    erkannte IPv4) über `multiHost.configure`; Fehler am Teil, Anzeige fällt zurück.
  - `ConnectionLog`: `remoteAccess.events {onlyRejected}`, Filter „Nur abgelehnte Versuche“, Spalten Zeit, IP-Adresse
    (mit Port), Ereignis (+ „abgelehnt“), Anzahl, Name (+ „ungeprüft“ bei abgelehnten Versuchen mit angegebenem
    Namen). Lädt beim Anzeigen, beim Filter, bei neuen abgelehnten Versuchen (`unseenRejected` steigt), bei
    Verbindungswechsel und über „Aktualisieren“; die alten Zeilen bleiben während des Nachladens stehen. Nach dem Laden
    mit `unseenRejected > 0` → `remoteAccess.eventsSeen`.
- **Teil „Andere steuern“:** `sections/multi-host/ControlPart.tsx`, Platzhalter mit `t()`; WP-80 füllt ihn.
- **Befehle:** `sections/multi-host/commands.tsx` bündelt die acht Befehle hinter `MultiHostCommands`; Standard ist
  `sendCommand(null, …)` an diesen Rechner, Tests und Demos setzen über `MultiHostCommandsProvider` einen Doppelgänger
  ein (`fake-commands.ts`, schreibt in den Host-State des FakeHost). `src/web/state/fake-host.ts` ist unverändert
  (antwortet weiter `NOT_IMPLEMENTED`; ein Test prüft genau diesen Standardweg).
- **Texte:** en/de unter `preferences.multiHost.*` und `preferences.sections.multiHost`, neutral („Rechner im selben
  Netz“, „steuernder“/„freigebender Rechner“). Grenzen in Texten aus dem Contract (`PAIRING_WINDOW_MS`,
  `PAIRING_MAX_FAILURES`, `LIMITS.remoteEventsDays`).
- **Playground:** `preferences/multi-host-{off,share,paired,errors,control}` (`MultiHostDemo.tsx`, Beispieldaten aus
  `@shared/samples`); in `multi-host-share` „tippt“ der steuernde Rechner einen gezeigten Code nach 20 s ein.

### 2.4 Entscheidungen
- `beforeEffect` bekommt die Fastify-Anfrage, damit der Listener über `request.raw.socket` Klasse und Generation des
  Sockets prüfen kann; Antwort 403 `HOST_REVOKED` (Katalog-Status 403).
- Ein zweiter Wächter wird abgewiesen statt den ersten zu ersetzen: Ein fremder Wächter könnte sonst den echten
  verdrängen; der echte kommt nach dem Heartbeat-Timeout wieder.
- „ungeprüft“ gilt für abgelehnte Einträge mit Namen: Angenommene Einträge (`pair_ok`, `connected`, `disconnected`,
  `unpaired`) betreffen den gekoppelten Rechner, dessen Name mit der Kopplung geprüft ist.

## 3. Verdrahtung (für den Koordinator)

**Compose (`src/server/app/compose.ts`):**
```ts
const hub = createSyncHub({ source: sessions, instance, validation: config.validation }); // unverändert
// SyncHub implementiert RemoteHubAttach – derselbe Hub geht an den Fernzugang (WP-78a, Name dort):
const remoteAccess = createRemoteAccessService({ /* … */ hub, blobs, files, logger });
```

**Listener (WP-78a, `src/server/remote/**`):**
- WebSocket-Upgrade auf `REMOTE_PATHS.ws`: erst Klasse `peer` und aktuelle Generation des Sockets prüfen, dann
  `hub.handleRemoteConnection(socket, { address, port })`. Anfragen mit `Origin`, `Sec-Fetch-*` oder `Cookie` hat der
  Listener vorher abgewiesen (§B.6, `browser_rejected`).
- Aufheben, Schlüssel erneuern, „Freigeben aus“, Rollenwechsel: in Schritt 1 (§B.8) `hub.closeRemote(WS_CLOSE.HOST_REVOKED)`
  (bzw. ein passender Code beim Beenden), danach die `peer`-Sockets zerstören.
- Inhaltsrouten auf der eigenen Fastify-Instanz von `peerHttp`, ohne Cookie-Prüfung:
  ```ts
  await registerContentRoutes(peerApp, {
    paths: REMOTE_PATHS, // blob, file, attachments
    blobs,
    files,
    beforeEffect: (request) => socketStillCurrent(request.raw.socket), // Klasse peer + aktuelle Generation
    logger,
  });
  ```
  `REMOTE_PATHS.blob` enthält `:blobId` (sonst wirft die Registrierung). Die Header setzt `content.ts`; der Listener
  braucht keine eigenen.
- Health, `pair` und `peer/self` bleiben Sache von WP-78a.

**Host-Befehle:** `multiHost.configure` und `remoteAccess.*` an den Dienst von WP-78a routen (heute antwortet der
Manager `NOT_IMPLEMENTED`). Die UI braucht dazu nichts weiter: Sie sendet über die lokale Verbindung und liest
`HostState.multiHost` und `HostState.remoteAccess`.

**Shell:** `'multiHost'` in `SETTINGS_SECTIONS` (`src/web/shell/requests.ts`) nach `'server'` aufnehmen, damit
`{kind: 'settings', section: 'multiHost'}` (Kopfzeilen-Symbol, Hinweis auf abgelehnte Versuche – WP-80) den Bereich
direkt öffnen kann. `SettingsPage.tsx` verträgt beide Stände; danach kann die lokale Ergänzung `PAGE_SECTIONS` dort
entfallen. Den Reiter-Text liefert schon `preferences.sections.multiHost`.

## 4. Checks
- `pnpm typecheck` grün; `pnpm exec eslint` auf alle eigenen Pfade grün.
- `pnpm exec vitest run src/server/sync src/server/http src/web/features/preferences` grün (Zahlen im Bericht).
- Kein voller Lauf (`pnpm check`/`test`/`build`/`e2e`) – macht der Koordinator nach dem Merge.

## 5. Offene Punkte
- Kopfzeilen-Symbol (verbunden, abgelehnte Versuche) und der Teil „Andere steuern“ kommen mit WP-80.
- Die Prüfungen und Texte `checks.details.*` sind allgemein gehalten; liefert WP-78a in `params` genauere Angaben
  (z. B. eine fehlende Firewall-Regel je Profil), kann WP-82 die Texte schärfen.
