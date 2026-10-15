# src/server/claude – Claude-Integration (WP-11)

Wie Parallax das installierte `claude` findet, startet und prüft. Details und Entscheidungen:
`docs/wp/WP-11.md`; Grundlagen `docs/plan.md` („Claude-Auflösung“, „Claude-Profile“, Review C.2,
C.3, C.7, C.12).

- **Port (eingefroren seit WP-02, Änderung nur per Contract-Änderung):** `ports.ts` –
  `ProfileSdkOptions`, `ProfileArgsResult`, `ProfileArgIssueParams`, `ParseProfileArgs`,
  `LaunchSpec`, `ProfileStore`, `ClaudeIntegration`.
- Prozesse nur über `lib/process.ts` (gehört WP-11), Pfadprüfungen nur über `@shared/paths` –
  kein eigener Pfad-Helfer in diesem Ordner (R0-02).

| Datei | Inhalt (wichtigste Exporte) |
| --- | --- |
| `integration.ts` | `createClaudeIntegration(deps)` → `ClaudeIntegration` (`launchSpecFor`, `checkProfile` = „Profil testen“), `profileNeedsSetup(status)`; liest die persistente Umgebung einmal (`deps.persistentEnv`, Default Registry) |
| `env.ts` | `buildEnv(input)` / `buildEnvReport(input)` – **die eine** Env-Funktion für SDK, Terminal, Konsole, „Profil testen“ (C.2, A.7, R1-03); `envRemovalReason` (`session`/`run_state`/`machine_overridable`), Option `persistent` (Nexus-Ausnahme, ADR-021) und `target: 'sdk' \| 'terminal'` (`TERMINAL_TOOL_SHELL_VARS`), `CLAUDE_CODE_ENV_ALLOWLIST`, `clientAppId`, `setEnvVar`/`deleteEnvVar` (case-insensitiv; `getEnvVar` in `lib/windows.ts`) |
| `resolveClaude.ts` | `resolveClaude`/`findClaude` (Profil-Pfad → `where claude`, nur `.exe`, npm-Shim → `bin\claude.exe`), `resolveClaudeShim`, `parseClaudeVersion`, `compareVersions`, `cliVersionStatus` (C.7), `readSdkManifest`, `whereOnPath` – `searchPath`/`resolveCmdShim`/`createMemoryFs` liegen seit R1-08 in `lib/windows.ts` |
| `profileArgs.ts` | `parseProfileArgs` (C.12, rein), `BLOCKED_PROFILE_FLAGS`, `isBroadToolRule`, `splitToolList` |
| `profiles.ts` | `STANDARD_PROFILE` (eingebaut, Default), `createProfileStore()`, `profileSummary()` |
| `authStatus.ts` | `parseAuthStatus` (`claude auth status --json` → Contract-Sicht ohne E-Mail/Org), `parseRawAuthStatus` (nur Recorder) |
| `preflight.ts` | Checks und Formatierung für `pnpm preflight` (`runPreflight`, `formatPreflight`, `findPnpm`, `checkAntivirus`/`antivirusProducts` – V1-08); `findEdge` liegt seit R1-08 in `lib/edge.ts` |

Regeln:
- Jeder `claude`-Start und jeder Aufruf von `claude --version`/`auth status` bekommt sein Env aus
  `buildEnv()` – nie `process.env` direkt (Session-Variablen der aufrufenden Claude-Session).
- E-Mail und Organisation aus `auth status` werden nie geloggt, gespeichert oder gesendet.
- Tests laufen nur mit Stubs (`createMemoryFs`, `where`-/`runFile`-Stubs); kein Live-`claude`.
