# src/shared – Contracts (Server und Web)

Isomorpher Code, den Server **und** Web importieren (Alias `@shared/*`).

- Inhalt ab WP-02: `protocol.ts` (WS-Nachrichten, zod), `model.ts`, `errors.ts` (Fehlercodes),
  `status.ts` (`deriveDisplayStatus()`), `AgentBackend`-Interface.
- Kein DOM, keine Node-APIs (tsconfig ohne `lib: DOM` und ohne `@types/node`).
- Importiert nie aus `src/server` oder `src/web`.
- **Tabu ohne Freigabe** des Koordinators. Änderungen nur per Anfrage im WP-Bericht
  und Eintrag im Contract-Changelog (`docs/progress.md`).
- Bereits vorhanden (WP-00): `product.ts` – Produktname an genau einer Stelle.
