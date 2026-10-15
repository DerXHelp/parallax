# src/web/state – Client-State (WP-14)

Zustand-Stores (Selektoren pro Session), WS-Client mit Resync (`hello`, `serverInstanceId`,
`buildId`), ConnectionManager für n Hosts (anfangs nur „local“, Session-Keys `hostId:entryId`),
Präsenz-Meldungen. Dateinamen und Hooks: `docs/wp/WP-02.md` §10.3 (`transport.ts`,
`connection.ts`, `hooks.ts`).

- `auth.ts`: Client-Ablauf aus `docs/architecture.md` §5.1 (`#code=` lesen und entfernen →
  `POST /api/auth` → `GET /api/auth/status` → erst dann WS; nach Close 1006 wieder Status fragen),
  Contract `@shared/http`.
- In Welle 1b read-only. Feature-eigener State (z. B. Composer-Entwürfe im `localStorage`) liegt im
  Feature-Ordner (`features/<f>/state/`).
