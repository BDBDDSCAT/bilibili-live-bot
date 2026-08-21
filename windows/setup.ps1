param(
  [string]$Room = "",
  [switch]$SkipTests
)

. (Join-Path $PSScriptRoot "common.ps1")

$root = Get-ProjectRoot
$node = Get-ProjectNode $root
Assert-NodeVersion $node
$npmCli = Get-ProjectNpmCli $root $node
$env:PATH = "$(Split-Path -Parent $node);$env:PATH"
Set-Location -LiteralPath $root

Write-Host "Project: $root"
Write-Host "Node: $(& $node --version)"
Write-Host "npm CLI: $npmCli"

$cache = Join-Path $root "runtime\npm-cache"
$npmArgs = @("ci", "--omit=dev", "--ignore-scripts")
if (Test-Path -LiteralPath $cache -PathType Container) {
  $npmArgs += @("--offline", "--cache", $cache)
  Write-Host "Installing dependencies from the bundled offline cache..."
} else {
  Write-Host "Installing dependencies from npm..."
}
& $node $npmCli @npmArgs
if ($LASTEXITCODE -ne 0) {
  throw "npm ci failed with exit code $LASTEXITCODE"
}

$setupArgs = @((Join-Path $root "scripts\setup.js"))
if ($Room) {
  $setupArgs += @("--room", $Room)
}
& $node @setupArgs
if ($LASTEXITCODE -ne 0) {
  throw "Configuration setup failed with exit code $LASTEXITCODE"
}

if (-not $SkipTests) {
  & $node $npmCli test
  if ($LASTEXITCODE -ne 0) {
    throw "Unit tests failed with exit code $LASTEXITCODE"
  }
  & $node $npmCli run verify
  if ($LASTEXITCODE -ne 0) {
    throw "Regression verification failed with exit code $LASTEXITCODE"
  }
}

Write-Host "Windows setup is ready. Run WINDOWS-2-START.cmd next."
