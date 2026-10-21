# Sends a raw MCP tools/call to the local gateway, bypassing any client-side validation.
# Usage:  . .\scripts\Invoke-Mcp.ps1   then   Invoke-Mcp list_pending_reviews @{ limit = 1000 }
function Invoke-Mcp {
    param([string]$Name, [hashtable]$Arguments = @{}, [string]$Uri = "http://127.0.0.1:8787/mcp")
    $body = @{ jsonrpc = "2.0"; id = 1; method = "tools/call"; params = @{ name = $Name; arguments = $Arguments } } |
        ConvertTo-Json -Depth 10 -Compress
    Invoke-RestMethod -Method Post -Uri $Uri -ContentType "application/json" -Body $body `
        -Headers @{ Accept = "application/json, text/event-stream"; "MCP-Protocol-Version" = "2025-11-25" }
}