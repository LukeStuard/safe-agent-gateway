# Test client for the Safe Agent Gateway. PowerShell 7.
# Usage:
#   . .\scripts\Invoke-Mcp.ps1
#   Connect-Gateway                                     # browser sign-in, no token copying
#   Invoke-Mcp list_pending_reviews @{ limit = 1000 }
#   Invoke-Mcp get_program_summary -NoToken             # unauthenticated test
#   Invoke-Mcp get_program_summary -Token "garbage"     # explicit token override (never auto-refreshed)
#   Set-GatewayToken                                    # manual fallback: paste a token at a masked prompt
#
# Connect-Gateway is a public OAuth client for a native app (RFC 8252): dynamic client registration,
# PKCE S256, a loopback redirect on 127.0.0.1, and the resource indicator (RFC 8707). Only the client ID
# is saved to disk. The refresh token lives in this PowerShell session and nowhere else.

# Target: local dev by default. For production: $env:GATEWAY_TARGET = "prod", then dot-source this file again.
$GatewayOrigin = if ($env:GATEWAY_TARGET -eq "prod") { "https://safe-agent-gateway.lstua001.workers.dev" } else { "http://localhost:8788" }
$GatewayLoopbackPort = 33418
# One client registration per gateway host, so switching targets never overwrites the other's.
$GatewayClientFile = Join-Path $PSScriptRoot ".gateway-client.$(([uri]$GatewayOrigin).Host).json"
# Loading the script starts a fresh session, so a dev token is never sent to production or the reverse.
$env:GATEWAY_TOKEN = $null
$global:GatewaySession = $null
Write-Host "Gateway target: $GatewayOrigin (run Connect-Gateway to sign in)"

function ConvertTo-Base64Url([byte[]]$Bytes) {
    [Convert]::ToBase64String($Bytes).TrimEnd('=').Replace('+', '-').Replace('/', '_')
}

function Get-GatewayClientId {
    param([Parameter(Mandatory)]$Meta, [Parameter(Mandatory)][string]$RedirectUri, [switch]$Register)

    if (-not $Register -and (Test-Path $GatewayClientFile)) {
        $saved = Get-Content $GatewayClientFile -Raw | ConvertFrom-Json
        if ($saved.issuer -eq $Meta.issuer -and $saved.redirectUri -eq $RedirectUri) { return $saved.clientId }
    }

    $body = @{
        client_name                = "Safe Agent Gateway test client (PowerShell)"
        redirect_uris              = @($RedirectUri)
        grant_types                = @("authorization_code", "refresh_token")
        response_types             = @("code")
        token_endpoint_auth_method = "none"
    } | ConvertTo-Json
    $reg = Invoke-RestMethod -Method Post -Uri $Meta.registration_endpoint -ContentType "application/json" -Body $body

    @{ issuer = $Meta.issuer; clientId = $reg.client_id; redirectUri = $RedirectUri; registered = (Get-Date).ToString("o") } |
        ConvertTo-Json | Set-Content -Encoding utf8 $GatewayClientFile
    Write-Host "Registered a new gateway client ($($reg.client_id))."
    $reg.client_id
}

# Waits for the browser's redirect to the loopback callback and returns its path and query.
# Uses a raw TCP socket so no admin URL reservation is needed. Skips speculative connections.
function Wait-GatewayCallback {
    param([Parameter(Mandatory)][System.Net.Sockets.TcpListener]$Listener, [int]$TimeoutSeconds = 300)

    $deadline = (Get-Date).AddSeconds($TimeoutSeconds)
    while ((Get-Date) -lt $deadline) {
        $task = $Listener.AcceptTcpClientAsync()
        $remaining = $deadline - (Get-Date)
        if ($remaining -le [TimeSpan]::Zero -or -not $task.Wait($remaining)) { break }

        $client = $task.Result
        try {
            $client.ReceiveTimeout = 5000
            $stream = $client.GetStream()
            $reader = [System.IO.StreamReader]::new($stream, [System.Text.Encoding]::ASCII, $false, 8192, $true)
            $line = $reader.ReadLine()
            $isCallback = $line -match '^GET (/callback\?\S*) HTTP/'
            $target = if ($isCallback) { $Matches[1] } else { $null }

            $html = if ($isCallback) {
                "<!doctype html><meta charset='utf-8'><title>Safe Agent Gateway</title><p>Sign-in finished. You can close this tab and return to PowerShell.</p>"
            } else { "Not found." }
            $status  = if ($isCallback) { "200 OK" } else { "404 Not Found" }
            $payload = [System.Text.Encoding]::UTF8.GetBytes($html)
            $head    = [System.Text.Encoding]::ASCII.GetBytes(
                "HTTP/1.1 $status`r`nContent-Type: text/html; charset=utf-8`r`nContent-Length: $($payload.Length)`r`nConnection: close`r`n`r`n")
            $stream.Write($head, 0, $head.Length)
            $stream.Write($payload, 0, $payload.Length)
            $stream.Flush()

            if ($target) { return $target }
        } catch {
            # Empty or speculative connection; keep waiting for the real callback.
        } finally {
            $client.Close()
        }
    }
    throw "Timed out waiting for the browser sign-in. If the browser showed an error about an unknown client, run Connect-Gateway -Register."
}

