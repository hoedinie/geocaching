param(
  [Parameter(ValueFromRemainingArguments = $true)]
  [string[]] $ScriptArgs
)

$ErrorActionPreference = "Stop"

$workspaceNode = Join-Path $PSScriptRoot "node_modules/.bin"
$bundledNode = Join-Path $HOME ".cache/codex-runtimes/codex-primary-runtime/dependencies/node/bin"
$nodeExe = Join-Path $bundledNode "node.exe"

if (-not (Test-Path $nodeExe)) {
  $nodeExe = "node"
}

$env:PATH = "$workspaceNode;$bundledNode;$env:PATH"
& $nodeExe (Join-Path $PSScriptRoot "update-fn-coordinates.mjs") @ScriptArgs
exit $LASTEXITCODE
