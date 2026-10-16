# src/shared – Contracts (Server und Web)

Isomorpher Code, den Server **und** Web importieren (Alias `@shared/*`). Design: `docs/wp/WP-02.md`,
Überblick und R0-Ergänzungen: `docs/architecture.md`. zod-Schemas sind die Quelle der Wahrheit
(`Typ = z.infer<…>`).

| Modul | Inhalt |
|---|---|
| `common.ts` | IDs (`en_`/`cv_`/`dc_`/`cl_`/`pf_` + 32 Hex, UUIDs, Blob-IDs), `makeSessionKey`/`parseSessionKey`, Zeit, JSON, SDK-Enums (`PermissionMode`, `EffortLevel`, `RuleDestination`) mit toleranten Lesern (`parsePermissionMode`, `parseEffortLevels`, `unknownEnumCountKey`), `LIMITS`, `modelNameSchema` |
| `errors.ts` | Fehlercode-Katalog (`ERROR_CATALOG`, inkl. `PROFILE_*`, `LAUNCHER_TOKEN_INVALID`, `SESSION_HELD_ELSEWHERE`), `ErrorPayload`/`ErrorInfo`, Mapper `startup_failure_reason`/`assistant.error` → Code, `PROFILE_ARG_INVALID_REASONS` |
| `status.ts` | `StatusFacts`, `deriveDisplayStatus` (inkl. `needs-resume`, ADR-016), `canSleep`, `notificationFor` |
| `model.ts` | Profile, Settings, Registry-Einträge/Unterhaltungen, Transkript-Items, Entscheidungen (Antworten = Absichten, Records mit Snapshot), Context/Rate-Limit, Host-Zustand, Summary, Detail |
| `protocol.ts` | WS-Nachrichten beider Richtungen, Befehle + Ergebnis-Schemas, `parseClientMessage`/`parseServerMessage`/`parseCommandResult` |
| `sync.ts` | reine Reducer für Server-Hub und Web-Store: `applySessionOp(s)`, `applySeqOps`, `mergeItems`, `trimItems` |
| `http.ts` | HTTP-/Auth-Contract (ADR-015): `API_PATHS`, Request/Response-Schemas, `authCookieName(port)`, Einmal-Code und Launcher-Token, `takeAuthCodeFromHash`, `allowedHosts`/`allowedOrigins`, Lockfile-Schema |
| `paths.ts` | reine Windows-Pfadregeln (C.10, ADR-017): `windowsPathIssue`, `isSafeWindowsPath`, `windowsPathKey`, `windowsPathsEqual`, `isWindowsPathInside` – die einzige Implementierung |
| `build.ts` | `BUILD_ID` (`pnpm build` bettet sie per `define` ein, sonst `'dev'`) |
| `samples.ts` | gültige Beispielobjekte (feste IDs/Zeiten) für Tests und Playground |
| `product.ts` | Produktname an genau einer Stelle (WP-00) |
| `devPorts.ts` | `DEV_WEB_PORT` ohne eigene Importe (Root-Configs laden es; `http.ts` re-exportiert) |
| `version.ts` | Versionsregel C.7: `compareVersions`, `cliVersionStatus` – die einzige Implementierung (Server und Web re-exportieren, WP-30 §4.9) |

**Contracts v2 (Phase 2, `docs/wp/WP-30.md` §4):** `PROTOCOL_VERSION` 2, `REGISTRY_SCHEMA_VERSION` 2;
Settings (Benachrichtigungen, Leerlauf, `promptSuggestions`, Port, Autostart), Profil-Eingabe und
-Befunde, Entry/Summary (`gitBranch`, `external`, `continueAt`), System-Event `handoff`, Ordner-Browser
(`fsListingSchema`), Host-Befehle (`HOST_COMMAND_NAMES`), Upload-Schemas und Protokoll-URI (`http.ts`).

Tests liegen daneben (`*.test.ts`, Typ-Tests in `contracts.types.test.ts`).

- Import-Reihenfolge ohne Zyklen: `common` → `errors` → `status` → `model` → `protocol` → `sync`;
  `http` nach `protocol` (nutzt auch `model`); `paths` und `version` sind unabhängig.
- Nur `zod` und relative Shared-Module; kein DOM, keine Node-APIs, keine SDK-Typen
  (tsconfig ohne `lib: DOM` und ohne `@types/node`, ESLint `no-restricted-imports`).
- Importiert nie aus `src/server` oder `src/web`.
- **Eingefroren:** Änderungen nur nach Freigabe des Koordinators (Anfrage im WP-Bericht unter
  „SCHNITTSTELLEN/CONTRACT-ABWEICHUNGEN“) und mit Eintrag im Contract-Changelog (`docs/progress.md`).
