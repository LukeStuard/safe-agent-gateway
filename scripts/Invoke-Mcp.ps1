# Raw MCP tools/call against the local gateway, bypassing client-side validation. PowerShell 7.
# Usage:
#   . .\scripts\Invoke-Mcp.ps1
#   Set-GatewayToken                                    # copy an access token first; reads the clipboard
#   Invoke-Mcp list_pending_reviews @{ limit = 1000 }
#   Invoke-Mcp get_program_summary -NoToken             # unauthenticated test
#   Invoke-Mcp get_program_summary -Token "garbage"     # explicit token override

function Set-GatewayToken {
    $t = (Get-Clipboard -Raw)
    if (-not $t -or -not $t.Trim()) { throw "Clipboard is empty. Copy the access token first." }
    $env:GATEWAY_TOKEN = $t.Trim()
    Set-Clipboard -Value $null
    Write-Host "Gateway token loaded for this session ($($env:GATEWAY_TOKEN.Length) chars). Clipboard cleared."
}

function Invoke-Mcp {
    param(
        [Parameter(Mandatory)][string]$Name,
        [hashtable]$Arguments = @{},
        [string]$Token = $env:GATEWAY_TOKEN,
        [switch]$NoToken,
        [string]$Uri = "http://localhost:8788/mcp"
    )

    $body = @{ jsonrpc = "2.0"; id = 1; method = "tools/call"; params = @{ name = $Name; arguments = $Arguments } } |
        ConvertTo-Json -Depth 10 -Compress
    $headers = @{ Accept = "application/json, text/event-stream"; "MCP-Protocol-Version" = "2025-11-25" }
    if (-not $NoToken) {
        if (-not $Token) { throw "No token. Run Set-GatewayToken, pass -Token, or use -NoToken." }
        $headers.Authorization = "Bearer $Token"
    }

    $res = Invoke-WebRequest -Method Post -Uri $Uri -ContentType "application/json" -Body $body `
        -Headers $headers -SkipHttpErrorCheck

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