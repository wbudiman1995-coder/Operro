param(
  [Parameter(Mandatory = $true)]
  [ValidateSet("deepseek-customer-code", "claude-dynamic-size-design", "claude-dynamic-size-bundle-1")]
  [string]$Task
)

$ErrorActionPreference = "Stop"

$repo = (Resolve-Path (Join-Path $PSScriptRoot "..")).Path
$spec = switch ($Task) {
  "deepseek-customer-code" {
    @{
      Manifest = "docs/agent-work/DEEPSEEK-CUSTOMER-CODE-MANIFEST.txt"
      Assignment = "docs/agent-work/DEEPSEEK-CUSTOMER-CODE.md"
      Output = "Operro-DeepSeek-Customer-Code-8bef156.zip"
    }
  }
  "claude-dynamic-size-design" {
    @{
      Manifest = "docs/agent-work/CLAUDE-DYNAMIC-SIZE-MANIFEST.txt"
      Assignment = "docs/agent-work/CLAUDE-DYNAMIC-SIZE-DESIGN.md"
      Output = "Operro-Claude-Dynamic-Size-Design-8bef156.zip"
      HomePawReference = "C:\Users\DW_wi\Downloads\index (2).html"
    }
  }
  "claude-dynamic-size-bundle-1" {
    @{
      Manifest = "docs/agent-work/CLAUDE-DYNAMIC-SIZE-BUNDLE-1-MANIFEST.txt"
      Assignment = "docs/agent-work/CLAUDE-DYNAMIC-SIZE-BUNDLE-1.md"
      Output = "Operro-Claude-Dynamic-Size-Bundle-1-d4ee76d.zip"
      BaseCommit = "d4ee76d4882ca4b4c73524c4fea175f9a669f81b"
    }
  }
}

$manifestPath = Join-Path $repo $spec.Manifest
$assignmentPath = Join-Path $repo $spec.Assignment
$bundleDir = Join-Path $repo "agent-bundles"
$stageRoot = Join-Path ([System.IO.Path]::GetTempPath()) ("operro-agent-bundle-" + [guid]::NewGuid().ToString("N"))
$zipPath = Join-Path $bundleDir $spec.Output

if (-not (Test-Path -LiteralPath $manifestPath)) { throw "Manifest not found: $manifestPath" }
if (-not (Test-Path -LiteralPath $assignmentPath)) { throw "Assignment not found: $assignmentPath" }

try {
  New-Item -ItemType Directory -Force -Path $stageRoot | Out-Null
  $paths = Get-Content -LiteralPath $manifestPath | Where-Object { $_.Trim() -and -not $_.Trim().StartsWith("#") }
  foreach ($relativePath in $paths) {
    if ($relativePath -match "(^|/)(\.env|node_modules|\.git)(/|$)") {
      throw "Unsafe manifest entry: $relativePath"
    }
    $source = Join-Path $repo $relativePath
    if (-not (Test-Path -LiteralPath $source -PathType Leaf)) { throw "Listed source file not found: $relativePath" }
    $destination = Join-Path $stageRoot (Join-Path "operro" $relativePath)
    New-Item -ItemType Directory -Force -Path (Split-Path -Parent $destination) | Out-Null
    Copy-Item -LiteralPath $source -Destination $destination
  }

  Copy-Item -LiteralPath $assignmentPath -Destination (Join-Path $stageRoot "ASSIGNMENT.md")
  Copy-Item -LiteralPath $manifestPath -Destination (Join-Path $stageRoot "PART_MANIFEST.txt")
  if ($spec.ContainsKey("HomePawReference")) {
    $referencePath = $spec.HomePawReference
    if (-not (Test-Path -LiteralPath $referencePath -PathType Leaf)) { throw "HomePaw reference not found: $referencePath" }
    $referenceDestination = Join-Path $stageRoot "reference\homepaw\index (2).html"
    New-Item -ItemType Directory -Force -Path (Split-Path -Parent $referenceDestination) | Out-Null
    Copy-Item -LiteralPath $referencePath -Destination $referenceDestination
  }
  @(
    "# Operro agent task bundle",
    "",
    "Base commit: " + $(if ($spec.ContainsKey("BaseCommit")) { $spec.BaseCommit } else { "8bef156aa745aa958c329adeae66b2cba7cf0ccf" }),
    "Task: $Task",
    "",
    "Read ASSIGNMENT.md, then PART_MANIFEST.txt. Source files live under operro/.",
    "This archive intentionally excludes .env files, credentials, node_modules, production dumps, and unlisted repository files."
  ) | Set-Content -LiteralPath (Join-Path $stageRoot "START-HERE.md") -Encoding utf8

  New-Item -ItemType Directory -Force -Path $bundleDir | Out-Null
  if (Test-Path -LiteralPath $zipPath) { Remove-Item -LiteralPath $zipPath -Force }
  Compress-Archive -Path (Join-Path $stageRoot "*") -DestinationPath $zipPath -CompressionLevel Optimal
  $fileCount = (Get-ChildItem -LiteralPath $stageRoot -Recurse -File).Count
  $bytes = (Get-Item -LiteralPath $zipPath).Length
  Write-Output "Created $zipPath ($fileCount files, $bytes bytes)"
} finally {
  if (Test-Path -LiteralPath $stageRoot) { Remove-Item -LiteralPath $stageRoot -Recurse -Force }
}
