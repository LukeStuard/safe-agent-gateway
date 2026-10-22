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

## Tooling: PowerShell 7 (2026-10-22)
- Installed PowerShell 7.6.7 (winget, Store/MSIX package); VS Code default terminal is now PowerShell 7
- Replaced the CredentialManager module with scripts/GatewayCredential.ps1 (Win32 CredRead via Add-Type),
  because the module is Windows PowerShell only. Same Credential Manager targets, nothing re-entered
- Get-GatewayToken.ps1 in PowerShell 7: token acquired, Application count 210: PASS
- Use-GatewayCloudflare.ps1 in PowerShell 7: wrangler whoami shows personal account via API token: PASS

## Tooling: Connect-Gateway OAuth client (2026-10-22)
- Replaced manual token copying (clipboard collided with copying commands) with a PowerShell OAuth client
  in Invoke-Mcp.ps1: endpoints from /.well-known/oauth-authorization-server, dynamic client registration
  as a public client (token_endpoint_auth_method none), PKCE S256, random state, resource indicator,
  loopback redirect http://127.0.0.1:33418/callback caught by a raw TCP listener (no admin URL ACL)
- Callback checks: state must match, iss must equal the gateway issuer, error parameter surfaced
- Only the client ID is saved (scripts/.gateway-client.json, gitignored). Refresh token stays in session memory
- Invoke-Mcp refreshes the session token before expiry and once on invalid_token; explicit -Token values
  are never refreshed, so negative tests stay honest. Set-GatewayToken kept as a masked-prompt fallback
- Consent page with a new client: shows "registered itself; name not verified" and the loopback warning: PASS
- Browser sign-in, callback, code exchange: connected: PASS
- Forced stale token: refreshed automatically, call succeeded, no browser: PASS
- Explicit garbage token: 401 invalid_token, not refreshed: PASS
- Threat model note: the authorization code (which begins with the Salesforce user ID, a library format)
  appears in the callback URL and browser history. Accepted: single-use, short-lived, PKCE-bound;
  Salesforce user IDs are not secrets

## Dependency review: MCP SDK advisories (2026-10-22)
- npm audit --omit=dev flagged 4 high advisories in runtime packages (agents 0.20.1, MCP server/client 2.0.0, sdk 1.30.0)
- agents pins its MCP peers to exact versions; upgrading @modelcontextprotocol/server alone would install two
  SDK copies and break types. Upgraded as a set: agents 0.30.0, server/client 2.3.1, sdk 1.32.1 (--save-exact)
- Exposure assessment before the fix:
  - SDK bearer auth accepting tokens for another service: not affected (auth is OAuthProvider; passthrough test proves it)
  - One request exhausting memory during validation: affected, reachable only with a gateway token. Rate limiting
    does not mitigate a single request. Fixed by the upgrade
  - Shared transport/server delivering one client's messages to another: likely not affected (new server and
    transport per POST). Patched anyway
  - Client SDK advisories (OAuth credentials sent to MCP-chosen server, cross-origin redirects): not affected,
    the gateway never acts as an MCP client
  - Experimental tasks not bound to session: not affected, tasks unused
- Verified: npm ls shows one copy of each MCP package and zod 4.6.7; tsc --noEmit clean; npm audit --omit=dev: 0
- Regression: program summary, pending reviews (10, truncated), APP-00065 notes untrusted, limit=1000 rejected,
  unknown tool rejected, no token 401: PASS
- Observed: reconnecting Inspector invalidated the previously copied access token (library revokes existing
  grants for the same user and client on re-authorization), so a leaked token dies at the owner's next sign-in
- Remaining dev-only finding: tinypool (critical) via oxfmt, the template's formatter. Not bundled into the
  Worker; fixed separately
- Also: Wrangler updated to 4.152.0 (separate commit)

## Deployment: production on workers.dev (2026-10-22)
- URL: https://safe-agent-gateway.lstua001.workers.dev (personal Cloudflare account, scoped API token)
- GATEWAY_ORIGIN in wrangler.jsonc is the production URL; .dev.vars overrides it to http://localhost:8788
  for wrangler dev (verified: local metadata still reports localhost)
- Remote D1 migration applied; production audit log starts empty
- Secrets uploaded with wrangler secret bulk via stdin, piped from Credential Manager (never written to disk).
  Production has its own freshly generated COOKIE_ENCRYPTION_KEY
- Salesforce login app: production /callback added alongside localhost
- Invoke-Mcp.ps1: GATEWAY_TARGET=prod switches target; one client registration per host; loading the script
  clears the session so tokens never cross environments
