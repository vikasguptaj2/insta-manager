$ErrorActionPreference = 'Stop'
Set-Location $PSScriptRoot
if (-not (Test-Path '.env.local')) { Copy-Item '.env.example' '.env.local' }
if (-not (Get-Command node -ErrorAction SilentlyContinue)) { throw 'Install Node.js 22 LTS first.' }
if (-not (Test-Path 'node_modules/next/package.json')) { npm.cmd install; if ($LASTEXITCODE -ne 0) { throw 'npm install failed' } }
npm.cmd run dev
