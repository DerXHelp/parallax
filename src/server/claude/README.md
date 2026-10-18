# src/server/claude – Claude-Integration (WP-11, Phase 2: WP-32)

Wie Parallax das installierte `claude` findet, startet und prüft. Details und Entscheidungen:
`docs/wp/WP-11.md`, Phase 2 (Profil-Store, Profilbefehle, Konsolenstart, Preflight aller Profile):
`docs/wp/WP-32.md`; Grundlagen `docs/plan.md` („Claude-Auflösung“, „Claude-Profile“, Review C.2,
C.3, C.7, C.12), ADR-102, ADR-104.

- **Port (eingefroren seit WP-02, Änderung nur per Contract-Änderung):** `ports.ts` –
  `ProfileSdkOptions`, `ProfileArgsResult`, `ProfileArgIssueParams`, `ParseProfileArgs`,
  `LaunchSpec`, `ProfileStore`, `ConsoleLaunchRequest`, `ConsoleLaunchSpec`, `ClaudeIntegration`.
- Prozesse nur über `lib/process.ts` (gehört WP-11), Pfadprüfungen nur über `@shared/paths` –
  kein eigener Pfad-Helfer in diesem Ordner (R0-02).

| Datei | Inhalt (wichtigste Exporte) |
| --- | --- |
| `integration.ts` | `createClaudeIntegration(deps)` → `ClaudeIntegration` (`launchSpecFor`, `checkProfile` = „Profil testen“, Phase 2 `consoleLaunchFor(req)`), `profileNeedsSetup(status)`; liest die persistente Umgebung einmal (`deps.persistentEnv`, Default Registry); `deps.profiles` = `PersistentProfileStore` oder `MutableProfileStore`, Auflösungs-Cache je Profil mit Schlüssel (Executable, Env, Config-Ordner), verworfen über `onChange`; `launchSpecFor` lehnt jedes Fehler-Issue ab (`PROFILE_INVALID {count}`) |
| `env.ts` | `buildEnv(input)` / `buildEnvReport(input)` – **die eine** Env-Funktion für SDK, Terminal, Konsole, „Profil testen“ (C.2, A.7, R1-03); `envRemovalReason` (`session`/`run_state`/`machine_overridable`), Option `persistent` (Nexus-Ausnahme, ADR-021) und `target: 'sdk' \| 'terminal'` (`TERMINAL_TOOL_SHELL_VARS`), `CLAUDE_CODE_ENV_ALLOWLIST`, `clientAppId`, `setEnvVar`/`deleteEnvVar` (case-insensitiv; `getEnvVar` in `lib/windows.ts`) |
| `resolveClaude.ts` | `resolveClaude`/`findClaude` (Profil-Pfad → `where claude`, nur `.exe`, npm-Shim → `bin\claude.exe`), `resolveClaudeShim`, `parseClaudeVersion`, `compareVersions`, `cliVersionStatus` (C.7), `readSdkManifest`, `whereOnPath` – `searchPath`/`resolveCmdShim`/`createMemoryFs` liegen seit R1-08 in `lib/windows.ts` |
| `profileArgs.ts` | `parseProfileArgs` (C.12, rein), `BLOCKED_PROFILE_FLAGS`, `isBroadToolRule`, `splitToolList` |
| `profiles.ts` | `STANDARD_PROFILE` (eingebaut, Default), `createProfileStore()` → `MutableProfileStore` (im Speicher), `profileSummary(profile, claude, issues = [])`, `uncheckedClaudeStatus`; Phase 2: `isSecretEnvKey(name)` (`*_KEY`, `*_TOKEN`, `*_SECRET`, `*PASSWORD*`, case-insensitiv), `registerEnvSecrets(env)` |
| `profileStore.ts` | Phase 2 (ADR-102): `openProfileStore({home, warnings, …})` → `PersistentProfileStore` (`JsonStore` über `PROFILES_FILE` = `profiles.json`, Schema v1, `.bak`, Quarantäne, `StoreVersionTooNewError`; ohne Datei nur „Standard“ im Speicher, geschrieben erst bei `save`/`setDefault`; `onChange`, `issuesOf`), `PROFILES_MIGRATIONS`, `normalizeProfiles(list)` (rein: „Standard“ ergänzt, doppelte IDs, genau ein Default) + `ProfilesRepair`, `readProfilesFile(home, fs?)` (nur lesend, für den Preflight) + `ProfilesFileRead`, `profilesOf(read)`, `defaultProfileIssueContext()` |
| `profileIssues.ts` | Phase 2, rein: `profileIssues(profile \| input, ctx)` – Befunde sortiert Fehler → Warnungen → Infos (Arg-Fehler, `PROFILE_INVALID {field: 'executable' \| 'configDir', reason}`, `VALIDATION_FAILED {path: 'profile.env', key}`, `PROFILE_ENV_REF_UNRESOLVED`, `PROFILE_ARG_PASSED_RAW`), `ProfileIssueContext`, `executableIssue(executable, exists)` + `ExecutableIssueReason`, `errorCount(issues)` |
| `profileCommands.ts` | Phase 2 (ADR-101): `createProfileCommands({store, integration, entryCount, now})` → `HostCommandHandler` für `PROFILE_COMMAND_NAMES` (`profile.get`, `profile.save`, `profile.delete` – `PROFILE_NOT_DELETABLE` vor `PROFILE_IN_USE {count}` –, `profile.setDefault`, `profile.test`, `profile.validate`), `ProfileCommandDeps` |
| `consoleCommand.ts` | Phase 2, rein (ADR-104): `consoleCommandText(spec)` – der Kopierbefehl „Konsolenbefehl kopieren“ als eine PowerShell-Zeile (`Set-Location -LiteralPath`, `$env:NAME=…`, `& { $PSNativeCommandArgumentPassing='Legacy'; & '<exe>' <args> }`, für 5.1 und 7.3+), `powerShellLiteral`, `powerShellEnvVariable`, `nativeCommandArg` (MSVC-Quoting) |
| `authStatus.ts` | `parseAuthStatus` (`claude auth status --json` → Contract-Sicht ohne E-Mail/Org), `parseRawAuthStatus` (nur Recorder) |
| `preflight.ts` | Checks und Formatierung für `pnpm preflight` (`runPreflight`, `formatPreflight`, `findPnpm`, `checkAntivirus`/`antivirusProducts` – V1-08); Phase 2 alle Profile: `loadPreflightProfiles(home, fs?)` (nur lesend), `checkProfilesSource(read)` (Zeile `profiles`), `checkProfileIssues(profile, issues)` (je Profil `config:<id>` vor `claude`/`login`), `describeProfileIssue(issue)`; `findEdge` liegt seit R1-08 in `lib/edge.ts` |

