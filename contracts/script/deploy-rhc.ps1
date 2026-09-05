# Run the Robinhood Chain deployment from Windows, with the repo-root .env loaded.
#
#   .\script\deploy-rhc.ps1 -Script fixtures              # simulate the stand-ins
#   .\script\deploy-rhc.ps1 -Script fixtures -Broadcast   # deploy them
#   .\script\deploy-rhc.ps1                              # simulate the stack
#   .\script\deploy-rhc.ps1 -Broadcast                   # deploy the stack
#   .\script\deploy-rhc.ps1 -Script addpool -Broadcast   # one more stand-in pool
#   .\script\deploy-rhc.ps1 -Network mainnet -Broadcast   # 4663, needs RHC_HANDOVER=true
#
# The sibling of deploy.ps1, and it exists for the same two reasons: foundry.toml
# lives in contracts/ while .env lives at the repo root, so forge does not find
# it; and .env carries inline `# ...` comments that a naive split on "=" leaves
# attached to the value, which makes PRIVATE_KEY arrive 92 characters long and
# forge reject it with an error that explains nothing.
#
# `fixtures` deploys a stand-in WETH, v3 factory and pool. The testnet has none
# of the real ones - checked on 46630, both canonical addresses are empty - so
# without them every gate in PoolMarketFactory reverts against an address with
# no code. It refuses to run on mainnet.
param(
  [switch]$Broadcast,
  [ValidateSet('testnet', 'mainnet')][string]$Network = 'testnet',
  [ValidateSet('stack', 'fixtures', 'addpool')][string]$Script = 'stack'
)

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

$rpc = if ($Network -eq 'mainnet') {
  'https://rpc.mainnet.chain.robinhood.com'
} else {
  'https://rpc.testnet.chain.robinhood.com'
}

$file = switch ($Script) {
  'fixtures' { 'script/DeployRhcFixtures.s.sol' }
  'addpool'  { 'script/AddRhcPool.s.sol' }
  default    { 'script/DeployRhc.s.sol' }
}

# The stack script reads these two and has no defaults on purpose: pointing it
# at an address with no code produces a confusing revert per gate rather than
# one clear failure here.
if ($Script -eq 'stack') {
  foreach ($k in @('RHC_WETH_ADDRESS', 'RHC_V3_FACTORY_ADDRESS')) {
    if (-not [Environment]::GetEnvironmentVariable($k)) {
      throw "$k is not set. Run -Script fixtures first on a testnet, or set the canonical addresses for mainnet."
    }
  }
}

$forge = Join-Path $env:USERPROFILE '.foundry\bin\forge.exe'
$forgeArgs = @('script', $file, '--rpc-url', $rpc)
if ($Broadcast) {
  # --slow waits for each receipt. A previous Base deploy ran out of gas partway
  # through and left ownership on the deployer; one transaction at a time makes
  # a partial failure obvious instead of silent.
  $forgeArgs += @('--broadcast', '--slow')
  Write-Host "BROADCASTING to $Network - this deploys real contracts" -ForegroundColor Yellow
} else {
  Write-Host "simulation only, nothing will be sent ($Network)" -ForegroundColor Cyan
}

# Back to Continue before calling forge: Windows PowerShell turns a native
# executable's stderr into ErrorRecords, so under 'Stop' a harmless forge
# warning aborts the run and reports it as a failure of this script.
$ErrorActionPreference = 'Continue'
& $forge @forgeArgs
exit $LASTEXITCODE
