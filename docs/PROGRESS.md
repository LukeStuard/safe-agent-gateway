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

## Phase 2: get_application_status (2026-10-21)
- Lookup by application number only; input must match ^APP-\d{5}$
- Returns the 5 standard fields plus review notes, wrapped as untrusted data (labeled, capped at 2,000 chars)
- Not found and not visible return the same response, so the tool can't be used to discover hidden records
- APP-00065: found, notes returned inside reviewNotes with untrusted: true: PASS
- APP-00010 (Draft, exists in Salesforce): found: false: PASS
- APP-99999 (doesn't exist): found: false, same response as the Draft lookup: PASS
- Raw applicationId with SOQL injection: rejected by regex: PASS
- Raw includeFields=Birthdate: rejected (unrecognized key): PASS
- Prompt-injection fixture planted on APP-00065 Review_Notes__c for the Phase 4 agent test
- All three tools now use .strict() input schemas

## Phase 2 status: COMPLETE
Read tools: get_program_summary, list_pending_reviews, get_application_status
Controls verified: allowlisted inputs, row cap, output field allowlist, strict schemas, fail-closed errors, sharing enforced at the source

## Phase 3: OAuth (2026-10-21)
- Worker is now an OAuth 2.1 authorization server for MCP clients (@cloudflare/workers-oauth-provider 1.x);
  Salesforce is the upstream identity provider via a second External Client App ("Safe Agent Gateway Login")
- Login app: authorization code + PKCE + client secret, scopes openid and id only (no api, no refresh_token),
  so its tokens can't read data. Separate from the client credentials app: one app per trust boundary
- Gate 1 (Salesforce): Permitted Users = admin approved; Gateway_Agent_Access permission set required
- Gate 2 (gateway): per-client consent page before redirecting to Salesforce, because dynamic registration
  lets any client register and Salesforce pre-authorization would otherwise skip consent
- Callback checks organization_id against SF_ORG_ID; the Salesforce token is used once for /userinfo, then revoked
- Audit identity now comes from the OAuth grant (ctx.props), replacing "anonymous-local"
- Protected resource metadata: http://localhost:8788/mcp, scope gateway:read; dev port pinned to 8788
- Discovery metadata (RFC 9728 and RFC 8414): PASS
- Unauthenticated POST /mcp: 401 with resource_metadata challenge: PASS
- User without Gateway_Agent_Access: denied at Salesforce (OAUTH_APP_ACCESS_DENIED), no token issued: PASS
- Approved user: consent, Salesforce login, connected, get_program_summary returned 210: PASS
- Audit row identity = Salesforce username: PASS
- Cloudflare: Wrangler had been logged into the CIAM account; an empty gateway-audit D1 was created
  there and deleted. Project resources now live in a personal Cloudflare account, accessed with a scoped
  API token (Credential Manager target SafeAgentGateway-CF, loaded by scripts/Use-GatewayCloudflare.ps1)
- Lesson: re-run the tool after reconnecting before reading the audit log
- Next: swap hand-rolled consent/state code for the library's built-in helpers; garbage/expired token test;
  Invoke-Mcp.ps1 token support; rate limiting; add_review_note with approval

## Phase 3: audit log (2026-10-21)
- D1 database gateway-audit (binding AUDIT_DB); migration 0001 creates audit_log (metadata only)
- Audit wraps the /mcp endpoint, so it logs calls the SDK rejects before tool code runs
- Logged: allowed call (get_program_summary, summary "groups=6", no record data): PASS
- Logged: validation deny (limit=1000): PASS
- Test #5, unknown tool (delete_all_records): denied with JSON-RPC -32602 and logged: PASS
- JSON-RPC batch: rejected with 400 / -32600 before reaching tools: PASS
- Fail closed: audit table renamed, so the tool call was blocked with "Audit log unavailable": PASS
- Note: the Wrangler "Assertion failed ... async.c" message on Windows shutdown is harmless

## Phase 3: consent refactor (2026-10-21)
- Replaced hand-rolled consent, state, and cookie code with workers-oauth-provider 1.x helpers
  (describeConsent, beginConsent, approveConsent, denyConsent, isConsentRemembered, beginUpstream, finishUpstream)
- Gains: __Host- cookies, flow state encrypted in KV under a hashed key (the PKCE verifier was previously
  stored in plaintext), remembered approvals bound to client + redirect URI + resource + scopes
- Consent page shows client name, unverified-name notice (DCR), redirect host, local-app warning, scopes
- Consent page content per MCP spec: PASS
- Approve, Salesforce login, audit identity: PASS (__Host- cookies work on http://localhost in Chrome)
- Remembered consent skips the page on reconnect: PASS
- Deny returns access_denied to the client: PASS
- Replay of a used consent handle from the same browser: 400, not started in this browser: PASS
- Note: Back button cannot replay consent (no-cache headers force a fresh handle); replay was tested by
  resending the captured POST from DevTools on the gateway's own origin
- Lesson: check the installed library version's docs before writing code against it; the first
  implementation was written from 0.x memory and hand-rolled what 1.x already provides
  - Garbage bearer token on /mcp: 401 invalid_token, never reaches tool code: PASS
- Known gap: requests rejected by OAuthProvider (no token, bad token) never reach the audit
  wrapper, so they are refused but not logged. Test plan #1 requires both
- Environment: login app creds in Credential Manager (target SafeAgentGateway-Login); .dev.vars adds
  SF_LOGIN_CLIENT_ID, SF_LOGIN_CLIENT_SECRET, SF_ORG_ID, COOKIE_ENCRYPTION_KEY; wrangler vars add
  GATEWAY_ORIGIN; KV namespace OAUTH_KV
- Next: log OAuth rejections (test #1); Invoke-Mcp.ps1 token support; wrong-resource token test;
  rate limiting; add_review_note with approval