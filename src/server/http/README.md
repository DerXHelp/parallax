# src/server/http – HTTP/WS-Schicht (WP-10)

Fastify-App, Konfiguration der Routen unter `/api/*` (auch der WebSocket-Endpunkt, z. B.
`/api/ws`, damit der Vite-Dev-Proxy greift), Auth per Einmal-Code und HttpOnly-Cookie,
Origin-/Host-/`Sec-Fetch-Site`-Prüfung, CSP, statische Auslieferung von `dist/web`.
Details: `docs/plan.md`, Review A.8 und C.10.
