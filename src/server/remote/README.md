# src/server/remote – Fernzugang des freigebenden Rechners (Mehrere Rechner)

Normativ: `docs/wp/WP-76.md` §B (Listener, Kopplung, Verbindungsbeweis, Aufheben), Plan `docs/wp/WP-75.md` §4.2. Der
Listener ist die einzige Stelle, die nicht nur auf `127.0.0.1` lauscht (ADR-205); ab Werk zu.

| Datei | Inhalt | Owner |
| --- | --- | --- |
| `ports.ts` | `RemoteAccessService`, `RemoteHubAttach`, `PeerStore`, `RemoteEventLog`, `ConnectionOrigin` | Koordinator (eingefroren) |
| übrige | Listener (`tls.createServer`, Klassifizierung, zwei `http.Server`), Kopplungsfenster, Peer-Store, Verbindungsprotokoll, Prüfungen, `remoteAccess.*` | WP-78 |
