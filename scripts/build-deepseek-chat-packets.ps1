$ErrorActionPreference = "Stop"

$repo = (Resolve-Path (Join-Path $PSScriptRoot "..")).Path
$packetRoot = Join-Path $repo "deepseek-outsourcing\2026-10-09"
$outputRoot = Join-Path $repo "agent-bundles"
$referencePath = "C:\Users\DW_wi\Downloads\index (2).html"

if (-not (Test-Path -LiteralPath $referencePath -PathType Leaf)) {
  throw "HomePaw reference not found: $referencePath"
}

$packets = @(
  @{ Id = "ENGINE-1"; Name = "Operro-DeepSeek-Engine-1-Owner-Experience-20261009.zip" },
  @{ Id = "ENGINE-2"; Name = "Operro-DeepSeek-Engine-2-Operations-20261009.zip" },
  @{ Id = "ENGINE-3"; Name = "Operro-DeepSeek-Engine-3-Platform-Resilience-20261009.zip" }
)

New-Item -ItemType Directory -Force -Path $outputRoot | Out-Null

foreach ($packet in $packets) {
  $manifestPath = Join-Path $packetRoot ("{0}-MANIFEST.txt" -f $packet.Id)
  $promptPath = Join-Path $packetRoot ("{0}-{1}.md" -f $packet.Id, @{
      "ENGINE-1" = "OWNER-EXPERIENCE"; "ENGINE-2" = "OPERATIONS"; "ENGINE-3" = "PLATFORM-RESILIENCE"
    }[$packet.Id])
  $stage = Join-Path ([System.IO.Path]::GetTempPath()) ("operro-deepseek-" + [guid]::NewGuid().ToString("N"))
  $zipPath = Join-Path $outputRoot $packet.Name

  try {
    New-Item -ItemType Directory -Force -Path $stage | Out-Null
    $paths = Get-Content -LiteralPath $manifestPath | Where-Object { $_.Trim() -and -not $_.Trim().StartsWith("#") }
    foreach ($relativePath in $paths) {
      if ($relativePath -match "(^|/)(\.env|node_modules|\.git)(/|$)") { throw "Unsafe manifest entry: $relativePath" }
      $sourcePath = Join-Path $repo $relativePath
      if (-not (Test-Path -LiteralPath $sourcePath -PathType Leaf)) { throw "Manifest source is missing: $relativePath" }
      $destination = Join-Path $stage (Join-Path "operro" $relativePath)
      New-Item -ItemType Directory -Force -Path (Split-Path -Parent $destination) | Out-Null
      Copy-Item -LiteralPath $sourcePath -Destination $destination
    }
    Copy-Item -LiteralPath $promptPath -Destination (Join-Path $stage "DEEPSEEK_PROMPT.md")
    Copy-Item -LiteralPath $manifestPath -Destination (Join-Path $stage "PART_MANIFEST.txt")
    $referenceDestination = Join-Path $stage "reference\homepaw\index (2).html"
    New-Item -ItemType Directory -Force -Path (Split-Path -Parent $referenceDestination) | Out-Null
    Copy-Item -LiteralPath $referencePath -Destination $referenceDestination
    @(
      "# Operro DeepSeek chat packet",
      "",
      "Read DEEPSEEK_PROMPT.md, then PART_MANIFEST.txt. Source lives under operro/.",
      "This packet is curated context, not permission to access unlisted files, credentials, production, or provider accounts.",
      "Return patches with paths relative to operro/."
    ) | Set-Content -LiteralPath (Join-Path $stage "START-HERE.md") -Encoding utf8

    if (Test-Path -LiteralPath $zipPath) { Remove-Item -LiteralPath $zipPath -Force }
    Compress-Archive -Path (Join-Path $stage "*") -DestinationPath $zipPath -CompressionLevel Optimal
    $count = (Get-ChildItem -LiteralPath $stage -Recurse -File).Count
    if ($count -gt 50) { throw "Packet $($packet.Id) has $count files; DeepSeek limit is 50." }
    Write-Output "Created $zipPath ($count files)"
  } finally {
    if (Test-Path -LiteralPath $stage) { Remove-Item -LiteralPath $stage -Recurse -Force }
  }
}
