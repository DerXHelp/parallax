# src/web – Web-UI (Vite + React 19 + Tailwind v4 + shadcn/ui)

Vite-Root. Einstieg: `index.html` → `main.tsx` → `App.tsx` (Stub aus WP-00, WP-14 ersetzt ihn;
WP-20 setzt dort die `FeatureSlots` mit den echten Komponenten). Design-Tokens (Dark Default über
`class="dark"` auf `<html>`, Light in `:root`) in `index.css`. Datei-genaue Ownership:
`docs/architecture.md` §2.1/§2.3; diese README pflegt der Koordinator.

| Ordner | Inhalt | Owner-WP |
| --- | --- | --- |
| `shell/` | App-Shell (Sidebar, Kopfleiste), `slots.tsx` (`FeatureSlots`, `FeatureSlotsProvider`) | 14 |
| `ui/` | UI-Primitives (shadcn/ui auf Radix), nur mit Design-Tokens | 14 (Welle 1b: nur lesen) |
| `lib/` | Web-Helfer (`cn.ts`, `ids.ts`, …) – vor dem Anlegen greppen | 14 (Welle 1b: nur lesen) |
| `i18n/` | `t()`, Shell-Wörterbücher, `errors.*`, Registrierung der Feature-Namespaces | 14 (Welle 1b: nur lesen) |
| `state/` | Zustand-Stores, WS-Client / ConnectionManager (host-fähig), `auth.ts` | 14 (Welle 1b: nur lesen) |
| `playground/` | Playground-Route (`#playground`, nur Dev), findet `features/*/playground.tsx` | 14 |
| `public/` | statische Dateien ohne Hash (`favicon.svg`), landen in `dist/web/` | 14 |
| `notifications/` | Zustellung der Server-Benachrichtigungen (In-App/Web Notification), Töne, „Töne aktivieren“ | 20b, 38 |
| `features/transcript/` | Transkript (inkl. eigenem `i18n/`, `playground.tsx`) | 15 |
| `features/decisions/`, `features/composer/` | Entscheidungen, Composer (dito) | 16 |
| `features/profiles/`, `features/preferences/` | Phase 2: Profil-Editor (Slot `ProfilesSettings`), Einstellungsseite (Slot `SettingsPage`) | 36, 38 |

Regeln: nie Server-Code importieren (tsconfig `rootDir` + ESLint); kein UI-String ohne `t()`
(ESLint `react/jsx-no-literals`); Alias `@web/*` und `@shared/*`; Features importieren einander
nie (gemeinsame Komponenten über `FeatureSlots`; ESLint erzwingt die Grenzen, architecture §2.3h).
Features dürfen Shell-Bausteine importieren (z. B. `shell/HostFacts.tsx`), die Shell nie Features;
reine Helfer gehören nach `lib/` (ADR-126).
Dev-Server: `pnpm dev:web` (Port 5173, je Worktree `PARALLAX_DEV_WEB_PORT`).
