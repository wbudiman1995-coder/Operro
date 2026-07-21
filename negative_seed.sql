$ErrorActionPreference = "Stop"
Set-Location (Split-Path $PSScriptRoot -Parent)

function Run-Checked {
    param([string]$Label, [scriptblock]$Command)
    Write-Host ""
    Write-Host "=== $Label ===" -ForegroundColor Cyan
    & $Command
    if ($LASTEXITCODE -ne 0) {
        throw "$Label failed with exit code $LASTEXITCODE"
    }
}

Write-Host "OPERRO — SUPABASE STAGING PUSH" -ForegroundColor Green
Write-Host "This script must be used only for a NEW, EMPTY STAGING Supabase project." -ForegroundColor Yellow
Write-Host "Do not use your production project." -ForegroundColor Yellow
Write-Host ""

try {
    $nodeVersion = (& node --version 2>$null)
} catch {
    $nodeVersion = $null
}

if (-not $nodeVersion) {
    Write-Host "Node.js was not found." -ForegroundColor Red
    Write-Host "Install Node.js 20 LTS or newer, restart Windows, and run this file again."
    Read-Host "Press Enter to close"
    exit 1
}

$major = [int](($nodeVersion -replace '^v','').Split('.')[0])
if ($major -lt 20) {
    Write-Host "Your Node.js version is $nodeVersion. Supabase CLI via npm requires Node.js 20 or newer." -ForegroundColor Red
    Read-Host "Press Enter to close"
    exit 1
}
Write-Host "Node.js detected: $nodeVersion" -ForegroundColor Green

if (-not (Test-Path "node_modules/.bin/supabase.cmd")) {
    Run-Checked "Installing Supabase CLI in this folder" { npm install supabase --save-dev }
}

Run-Checked "Checking Supabase CLI" { npx supabase --version }

Write-Host ""
Write-Host "A browser/token login will be requested next." -ForegroundColor Yellow
Run-Checked "Logging in to Supabase CLI" { npx supabase login }

Write-Host ""
Write-Host "Find the Project Ref in either place:" -ForegroundColor Cyan
Write-Host "1) Supabase dashboard URL: /project/THIS_PART"
Write-Host "2) Project Settings > General > Reference ID"
$projectRef = Read-Host "Paste the STAGING Project Ref"
if ([string]::IsNullOrWhiteSpace($projectRef)) {
    throw "Project Ref cannot be empty."
}

Write-Host ""
Write-Host "You entered: $projectRef" -ForegroundColor Yellow
$stagingConfirm = Read-Host "Type exactly STAGING to confirm this is NOT production"
if ($stagingConfirm -ne "STAGING") {
    Write-Host "Canceled. Nothing was pushed." -ForegroundColor Yellow
    Read-Host "Press Enter to close"
    exit 0
}

Run-Checked "Linking this folder to the staging project" { npx supabase link --project-ref $projectRef }
Run-Checked "Showing local and remote migration status" { npx supabase migration list }

Write-Host ""
Write-Host "The next command will apply 13 migrations to the linked STAGING database." -ForegroundColor Yellow
Write-Host "The Supabase CLI may show the migration filenames and ask for confirmation."
$pushConfirm = Read-Host "Type exactly PUSH OPERRO 0013"
if ($pushConfirm -ne "PUSH OPERRO 0013") {
    Write-Host "Canceled. Nothing was pushed." -ForegroundColor Yellow
    Read-Host "Press Enter to close"
    exit 0
}

Run-Checked "Pushing migrations to staging" { npx supabase db push }
Run-Checked "Checking migration status after push" { npx supabase migration list }

Write-Host ""
Write-Host "SUCCESS: The migration push command completed." -ForegroundColor Green
Write-Host "Next: open verification/2_VERIFY_0013_IN_SUPABASE.sql and run it in Supabase SQL Editor." -ForegroundColor Cyan
Read-Host "Press Enter to close"