function Save-GatewayTokens {
    param($Token, [string]$TokenEndpoint, [string]$ClientId, [string]$Resource, [string]$PreviousRefresh)

    $env:GATEWAY_TOKEN = $Token.access_token
    $global:GatewaySession = @{
        TokenEndpoint = $TokenEndpoint
        ClientId      = $ClientId
        Resource      = $Resource
        RefreshToken  = $Token.refresh_token ?? $PreviousRefresh
        ExpiresAt     = (Get-Date).AddSeconds([int]($Token.expires_in ?? 3600))
    }
}

function Connect-Gateway {
    param([switch]$Register, [int]$TimeoutSeconds = 300)

    $meta        = Invoke-RestMethod -Uri "$GatewayOrigin/.well-known/oauth-authorization-server"
    $redirectUri = "http://127.0.0.1:$GatewayLoopbackPort/callback"
    $resource    = "$GatewayOrigin/mcp"
    $clientId    = Get-GatewayClientId -Meta $meta -RedirectUri $redirectUri -Register:$Register

    $verifier  = ConvertTo-Base64Url ([System.Security.Cryptography.RandomNumberGenerator]::GetBytes(32))
    $challenge = ConvertTo-Base64Url ([System.Security.Cryptography.SHA256]::HashData([System.Text.Encoding]::ASCII.GetBytes($verifier)))
    $state     = ConvertTo-Base64Url ([System.Security.Cryptography.RandomNumberGenerator]::GetBytes(16))

    $query = [ordered]@{
        response_type         = "code"
        client_id             = $clientId
        redirect_uri          = $redirectUri
        scope                 = "gateway:read"
        state                 = $state
        code_challenge        = $challenge
        code_challenge_method = "S256"
        resource              = $resource
    }
    $authUrl = $meta.authorization_endpoint + "?" +
        (($query.GetEnumerator() | ForEach-Object { "$($_.Key)=$([uri]::EscapeDataString($_.Value))" }) -join "&")

    $listener = [System.Net.Sockets.TcpListener]::new([System.Net.IPAddress]::Loopback, $GatewayLoopbackPort)
    $listener.Start()
    try {
        Write-Host "Opening the browser. Approve the request and sign in with Salesforce..."
        Start-Process $authUrl
        $target = Wait-GatewayCallback -Listener $listener -TimeoutSeconds $TimeoutSeconds
    } finally {
        $listener.Stop()
    }

    $q = [System.Web.HttpUtility]::ParseQueryString(([uri]"http://127.0.0.1$target").Query)
    if ($q["error"])                                { throw "Authorization failed: $($q['error']) $($q['error_description'])" }
    if ($q["state"] -ne $state)                     { throw "State mismatch: the callback didn't come from this sign-in. Nothing was saved." }
    if ($q["iss"] -and $q["iss"] -ne $meta.issuer) { throw "Issuer mismatch ($($q['iss'])). Nothing was saved." }
    if (-not $q["code"])                            { throw "No authorization code in the callback." }

    $tok = Invoke-RestMethod -Method Post -Uri $meta.token_endpoint -ContentType "application/x-www-form-urlencoded" -Body @{
        grant_type    = "authorization_code"
        code          = $q["code"]
        redirect_uri  = $redirectUri
        client_id     = $clientId
        code_verifier = $verifier
        resource      = $resource
    }
    Save-GatewayTokens -Token $tok -TokenEndpoint $meta.token_endpoint -ClientId $clientId -Resource $resource
    Write-Host "Connected. The access token lasts about $([int](($tok.expires_in ?? 3600) / 60)) minutes and refreshes automatically."
}

