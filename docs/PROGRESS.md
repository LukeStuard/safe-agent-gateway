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