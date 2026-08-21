. (Join-Path $PSScriptRoot "common.ps1")

$candidates = @()
$command = Get-Command ollama.exe -ErrorAction SilentlyContinue
if ($null -ne $command) { $candidates += $command.Source }
if ($env:LOCALAPPDATA) {
  $candidates += (Join-Path $env:LOCALAPPDATA "Programs\Ollama\ollama.exe")
}
$ollama = $candidates | Where-Object { Test-Path -LiteralPath $_ -PathType Leaf } | Select-Object -First 1
if (-not $ollama) {
  Write-Host "Ollama is not installed. Opening the official download page..."
  Start-Process "https://ollama.com/download/windows"
  throw "Install Ollama, then run WINDOWS-3-INSTALL-AI.cmd again."
}

$ready = $false
try {
  Invoke-RestMethod -Uri "http://127.0.0.1:11434/api/tags" -TimeoutSec 2 | Out-Null
  $ready = $true
} catch {
  Start-Process -FilePath $ollama -ArgumentList @("serve") -WindowStyle Hidden | Out-Null
}

if (-not $ready) {
  for ($attempt = 0; $attempt -lt 30; $attempt += 1) {
    try {
      Invoke-RestMethod -Uri "http://127.0.0.1:11434/api/tags" -TimeoutSec 2 | Out-Null
      $ready = $true
      break
    } catch {
      Start-Sleep -Milliseconds 500
    }
  }
}
if (-not $ready) { throw "Ollama did not start within 15 seconds." }

Write-Host "Downloading qwen3.5:4b. This model is several GB..."
& $ollama pull qwen3.5:4b
if ($LASTEXITCODE -ne 0) { throw "ollama pull failed with exit code $LASTEXITCODE" }
Write-Host "Ollama and qwen3.5:4b are ready."
