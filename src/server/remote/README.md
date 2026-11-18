# src/server/remote – Fernzugang des freigebenden Rechners (Mehrere Rechner)

Normativ: `docs/wp/WP-76.md` §B (Listener, Kopplung, Verbindungsbeweis, Aufheben), Plan `docs/wp/WP-75.md` §4.2;
Umsetzung, Abweichungen und Verdrahtung `docs/wp/WP-78a.md`. Der Listener ist die einzige Stelle, die nicht nur auf
`127.0.0.1` lauscht (ADR-205); ab Werk zu.

| Datei | Inhalt | Owner |
| --- | --- | --- |
| `ports.ts` | `RemoteAccessService`, `RemoteHubAttach`, `PeerStore`, `RemoteEventLog`, `ConnectionOrigin` | Koordinator (eingefroren) |
| `service.ts` | `createRemoteAccessService` – Prüfungen, Listener, Kopplungsfenster, Kopplung, `remoteAccess.*`, `state()`, Generation | WP-78a |
| `listener.ts` | `net.Server` (Grenzen vor TLS) → `tls.Server` ohne Port; Klassifizierung in `secureConnection`, Verbindungsbeweis, Socket-Listen | WP-78a |
| `peerHttp.ts` | Fastify ohne `listen` für den gekoppelten Rechner: Allowlist, Health, `DELETE peer/self`, WebSocket → Hub, `registerContent` | WP-78a |
| `pairingHttp.ts` | `http.Server` ohne Port nur für `POST /remote/v1/pair` (Header/Body 4 KiB, 15 s, eine Anfrage je Socket) | WP-78a |
| `pairing.ts` | Prüfung einer Kopplung (§B.7 Schritte 6–7) | WP-78a |
| `pairingWindow.ts` | Kopplungsfenster: Code (16 Byte), 10 min, 3 Fehlversuche, einmalig | WP-78a |
| `peerStore.ts` | `remote/peer.json`: die eine Kopplung, aufgehobene Pins (strikt, ohne `.bak`) | WP-78a |
| `eventLog.ts` | `remote/events.json`: Verbindungsprotokoll (zusammengefasst je Adresse+Art und Minute, Ringpuffer) | WP-78a |
| `checks.ts`, `firewall.ts` | Prüfungen `port`, `keys`, `keystore`, `tls`, `addresses`, `firewall` (Firewall nur lesen) | WP-78a |
| `hubSocket.ts` | `GuardedHubSocket`: WebSocket für den Hub, verwirft alles nach einem Generationswechsel | WP-78a |
| `headers.ts`, `addresses.ts`, `limits.ts` | Browser-/Versions-Header, Adressen und Namen, Grenzen (§B.10) und Zähler | WP-78a |
| `testKit.ts` | Test-Helfer (Dienst auf `127.0.0.1:0`, Fake-Hub, Kopplung und Agent) – nur für Tests | WP-78a |
| `src/server/http/content.ts` | Blob/Datei/Anhänge über `registerContent` | WP-78b |

Regeln: Code und Fenster nie in `HostState`, Ops oder Logs; vor jeder Wirkung `isCurrentConnection()` (Generation);
Tests binden nur `127.0.0.1` mit Port 0.
