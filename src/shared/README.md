# src/shared – Contracts (Server und Web)

Isomorpher Code, den Server **und** Web importieren (Alias `@shared/*`). Design: `docs/wp/WP-02.md`,
Überblick: `docs/architecture.md`. zod-Schemas sind die Quelle der Wahrheit (`Typ = z.infer<…>`).

| Modul | Inhalt |
|---|---|
| `common.ts` | IDs (`en_`/`cv_`/`dc_`/`cl_`/`pf_` + 32 Hex, UUIDs, Blob-IDs), `makeSessionKey`/`parseSessionKey`, Zeit, JSON, SDK-Enums (`PermissionMode`, `EffortLevel`, `RuleDestination`), `LIMITS` |
| `errors.ts` | Fehlercode-Katalog (`ERROR_CATALOG`), `ErrorPayload`/`ErrorInfo`, Mapper `startup_failure_reason`/`assistant.error` → Code |
| `status.ts` | `StatusFacts`, `deriveDisplayStatus`, `canSleep`, `notificationFor` |
| `model.ts` | Profile, Settings, Registry-Einträge/Unterhaltungen, Transkript-Items, Entscheidungen (Antworten = Absichten), Context/Rate-Limit, Host-Zustand, Summary, Detail |
| `protocol.ts` | WS-Nachrichten beider Richtungen, Befehle + Ergebnis-Schemas, `parseClientMessage`/`parseServerMessage`/`parseCommandResult` |
| `sync.ts` | reine Reducer für Server-Hub und Web-Store: `applySessionOp(s)`, `applySeqOps`, `mergeItems`, `trimItems` |
| `build.ts` | `BUILD_ID` (`pnpm build` bettet sie per `define` ein, sonst `'dev'`) |
| `samples.ts` | gültige Beispielobjekte (feste IDs/Zeiten) für Tests und Playground |
| `product.ts` | Produktname an genau einer Stelle (WP-00) |

Tests liegen daneben (`*.test.ts`, Typ-Tests in `contracts.types.test.ts`).

- Import-Reihenfolge ohne Zyklen: `common` → `errors` → `status` → `model` → `protocol` → `sync`.
- Nur `zod` und relative Shared-Module; kein DOM, keine Node-APIs, keine SDK-Typen
  (tsconfig ohne `lib: DOM` und ohne `@types/node`, ESLint `no-restricted-imports`).
- Importiert nie aus `src/server` oder `src/web`.
- **Eingefroren:** Änderungen nur nach Freigabe des Koordinators (Anfrage im WP-Bericht unter
  „SCHNITTSTELLEN/CONTRACT-ABWEICHUNGEN“) und mit Eintrag im Contract-Changelog (`docs/progress.md`).