`consoleLaunchFor` (Kurzfassung, WP-32): Profil laden → unsicherer `cwd` → `PATH_REJECTED {reason,
field: 'cwd'}` → Fehler-Issues → `PROFILE_INVALID {count}` → `buildEnv(target 'terminal')` → `.exe`
wie `launchSpecFor`; `explicitEnv` = Profil-Env-Namen mit aufgelösten Werten + `CLAUDE_CONFIG_DIR`;
`args` = Profil-Args + `--resume <id>` (+ `--model`/`--permission-mode`/`--settings`, wenn gesetzt und
nicht schon in den Args). Nutzer: `sessions/external.ts` (Konsole und Kopierbefehl, WP-34).

Regeln:
- Jeder `claude`-Start und jeder Aufruf von `claude --version`/`auth status` bekommt sein Env aus
  `buildEnv()` – nie `process.env` direkt (Session-Variablen der aufrufenden Claude-Session).
- E-Mail und Organisation aus `auth status` werden nie geloggt, gespeichert oder gesendet.
- `ConsoleLaunchSpec.explicitEnv` und der Kopierbefehl enthalten Secrets im Klartext (gewollt,
  ADR-104) – nie loggen; Secret-Werte werden per `registerSecret` registriert.
- Der Preflight liest `profiles.json` nur (keine Quarantäne, keine `.bak`, keine Reparatur) und zeigt
  nie Env-Werte.
- Tests laufen nur mit Stubs (`createMemoryFs`, `where`-/`runFile`-Stubs); kein Live-`claude`.
