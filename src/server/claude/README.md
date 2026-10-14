# src/server/claude – Claude-Integration (WP-11)

`resolveClaude` (Settings → `where claude` → npm-Shim auf `claude.exe` auflösen; nur `.exe`),
`buildEnv()` (entfernt Session-Variablen der aufrufenden Claude-Session wie `CLAUDECODE` und
`CLAUDE_CODE_*`, case-insensitives Mischen, setzt `PARALLAX=1` usw.), Profil „Standard“,
Checks für `pnpm preflight`. Details: `docs/plan.md`, Review C.2 und C.7.
