# src/server/secure – Schlüssel, Zertifikate, TLS-Profil (Mehrere Rechner)

Normativ: `docs/wp/WP-76.md` §B.3–B.5, B.9. Gemeinsame Krypto-Bausteine für den Fernzugang (`remote/`, freigebender
Rechner) und die Rechnerliste (`hosts/`, steuernder Rechner). Nur Node `crypto`/`tls`, keine eigene Kryptografie.

| Datei | Inhalt | Owner |
| --- | --- | --- |
| `ports.ts` | `KeyStore` (DPAPI), `IdentityStore` (Schlüsseldateien), `Identity`, `KeyStoreError` | Koordinator (eingefroren) |
| übrige | TLS-Profil (`tlsProfile.ts`), Zertifikat (DER-Baustein), Pins, DPAPI über PowerShell (stdin/stdout), Schlüsseldateien, Kopplungs-MACs, Verbindungsbeweis, `PinnedAgent` | WP-78 |

Regeln: private Schlüssel und `kAuth` nie im Log, in Fehlern, in `HostState` oder im Browser; Vergleiche nur mit
`timingSafeEqual`; Prüfungen werfen nie (fail closed).
