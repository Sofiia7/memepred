# Run Deploy.s.sol from Windows, with the repo-root .env loaded.
#
#   .\script\deploy.ps1              # simulate, changes nothing
#   .\script\deploy.ps1 -Broadcast   # actually deploy
#
# Why this exists rather than a one-liner:
#
#   foundry.toml lives in contracts/ but .env lives at the repo root, so forge
#   does not pick it up on its own. Sourcing it by hand is a bash idiom, and
#   pasting a bash one-liner into cmd.exe fails with "cannot find the path".
#
#   And .env carries inline `# ...` comments on ten of its lines. `source` in
#   bash strips those; a naive split on "=" does not, so PRIVATE_KEY arrives 92
#   characters long and forge rejects it with a parser error that points at the
#   variable name and explains nothing.
param([switch]$Broadcast)

$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot
Set-Location $root

$envFile = Join-Path (Split-Path -Parent $root) '.env'
if (-not (Test-Path $envFile)) { throw "no .env at $envFile" }

Get-Content $envFile | Where-Object { $_ -match '^[A-Za-z_][A-Za-z0-9_]*=' } | ForEach-Object {
  $pair = $_ -split '=', 2
  $value = ($pair[1] -split ' #', 2)[0].Trim().Trim('"')
  [Environment]::SetEnvironmentVariable($pair[0].Trim(), $value, 'Process')
}

if ($env:PRIVATE_KEY -notmatch '^0x[0-9a-fA-F]{64}$') {
  throw 'PRIVATE_KEY is not a 32-byte hex key after parsing .env'
}
if (-not $env:BASE_RPC_URL) { throw 'BASE_RPC_URL is not set' }

$forge = Join-Path $env:USERPROFILE '.foundry\bin\forge.exe'
$args  = @('script', 'script/Deploy.s.sol', '--rpc-url', $env:BASE_RPC_URL)
if ($Broadcast) {
  # --slow waits for each receipt. The second deploy ran out of gas partway
  # through and left ownership on the deployer; one transaction at a time makes
  # a partial failure obvious instead of silent.
  $args += @('--broadcast', '--slow')
  Write-Host 'BROADCASTING - this deploys real contracts' -ForegroundColor Yellow
} else {
  Write-Host 'simulation only, nothing will be sent' -ForegroundColor Cyan
}

# Back to Continue before calling forge. Windows PowerShell turns a native
# executable's stderr into ErrorRecords, so under 'Stop' a harmless forge
# warning aborts the run and reports it as a failure of this script.
$ErrorActionPreference = 'Continue'
& $forge @args
exit $LASTEXITCODE
