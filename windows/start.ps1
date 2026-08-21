param(
  [switch]$NoBrowser,
  [switch]$ExitAfterHealthy
)

. (Join-Path $PSScriptRoot "common.ps1")

$root = Get-ProjectRoot
$node = Get-ProjectNode $root
Assert-NodeVersion $node
$env:PATH = "$(Split-Path -Parent $node);$env:PATH"
Set-Location -LiteralPath $root

if (-not (Test-Path -LiteralPath (Join-Path $root "node_modules\playwright-core\package.json"))) {
  Write-Host "Dependencies are missing; running setup first..."
  & (Join-Path $PSScriptRoot "setup.ps1") -SkipTests
}

if (-not (Test-Path -LiteralPath (Join-Path $root "config.json"))) {
  Write-Host "Configuration is missing; running setup first..."
  & (Join-Path $PSScriptRoot "setup.ps1") -SkipTests
}

$url = "http://127.0.0.1:4322"
if (Test-BotApi "$url/api/state") {
  Write-Host "The bot is already running: $url"
  if (-not $NoBrowser) { Start-Process $url }
  exit 0
}

$pidFile = Join-Path $root "state\windows-server.pid"
$server = $null

try {
  $server = Start-Process -FilePath $node -ArgumentList @("src\webServer.js") -WorkingDirectory $root -NoNewWindow -PassThru
  New-Item -ItemType Directory -Path (Split-Path -Parent $pidFile) -Force | Out-Null
  Set-Content -LiteralPath $pidFile -Value $server.Id -Encoding ASCII

  $healthy = $false
  for ($attempt = 0; $attempt -lt 60; $attempt += 1) {
    if ($server.HasExited) { break }
    if (Test-BotApi "$url/api/state") {
      $healthy = $true
      break
    }
    Start-Sleep -Milliseconds 500
  }
  if (-not $healthy) {
    throw "The web console did not become healthy within 30 seconds."
  }
  Write-Host "Bot console: $url"
  if (-not $NoBrowser) { Start-Process $url }
  if ($ExitAfterHealthy) { return }
  Write-Host "Keep this window open. Press Ctrl+C to stop the bot."
  Wait-Process -Id $server.Id
  $server.Refresh()
  if ($server.ExitCode -ne 0) {
    throw "The bot process exited with code $($server.ExitCode)."
  }
} finally {
  if ($null -ne $server -and -not $server.HasExited) {
    if (-not $server.WaitForExit(5000)) {
      Stop-Process -Id $server.Id -Force -ErrorAction SilentlyContinue
      $server.WaitForExit()
    }
  }
  Remove-Item -LiteralPath $pidFile -Force -ErrorAction SilentlyContinue
}
