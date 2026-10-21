# Progress Log

## Session 1 (Oct 21, 2026)

### Completed
- Phase 1: Signed up for a fresh Developer Edition (Agentforce + Data Cloud edition)
- Phase 1: Created local project and connected it to VS Code / Salesforce CLI

### Environment
- Project folder: C:\Users\LukeStuard\Projects\safe-agent-gateway (git initialized)
- Structure: one repo; Salesforce source at root, Cloudflare Worker in /worker later
- Org alias: gatewayDev (project-local default)
- Instance URL: https://orgfarm-5ea30c60fa-dev-ed.develop.my.salesforce.com
- API version: 68.0

### Decisions
- Dedicated Dev Edition instead of a Trailhead Playground (clean slate, no badge clutter)
- Build the data model as source metadata in the repo, not in the UI

### Cautions
- Global default org is sandboxCopy (CIAM). Always run project commands from this folder so gatewayDev is used.
- Never commit .sfdx/ or .sf/ (auth info). Run git status before the first push.
- Confirm org expiration in Setup > Company Information.

### Next
- Generate Application object metadata (status, term, program, review notes) and fake sensitive fields on Contact (DOB, student ID) for redaction testing


## Phase 1 verification (2026-10-21)
- Client credentials token as Gateway Integration user: PASS
- Application__c visible to integration user: 210 records, no Draft (sharing rule works): PASS
- Contact query as integration user: initially FAIL (returned a record). The local permset still had
  Contact allowRead=true; the earlier edit was never saved. Fixed by setting allowRead=false explicitly.
  Retest returned 400 INVALID_TYPE: PASS
- Lessons: permset deploys don't revoke permissions omitted from the XML, so revocations must be stated
  explicitly as false. Verify file saves (git diff) before deploying. Permset description has a 255-character limit.
- Credentials: consumer key and secret stored in Windows Credential Manager (target SafeAgentGateway-SF),
  read by scripts/Get-GatewayToken.ps1. Bitwarden holds the master copy.

  ## Phase 2: get_program_summary (2026-10-21)
- Scaffolded Worker from cloudflare/ai remote-mcp-authless template; Inspector connected over Streamable HTTP (MCP 2025-11-25)
- Credentials: worker/.dev.vars generated from Credential Manager (gitignored, verified with git check-ignore)
- get_program_summary: aggregates only; groupBy and term are allowlisted enums mapped to fixed field names
- Default run: 16 program x term rows totaling 210: PASS
- groupBy status: 6 rows matching the Phase 1 counts, no Draft: PASS
- SOQL injection via raw JSON-RPC (term = "Fall 2026' OR Status__c = 'Draft"): rejected by schema validation, never reached Salesforce: PASS
- Note: Inspector's dropdown only enforces the allowlist on the client side; server-side validation was tested with a raw request

## Phase 2: list_pending_reviews (2026-10-21)
- Returns Submitted / In Review applications, oldest first; 5 fields via fixed output map (server-side redaction)
- Row cap 25, default 10; queries limit+1 to report truncated without returning extra rows
- Input schemas are .strict(), so unknown arguments are rejected rather than silently ignored
- Default run: 10 rows, truncated true, mixed statuses and programs, 5 fields each: PASS
- Status + program filters: PASS
- Raw limit=1000: rejected (max 25): PASS
- Raw status=Draft: rejected (not a pending status): PASS
- Raw fields=[Birthdate, Student_ID__c]: rejected (unrecognized key): PASS
- Added scripts/Invoke-Mcp.ps1 for raw JSON-RPC tests that bypass client-side validation