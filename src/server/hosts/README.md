# src/server/hosts – Rechnerliste und Vermittler des steuernden Rechners (Mehrere Rechner)

Normativ: `docs/wp/WP-76.md` §B.6–B.9, Plan `docs/wp/WP-75.md` §4.3. Der Browser spricht nur mit diesem Server; der
Vermittler reicht Fenster-Verbindungen und Inhalte über gepinnte mTLS-Verbindungen an die anderen Rechner weiter.

| Datei | Inhalt | Owner |
| --- | --- | --- |
| `ports.ts` | `HostsService`, `HostForwarder`, `RelayEvents`, `HostForwarderError` | Koordinator (eingefroren) |
| `service.ts` | `createHostsService(options) → Hosts` (Port + `prepare`, `close`, `windowCount`), `HOSTS_COMMANDS` | WP-79 |
| `link.ts` | `HostLink` je Rechner (Wächter, Fenster, Anfragen, `DELETE peer/self`), `upstreamRequest`, `HOSTS_TIMING`, `HOST_LIMITS` | WP-79 |
| `store.ts` | `createHostsStore` – `hosts.json` (strikt, atomar, Quarantäne, Sperre bei neuerer Version) | WP-79 |
| `naming.ts` | `slugify`, `uniqueHostId`, `pickColor` | WP-79 |
| `failures.ts` | `connectionFailure` – `PinnedConnectionError` → `HOST_UNREACHABLE {reason}` bzw. abgelehnter Schlüssel | WP-79 |
| `windows.ts` | Schließcodes weitergeleiteter Fenster (`markWindowClosed`, `browserCloseCode`, `forwarderErrorCloseCode`) | WP-79 |
| `testKit.ts` | **nur Tests:** `startSharing` (echter freigebender Rechner mit Hub), `startControl`, `hostCommand`, `rejection` | WP-79 |
| `*.test.ts` | Namen/Fehler, `hosts.json`, Dienst gegen einen echten freigebenden Rechner | WP-79 |

Ablauf, Entscheidungen und Verdrahtung: `docs/wp/WP-79.md`. Die Vermittler-Routen liegen in
`src/server/http/hostRoutes.ts` und `hostSocket.ts` (Option `hosts` von `createApp`); den Wächter-Toast baut WP-81 über
`onRelay`.

- **Rolle `control`:** `activate` lädt die Schlüssel nacheinander im Hintergrund und startet je Rechner einen Wächter;
  `deactivate` beendet alles, die Kopplungen bleiben. `hosts.*` nur bei aktiver Rolle (sonst `REMOTE_ROLE_CONFLICT`).
- **Geheimnisse:** Code, kAuth und private Schlüssel nie in Log, Fehlern, `HostState` oder Ergebnissen; kAuth liegt als
  DPAPI-Chiffrat (`auth:<hostId>`) in `hosts.json`, der Kopplungsschlüssel als Schlüsseldatei `coupling:<hostId>`.
- **Status:** `connecting` → `connected` (Wächter-`hello` mit gleicher Version) bzw. `unreachable` (Backoff),
  `incompatible` und `revoked` warten auf `hosts.reconnect` bzw. neue Kopplung (`hosts.add` mit `replaceHostId`).
