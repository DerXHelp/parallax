# src/web – Web-UI (Vite + React 19 + Tailwind v4 + shadcn/ui)

Vite-Root. Einstieg: `index.html` → `main.tsx` → `App.tsx` (Stub aus WP-00, WP-14 ersetzt ihn).
Design-Tokens (Dark Default über `class="dark"` auf `<html>`, Light in `:root`) in `index.css`.

| Ordner      | Inhalt                                                             | Owner-WP   |
| ----------- | ------------------------------------------------------------------ | ---------- |
| `ui/`       | UI-Primitives (shadcn/ui auf Radix), nur mit Design-Tokens         | 14, 15, 16 |
| `lib/`      | Web-Helfer (`cn.ts`, …) – vor dem Anlegen greppen                  | 14         |
| `i18n/`     | `en.ts` (Default) + `de.ts` (Typ von `en`), `t()`-Helper           | 14         |
| `state/`    | Zustand-Stores, WS-Client / ConnectionManager (host-fähig)         | 14         |
| `features/` | Feature-Bereiche: Transkript (15), Entscheidungen + Composer (16)  | 15, 16     |

Regeln: nie Server-Code importieren (tsconfig `rootDir` + ESLint); kein UI-String ohne `t()`
(ESLint `react/jsx-no-literals`); Alias `@web/*` und `@shared/*`.
