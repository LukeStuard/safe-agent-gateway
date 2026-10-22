# Gets an OAuth access token as the Safe Agent Gateway integration user.
# Reads the client credentials from Windows Credential Manager (target: SafeAgentGateway-SF).
# Usage (dot-source so the variables stay in your session):  . .\scripts\Get-GatewayToken.ps1

. "$PSScriptRoot\GatewayCredential.ps1"

$cred = Get-GatewayCredential -Target "SafeAgentGateway-SF"

$tok = Invoke-RestMethod -Method Post `
    -Uri "https://orgfarm-5ea30c60fa-dev-ed.develop.my.salesforce.com/services/oauth2/token" `
    -Body @{
        grant_type    = "client_credentials"
        client_id     = $cred.UserName
        client_secret = $cred.GetNetworkCredential().Password
    }
Remove-Variable cred

$SfInstance = $tok.instance_url
$SfHeaders  = @{ Authorization = "Bearer $($tok.access_token)" }
Write-Host "Token acquired as the integration user. Use `$SfInstance and `$SfHeaders."