- Live regression: Connect-Gateway sign-in, no token 401, garbage token 401, program summary 6 rows,
  pending reviews 10 truncated, APP-00065 untrusted notes, limit=1000 rejected, unknown tool rejected,
  Salesforce token passthrough 401: PASS
- Production audit: 8 rows for 8 calls, correct identities: PASS
- Observed: production calls take about 0.4 to 1s versus about 2s locally, consistent with the Windows
  localhost IPv6 fallback suspected earlier

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

  ## Phase 3: OAuth rejection logging (2026-10-22)
- withRejectionAudit wraps OAuthProvider.fetch, so refusals that never reach withAudit are logged
- Logs only POST /mcp responses that are 401/403 with a Bearer challenge (the provider's own refusals),
  so a 403 from inside the MCP handler is not mislabeled as unauthenticated
- Row: identity "unauthenticated", tool name or (method), decision deny, reason = challenge error code
  plus whether a token was presented. The token value is never logged
- Not fail closed on this path: the caller is already refused, so a failed write is only reported
- No token: 401, logged "HTTP 401: no error code (no token)": PASS
- Garbage token: 401 invalid_token, logged "HTTP 401: invalid_token (token presented)": PASS
- Authenticated call after the change: one allow row with Salesforce username, no duplicate: PASS
- Test plan #1: COMPLETE
- Threat model notes: every unauthenticated POST costs a D1 write (rate limit must sit in front);
  normal MCP clients send an unauthenticated initialize on connect, so expect (initialize) deny rows
- Environment: machine is on Windows PowerShell 5.1; use curl.exe for raw HTTP tests until PowerShell 7

## Phase 3: Invoke-Mcp.ps1 token support (2026-10-22)
- Rewritten for PowerShell 7: bearer token from $env:GATEWAY_TOKEN, Set-GatewayToken loads it from the
  clipboard (shape-checked, clipboard cleared), -NoToken and -Token overrides, -SkipHttpErrorCheck so
  401/403 return as data, tool payload unwrapped into Data. Default URL http://localhost:8788/mcp
- No token: 401 with resource_metadata challenge: PASS
- Garbage token: 401 invalid_token: PASS
- Valid gateway token: get_program_summary by status, 6 rows matching Phase 1, no Draft: PASS
- Valid gateway token, limit=1000: rejected at schema (<=25), IsError true: PASS
- Token passthrough: a valid Salesforce access token (integration user, same org) presented to /mcp:
  401 invalid_token. The gateway accepts only tokens it issued (MCP spec: no token passthrough): PASS
- Wrong-resource test replaced by token passthrough: the gateway protects a single resource, so a
  different-audience token can't be minted without adding a route just for the test
- Lesson: Set-GatewayToken read a pasted command block from the clipboard; it now rejects anything
  that isn't token-shaped

  ## Phase 3: rate limiting (2026-10-22)
- Workers Rate Limiting binding (ratelimits in wrangler.jsonc), two limiters with separate namespaces:
  - TOOL_RATE_LIMITER (1001): 10 tools/call per 60s per Salesforce user ID, inside withAudit. Counts invalid
    and unknown-tool calls too. Refusal: HTTP 429, Retry-After 60, JSON-RPC -32000, audited as deny
  - IP_RATE_LIMITER (1002): 60 requests per 60s per IP on /mcp, /token, /register, /authorize, /callback,
    outermost wrapper (withIpLimit in ratelimit.ts). Refusal: 429, Retry-After 60, deliberately not audited
- Order: IP limit > token check + rejection audit > per-user limit + audit > tools
- audit.ts: insert factored into writeAudit (three call sites)
- Test #7, per-user: 25 sequential calls; 10 allowed in the 11:16 window, then 429 for the rest: PASS
- Finding: limits use fixed windows aligned to the clock minute (first run allowed 11 around the 11:16:00
  boundary). A burst straddling a boundary can reach 2x the limit. Acceptable for an abuse control;
  a strict limit would need a Durable Object (Cloudflare docs)
- IP limit: 70 parallel unauthenticated requests in one window: 60 x 401, 10 x 429: PASS
- Audit: exactly 60 rows for that burst; IP-limited requests never reached D1: PASS
- Caught by test: the first IP run returned 70 x 401 because withIpLimit was never wired into index.ts
  (tsc passes either way). Lesson: verify wiring with a behavior test, not just a typecheck
- Note: each local request takes about 2s, including 429s that never touch Salesforce; suspect localhost
  IPv6 fallback on Windows. Sequential tests can't reach the IP limit, so the IP test runs in parallel
- Test plan: 5 of 9 passed (#1, #2, #3, #5, #7)

## Phase 3: add_review_note approval gate, Salesforce side (2026-10-22)
- Design: approval lives in Salesforce. The gateway will only create Review_Note_Request__c records;
  a different staff member approves in Salesforce, and a flow appends the note to the application
- Review_Note_Request__c (RNR-#####): Application (required lookup), Proposed_Note__c (1,000),
  Requested_By__c (User, from the gateway's OAuth identity), Status__c (Pending/Approved/Rejected,
  history tracked), Decided_By__c, Decided_On__c. Org-wide Read/Write; object permissions decide who edits
- Validation rules: No_Self_Decision (requester can't approve or reject, admins included),
  Decision_Is_Final, New_Request_Must_Be_Pending
- Flows: Stamp Decision (before-save: Decided_By, Decided_On); Apply Approved Note (after-save,
  Status changed to Approved: appends "[date | RNR | requested by | approved by] note" to Review_Notes__c)
- Permission sets: Gateway_Integration create + read on requests, no edit, Status read-only, still no edit
  on Application. New Gateway_Reviewer: edit Status only, read-only on Application (flow runs in system
  context). Gateway_Admin full access. Reviewer user on a Salesforce Platform license, no Gateway_Agent_Access
- Integration user describe: createable True, updateable False, deletable False: PASS
- A. Integration user creates request RNR-00001 (Pending by default): PASS
- B1. Integration user approves its own request: CANNOT_INSERT_UPDATE_ACTIVATE_ENTITY (no Edit): PASS
- B2. Integration user writes the note directly to the application: CANNOT_INSERT_UPDATE_ACTIVATE_ENTITY: PASS
- B3. Integration user creates an already-approved request: INVALID_FIELD_FOR_INSERT_UPDATE (field-level
  security stops it before the validation rule): PASS
- C. Requester (System Administrator) approves own request: blocked by No_Self_Decision: PASS
- D. Reviewer approves: saved, Decided By and Decided On stamped, note appended to APP-00065 with full
  attribution, prompt-injection fixture untouched, Last Modified By = reviewer: PASS
- E. Reviewer changes Approved to Rejected: blocked by Decision_Is_Final: PASS
- Lessons: metadata-deployed fields get no field access, even for admins (Flow Builder couldn't see
  Status until Gateway_Admin granted it). A read-only setting on a page layout is not a control: the
  System Administrator "Edit Read Only Fields" permission overrides it
- Known gaps (threat model): an admin can edit Proposed_Note__c before approval (accepted). Application__c
  is required, so field-level security can't lock it, and a reviewer could repoint a pending request to
  another application before approving; a validation rule would close this
- Next: add_review_note tool in the gateway (requires salesforce.ts create support)

## Phase 3: add_review_note tool, gateway side (2026-10-22)
- add_review_note creates a Review_Note_Request__c only; it never writes to the application. The response
  tells the agent explicitly that the note has NOT been added and needs a different staff member's approval
- Requester comes from the OAuth grant (ctx.props.userId), never from agent input; createServer now
  receives the caller's identity
- One pending request per application per requester (a repeat returns the existing request number)
- salesforce.ts: shared sfFetch (401 refresh-once); sfCreate typed to Review_Note_Request__c only
- Audit: free-text arguments are redacted to their length ([redacted: N chars]) in every audit path;
  summary records request number and status
- 1. Propose note on APP-00065: pending_approval, RNR-00002: PASS
- 2. Repeat: already_pending, same RNR-00002, nothing created: PASS
- 3. Application unchanged before approval: PASS
- 4. Spoofed requester (requestedBy argument): rejected by strict schema: PASS
- 5. Draft application APP-00010: found false, same as nonexistent: PASS
- 6. 1,001-character note: rejected at schema: PASS
- 7. Audit rows show [redacted: N chars], no note text stored: PASS
- 8. Reviewer approves RNR-00002; note appears on APP-00065 via get_application_status: PASS
- Test plan #6 (write without approval): COMPLETE. Test plan: 6 of 9 passed (#1, #2, #3, #5, #6, #7)
- Invoke-Mcp.ps1: Set-GatewayToken now prompts (masked) instead of reading the clipboard, which collided
  with copying commands; -ErrorAction Stop on transport errors
- Known gap: one scope (gateway:read) covers the write tool; a gateway:write scope would hide it from
  read-only agents. The approval gate holds regardless
- Phase 3: COMPLETE
- Next: Connect-Gateway (PowerShell OAuth client: DCR, PKCE, loopback, refresh), then Phase 4