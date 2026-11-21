# src/server/secure – Schlüssel, Zertifikate, TLS-Profil (Mehrere Rechner)

Normativ: `docs/wp/WP-76.md` §B.3–B.5, B.7, B.9; Umsetzung und Abweichungen `docs/wp/WP-78a.md`. Gemeinsame
Krypto-Bausteine für den Fernzugang (`remote/`, freigebender Rechner) und die Rechnerliste (`hosts/`, steuernder
Rechner). Nur Node `crypto`/`tls`, keine eigene Kryptografie.

| Datei | Inhalt | Owner |
| --- | --- | --- |
| `ports.ts` | `KeyStore` (DPAPI), `IdentityStore` (Schlüsseldateien), `Identity`, `KeyStoreError` | Koordinator (eingefroren) |
| `tlsProfile.ts` | Die eine Stelle der Parameter (§B.3), Exporter-Labels, `profileViolation` | WP-78a |
| `der.ts` | DER-Baustein: selbstsigniertes ML-DSA-87-Zertifikat (X.509 v3, `CN=parallax`, ohne Erweiterungen) | WP-78a |
| `pins.ts` | SHA-384-Pins aus `X509Certificate(raw)`, `pinsEqual`/`bytesEqual` (konstante Zeit), PEM, SPKI eines Sockets | WP-78a |
| `identity.ts` | `generateIdentity` (nur im Speicher), `makeIdentity` (Prüfung nach dem Laden) | WP-78a |
| `keyStore.ts` | DPAPI (`CryptProtectData`, CurrentUser) über `node:ffi` im Serverprozess, ohne Kindprozess (ADR-228; Lader `lib/ffi.ts`, ADR-229) | WP-78a |
| `memoryKeyStore.ts` | `KeyStore` im Speicher für Tests | WP-78a |
| `identityStore.ts` | `keys/<purpose>.json`: Prüfung beim Laden, Quarantäne, `save` für Schlüssel aus dem Speicher | WP-78a |
| `strictJsonFile.ts` | Lesen/Schreiben von Dateien, deren Schreiben sicher feststehen muss (ohne `.bak`) | WP-78a |
| `pairingCrypto.ts` | `lp`, Transkript, `k`, `macA`/`macB`, `kAuth`, Base64url | WP-78a |
| `connectionProof.ts` | Verbindungsbeweis (§B.9) für beide Seiten, `readExactly` | WP-78a |
| `pinnedAgent.ts` | `PinnedAgent` (ein Agent je Kopplung), `remoteVersionHeaders`, `REMOTE_WS_CLIENT_OPTIONS` | WP-78a |
| `pairingClient.ts` | `pairWithHost` – Kopplung von der steuernden Seite (§B.7 Schritte 1–2, 5, 8) | WP-78a |
| `selfTest.ts` | Selbsttest der Prüfung `tls` (§B.11) | WP-78a |
| `testKit.ts` | Test-Helfer (fremde Zertifikate, TLS-Server auf `127.0.0.1:0`) – nur für Tests | WP-78a |
| `platformKeyStore.ts` | Auswahl je Plattform (§B.14): Windows DPAPI; Linux Secret Service → `systemd-creds` → Datei nur per Opt-in, Schema der vorhandenen Schlüsseldatei zuerst | WP-107 |
| `secretServiceKeyStore.ts` | Secret Service (libsecret über `node:ffi` in einem Worker mit Frist): je Zweck ein zufälliger AES-256-GCM-Schlüssel im Schlüsselbund | WP-107 |
| `systemdCredsKeyStore.ts` | `systemd-creds --user encrypt/decrypt`, Geheimnis nur über stdin/stdout, Zweck im Credential-Namen | WP-107 |
| `fileKeyStore.ts` | Opt-in `--key-store=file`: Geheimnis hinter einer Markierung, Schutz nur über Dateirechte (Warnung im Check `keystore`) | WP-107 |
| `privateFiles.ts` | Linux: Dateien 0600 in Ordnern 0700 (`privateFsOps`, `secureFsOps`), `checkPrivateFile` (Rechte, Eigentümer) | WP-107 |

Regeln: private Schlüssel und `kAuth` nie im Log, in Fehlern, in `HostState` oder im Browser; Vergleiche nur mit
`timingSafeEqual`; Prüfungen werfen nie (fail closed); Tests binden nur `127.0.0.1` mit Port 0.
