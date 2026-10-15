# src/server/claude – Claude-Integration (WP-11)

`resolveClaude` (Settings → `where claude` → npm-Shim auf `claude.exe` auflösen; nur `.exe`),
`buildEnv()` (entfernt Session-Variablen der aufrufenden Claude-Session wie `CLAUDECODE` und
`CLAUDE_CODE_*`, case-insensitives Mischen, setzt `PARALLAX=1` usw.), `parseProfileArgs` (C.12,
reine Funktion, Codes `PROFILE_*`), Profil „Standard“, Checks für `pnpm preflight`. Details:
`docs/plan.md`, Review C.2, C.7, C.12.

- **Port (eingefroren seit WP-02, Änderung nur per Contract-Änderung):** `ports.ts` –
  `ProfileSdkOptions`, `ProfileArgsResult`, `ProfileArgIssueParams`, `ParseProfileArgs`,
  `LaunchSpec`, `ProfileStore`, `ClaudeIntegration`. Modulnamen fest: `resolveClaude.ts`, `env.ts`,
  `profileArgs.ts`, `profiles.ts`, `authStatus.ts`, `integration.ts`, `preflight.ts`.
- Prozesse nur über `lib/process.ts` (gehört WP-11), Pfadprüfungen nur über `@shared/paths` –
  kein eigener Pfad-Helfer in diesem Ordner (R0-02).
