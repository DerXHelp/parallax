# src/server/hosts – Rechnerliste und Vermittler des steuernden Rechners (Mehrere Rechner)

Normativ: `docs/wp/WP-76.md` §B.6–B.9, Plan `docs/wp/WP-75.md` §4.3. Der Browser spricht nur mit diesem Server; der
Vermittler reicht Fenster-Verbindungen und Inhalte über gepinnte mTLS-Verbindungen an die anderen Rechner weiter.

| Datei | Inhalt | Owner |
| --- | --- | --- |
| `ports.ts` | `HostsService`, `HostForwarder`, `RelayEvents`, `HostForwarderError` | Koordinator (eingefroren) |
| übrige | `hosts.json`, Kopplung als Client, Agent je Kopplung, Status/Version, Wächter, `hosts.*` | WP-79 (Wächter-Toast: WP-81) |
