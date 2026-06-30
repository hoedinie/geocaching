$ErrorActionPreference = "Stop"

$workspaceNode = Join-Path $PSScriptRoot "node_modules/.bin"
$bundledNode = Join-Path $HOME ".cache/codex-runtimes/codex-primary-runtime/dependencies/node/bin"
$pnpm = Join-Path $HOME ".cache/codex-runtimes/codex-primary-runtime/dependencies/bin/pnpm.cmd"

$env:PATH = "$workspaceNode;$bundledNode;$env:PATH"

if (-not (Test-Path $pnpm)) {
  throw "Could not find bundled pnpm at $pnpm. Install Node.js and run: npx playwright install chromium"
}

& $pnpm exec playwright install chromium
