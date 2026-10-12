$ErrorActionPreference = "Stop"

$repo = (Resolve-Path (Join-Path $PSScriptRoot "..")).Path
$manifestPath = Join-Path $repo "docs\agent-work\CLAUDE-PERFORMANCE-DASHBOARD-MANIFEST-20261010.txt"
$promptPath = Join-Path $repo "docs\agent-work\CLAUDE-PERFORMANCE-DASHBOARD-BUILD-20261010.md"
$outputPath = Join-Path $repo "agent-bundles\Operro-Claude-Performance-Dashboard-4902945.zip"
$stage = Join-Path ([System.IO.Path]::GetTempPath()) ("operro-claude-performance-" + [guid]::NewGuid().ToString("N"))

try {
  New-Item -ItemType Directory -Force -Path $stage | Out-Null
  $relativePaths = Get-Content -LiteralPath $manifestPath |
    Where-Object { $_.Trim() -and -not $_.Trim().StartsWith("#") }

  foreach ($relativePath in $relativePaths) {
    if ($relativePath -match "(^|[\\/])(\.env|node_modules|\.git)([\\/]|$)") {
      throw "Unsafe manifest entry: $relativePath"
    }

    $sourcePath = Join-Path $repo $relativePath
    if (-not (Test-Path -LiteralPath $sourcePath -PathType Leaf)) {
      throw "Manifest source is missing: $relativePath"
    }

    $destination = Join-Path $stage (Join-Path "operro" $relativePath)
    New-Item -ItemType Directory -Force -Path (Split-Path -Parent $destination) | Out-Null
    Copy-Item -LiteralPath $sourcePath -Destination $destination
  }

  Copy-Item -LiteralPath $promptPath -Destination (Join-Path $stage "CLAUDE_BUILD_BRIEF.md")
  Copy-Item -LiteralPath $manifestPath -Destination (Join-Path $stage "PART_MANIFEST.txt")
  @(
    "# Operro Claude build packet",
    "",
    "Base commit: 4902945 feat(parity): complete remaining HomePaw workstreams.",
    "",
    "1. Read CLAUDE_BUILD_BRIEF.md in full.",
    "2. Follow operro/apps/web/AGENTS.md before changing web code.",
    "3. Treat this as curated context only; work in a clean checkout at the base commit, not inside this archive.",
    "4. Do not access credentials, production, provider APIs, or files outside the supplied task scope.",
    "5. Return an uncommitted patch plus the required handoff; do not push, deploy, merge, or apply remote migrations."
  ) | Set-Content -LiteralPath (Join-Path $stage "START-HERE.md") -Encoding utf8

  $fileCount = (Get-ChildItem -LiteralPath $stage -Recurse -File).Count
  if ($fileCount -gt 50) {
    throw "Packet has $fileCount files; it exceeds the 50-file upload limit."
  }

  New-Item -ItemType Directory -Force -Path (Split-Path -Parent $outputPath) | Out-Null
  Compress-Archive -Path (Join-Path $stage "*") -DestinationPath $outputPath -CompressionLevel Optimal -Force
  Write-Output "Created $outputPath ($fileCount files)"
} finally {
  if (Test-Path -LiteralPath $stage) {
    Remove-Item -LiteralPath $stage -Recurse -Force
  }
}
