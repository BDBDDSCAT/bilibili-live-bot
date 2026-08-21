. (Join-Path $PSScriptRoot "common.ps1")

$root = Get-ProjectRoot
$manifest = Join-Path $root "MANIFEST.sha256"
$infoPath = Join-Path $root "PACKAGE_INFO.json"
if (-not (Test-Path -LiteralPath $manifest -PathType Leaf)) {
  throw "MANIFEST.sha256 was not found. This verification entry is for the portable package."
}
if (-not (Test-Path -LiteralPath $infoPath -PathType Leaf)) {
  throw "PACKAGE_INFO.json was not found. The package is incomplete."
}

$info = Get-Content -LiteralPath $infoPath -Raw -Encoding UTF8 | ConvertFrom-Json
$expectedCount = [int]$info.manifest.expectedEntries
if ($info.manifest.algorithm -ne "sha256" -or $expectedCount -le 0 -or $info.manifest.exactFileSet -ne $true) {
  throw "PACKAGE_INFO.json does not contain a valid exact SHA256 manifest contract."
}

$required = @(
  "PACKAGE_INFO.json",
  "package.json",
  "WINDOWS-1-SETUP.cmd",
  "WINDOWS-2-START.cmd",
  "WINDOWS-3-INSTALL-AI.cmd",
  "WINDOWS-4-VERIFY.cmd",
  "WINDOWS-START-HERE.txt",
  "docs/WINDOWS.md",
  "scripts/build-windows-portable.js",
  "scripts/test-windows-portable.js",
  "windows/common.ps1",
  "windows/setup-ai.ps1",
  "windows/setup.ps1",
  "windows/start.ps1",
  "windows/verify-package.ps1"
)

$lines = @(Get-Content -LiteralPath $manifest -Encoding UTF8)
if ($lines.Count -ne $expectedCount) {
  throw "Manifest entry count mismatch: expected $expectedCount, found $($lines.Count)."
}

$rootFull = [System.IO.Path]::GetFullPath($root).TrimEnd([System.IO.Path]::DirectorySeparatorChar)
$rootPrefix = "$rootFull$([System.IO.Path]::DirectorySeparatorChar)"
$listed = @{}
$failed = 0
foreach ($line in $lines) {
  if ($line -notmatch '^([0-9a-fA-F]{64})  (.+)$') {
    Write-Host "Invalid manifest line: $line"
    $failed += 1
    continue
  }
  $expected = $matches[1].ToLowerInvariant()
  $portableRelative = $matches[2].Replace('\', '/')
  if ($portableRelative -eq "MANIFEST.sha256" -or [System.IO.Path]::IsPathRooted($portableRelative)) {
    Write-Host "Invalid manifest path: $portableRelative"
    $failed += 1
    continue
  }
  $relative = $portableRelative.Replace('/', [System.IO.Path]::DirectorySeparatorChar)
  $file = [System.IO.Path]::GetFullPath((Join-Path $root $relative))
  if (-not $file.StartsWith($rootPrefix, [System.StringComparison]::OrdinalIgnoreCase)) {
    Write-Host "Manifest path escapes the package: $portableRelative"
    $failed += 1
    continue
  }
  if ($listed.ContainsKey($portableRelative)) {
    Write-Host "Duplicate manifest path: $portableRelative"
    $failed += 1
    continue
  }
  $listed[$portableRelative] = $expected
}

foreach ($relative in $required) {
  if (-not $listed.ContainsKey($relative)) {
    Write-Host "Required file is absent from manifest: $relative"
    $failed += 1
  }
}

$actual = @{}
foreach ($item in Get-ChildItem -LiteralPath $root -File -Recurse -Force) {
  $full = [System.IO.Path]::GetFullPath($item.FullName)
  $relative = $full.Substring($rootPrefix.Length).Replace('\', '/')
  if ($relative -eq "MANIFEST.sha256") { continue }
  if (($item.Attributes -band [System.IO.FileAttributes]::ReparsePoint) -ne 0) {
    Write-Host "Reparse points are not allowed: $relative"
    $failed += 1
    continue
  }
  $actual[$relative] = $full
  if (-not $listed.ContainsKey($relative)) {
    Write-Host "Unlisted extra file: $relative"
    $failed += 1
  }
}

if ($actual.Count -ne $listed.Count) {
  Write-Host "Package file count differs from manifest: listed $($listed.Count), actual $($actual.Count)"
  $failed += 1
}

$checked = 0
foreach ($relative in $listed.Keys) {
  if (-not $actual.ContainsKey($relative)) {
    Write-Host "Missing: $relative"
    $failed += 1
    continue
  }
  $hash = (Get-FileHash -LiteralPath $actual[$relative] -Algorithm SHA256).Hash.ToLowerInvariant()
  if ($hash -ne $listed[$relative]) {
    Write-Host "Hash mismatch: $relative"
    $failed += 1
  }
  $checked += 1
}

if ($failed -gt 0) { throw "Package verification failed: $failed problem(s), $checked file(s) checked." }
Write-Host "Package verification passed: $checked file(s), exact file set confirmed."
