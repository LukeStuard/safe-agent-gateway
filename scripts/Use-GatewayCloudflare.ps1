# Points Wrangler at the Safe Agent Gateway's personal Cloudflare account, for this session only.
# Reads the account ID (username) and scoped API token (password) from Credential Manager
# (target: SafeAgentGateway-CF). Usage:  . .\scripts\Use-GatewayCloudflare.ps1

. "$PSScriptRoot\GatewayCredential.ps1"

$cf = Get-GatewayCredential -Target "SafeAgentGateway-CF"
$env:CLOUDFLARE_ACCOUNT_ID = $cf.UserName
$env:CLOUDFLARE_API_TOKEN  = $cf.GetNetworkCredential().Password
Remove-Variable cf

Write-Host "Wrangler now targets the Safe Agent Gateway Cloudflare account (this session only)."