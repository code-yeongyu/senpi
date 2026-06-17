#!/usr/bin/env pwsh
$ErrorActionPreference = "Stop"
if (-not (Get-Command node -ErrorAction SilentlyContinue)) {
    Write-Error "Node.js >= 24 is required. Install it from https://nodejs.org and re-run."
    exit 1
}
node (Join-Path $PSScriptRoot "devenv-setup.mjs") @args
exit $LASTEXITCODE
