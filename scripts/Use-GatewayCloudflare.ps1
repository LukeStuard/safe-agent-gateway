# Points Wrangler at the personal Cloudflare account for this PowerShell session only.
# Usage: . .\scripts\Use-GatewayCloudflare.ps1
$c = Get-StoredCredential -Target "SafeAgentGateway-CF"
if (-not $c) { throw "No stored credential named 'SafeAgentGateway-CF' was found." }
$env:CLOUDFLARE_ACCOUNT_ID = $c.UserName
$env:CLOUDFLARE_API_TOKEN  = $c.GetNetworkCredential().Password
Remove-Variable c
Write-Host "Wrangler now targets the Safe Agent Gateway Cloudflare account (this session only)."