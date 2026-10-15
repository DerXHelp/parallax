# Parallax launcher without installation (Plan "Server-Betrieb", WP-21) for PowerShell: builds dist\
# if needed, starts the server hidden in the background and opens an Edge app window - or, if
# Parallax already runs, only another window. Options: .\parallax.ps1 --help (README "Starten").
$ErrorActionPreference = 'Stop'
$root = $PSScriptRoot
$tsx = Join-Path $root 'node_modules\tsx\dist\cli.mjs'
if (-not (Test-Path -LiteralPath $tsx)) {
  Write-Host "Parallax: dependencies are missing - run 'pnpm install' in $root first."
  exit 1
}
# Only an application from the PATH (PowerShell never runs programs from the current directory).
$node = Get-Command -Name node -CommandType Application -ErrorAction SilentlyContinue | Select-Object -First 1
if ($null -eq $node) {
  Write-Host 'Parallax: Node.js was not found on the PATH - install Node.js 22 or newer.'
  exit 1
}
& $node.Source $tsx --tsconfig (Join-Path $root 'src\server\tsconfig.json') (Join-Path $root 'src\server\launcher\main.ts') @args
exit $LASTEXITCODE
