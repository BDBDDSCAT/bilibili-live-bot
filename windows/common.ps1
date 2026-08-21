$ErrorActionPreference = "Stop"

function Get-ProjectRoot {
  return [System.IO.Path]::GetFullPath((Join-Path $PSScriptRoot ".."))
}

function Get-ProjectNode([string]$Root) {
  $portable = Join-Path $Root "runtime\node\node.exe"
  if (Test-Path -LiteralPath $portable -PathType Leaf) {
    return $portable
  }
  $command = Get-Command node.exe -ErrorAction SilentlyContinue
  if ($null -eq $command) {
    throw "Node.js 20 or newer was not found. Use the portable package or install Node.js first."
  }
  return $command.Source
}

function Get-ProjectNpmCli([string]$Root, [string]$Node) {
  $candidates = @(
    (Join-Path (Split-Path -Parent $Node) "node_modules\npm\bin\npm-cli.js")
  )
  $command = Get-Command npm.cmd -ErrorAction SilentlyContinue
  if ($null -ne $command) {
    $candidates += (Join-Path (Split-Path -Parent $command.Source) "node_modules\npm\bin\npm-cli.js")
  }
  foreach ($candidate in ($candidates | Select-Object -Unique)) {
    if (Test-Path -LiteralPath $candidate -PathType Leaf) {
      return $candidate
    }
  }
  throw "npm-cli.js was not found next to Node.js or npm.cmd. Reinstall Node.js or use the complete portable runtime."
}

function Assert-NodeVersion([string]$Node) {
  $majorText = & $Node -p "process.versions.node.split('.')[0]"
  if ($LASTEXITCODE -ne 0) {
    throw "Unable to run Node.js: $Node"
  }
  $major = [int]$majorText
  if ($major -lt 20) {
    throw "Node.js 20 or newer is required. Found: $(& $Node --version)"
  }
}

function Test-BotApi([string]$Url = "http://127.0.0.1:4322/api/state") {
  try {
    $response = Invoke-RestMethod -Uri $Url -Method Get -TimeoutSec 2
    return $null -ne $response
  } catch {
    return $false
  }
}