function Update-GatewayToken {
    $s = $global:GatewaySession
    if (-not $s -or -not $s.RefreshToken) { return $false }

    $tok = Invoke-RestMethod -Method Post -Uri $s.TokenEndpoint -ContentType "application/x-www-form-urlencoded" `
        -SkipHttpErrorCheck -StatusCodeVariable sc -Body @{
            grant_type    = "refresh_token"
            refresh_token = $s.RefreshToken
            client_id     = $s.ClientId
            resource      = $s.Resource
        }
    if ($sc -ne 200 -or -not $tok.access_token) {
        Write-Warning "Token refresh failed (HTTP $sc). Run Connect-Gateway."
        return $false
    }
    Save-GatewayTokens -Token $tok -TokenEndpoint $s.TokenEndpoint -ClientId $s.ClientId -Resource $s.Resource -PreviousRefresh $s.RefreshToken
    Write-Host "Gateway token refreshed."
    $true
}

function Set-GatewayToken {
    $secure = Read-Host -Prompt "Paste the gateway access token" -AsSecureString
    $t = [System.Net.NetworkCredential]::new("", $secure).Password.Trim()
    if (-not $t) { throw "No token entered." }
    if ($t -notmatch '^[A-Za-z0-9._:~+/=-]+$') {
        throw "That doesn't look like an access token. Paste just the access_token value."
    }
    $env:GATEWAY_TOKEN = $t
    $global:GatewaySession = $null  # a pasted token has no refresh token
    Write-Host "Gateway token loaded for this session ($($t.Length) chars)."
}

function Send-McpCall {
    param([string]$Uri, [string]$Body, [string]$Token)

    $headers = @{ Accept = "application/json, text/event-stream"; "MCP-Protocol-Version" = "2025-11-25" }
    if ($Token) { $headers.Authorization = "Bearer $Token" }

    $res = Invoke-WebRequest -Method Post -Uri $Uri -ContentType "application/json" -Body $Body `
        -Headers $headers -SkipHttpErrorCheck -ErrorAction Stop

    # Responses arrive as JSON or as server-sent events ("data: {...}").
    $text = [string]$res.Content
    $json = if ($text.TrimStart().StartsWith("{")) { $text } else {
        ($text -split "`n" | Where-Object { $_ -like "data:*" } | ForEach-Object { $_.Substring(5).Trim() }) -join ""
    }
    $rpc = $null
    if ($json) { try { $rpc = $json | ConvertFrom-Json -Depth 20 } catch { } }

    # Tool results carry their payload as JSON text; unwrap it when possible.
    $data = $null
    if ($rpc -and $rpc.result -and $rpc.result.content) {
        $payload = $rpc.result.content[0].text
        try { $data = $payload | ConvertFrom-Json -Depth 20 } catch { $data = $payload }
    }

    $challenge = $null
    [void]$res.Headers.TryGetValue("WWW-Authenticate", [ref]$challenge)

    [pscustomobject]@{
        Status    = [int]$res.StatusCode
        Challenge = ($challenge -join ", ")
        IsError   = [bool]($rpc.error -or $rpc.result.isError)
        Error     = $rpc.error
        Data      = $data
    }
}

function Invoke-Mcp {
    param(
        [Parameter(Mandatory)][string]$Name,
        [hashtable]$Arguments = @{},
        [string]$Token = $env:GATEWAY_TOKEN,
        [switch]$NoToken,
        [string]$Uri = "$GatewayOrigin/mcp"
    )

    # Only the session token is ever refreshed. Explicit -Token values are sent exactly as given.
    $useSession = -not $NoToken -and -not $PSBoundParameters.ContainsKey("Token")
    $s = $global:GatewaySession
    if ($useSession -and $s -and $s.ExpiresAt -and (Get-Date) -gt $s.ExpiresAt.AddSeconds(-60)) {
        [void](Update-GatewayToken)
    }
    $sendToken = if ($NoToken) { $null } elseif ($useSession) { $env:GATEWAY_TOKEN } else { $Token }
    if (-not $NoToken -and -not $sendToken) { throw "No token. Run Connect-Gateway, pass -Token, or use -NoToken." }

    $body = @{ jsonrpc = "2.0"; id = 1; method = "tools/call"; params = @{ name = $Name; arguments = $Arguments } } |
        ConvertTo-Json -Depth 10 -Compress

    $result = Send-McpCall -Uri $Uri -Body $body -Token $sendToken
    if ($useSession -and $result.Status -eq 401 -and $result.Challenge -match 'invalid_token' -and (Update-GatewayToken)) {
        $result = Send-McpCall -Uri $Uri -Body $body -Token $env:GATEWAY_TOKEN
    }
    $result
}