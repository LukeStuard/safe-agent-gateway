# Threat Model

Safe Agent Gateway lets AI agents work with institutional data (synthetic admissions applications in Salesforce) through a Model Context Protocol (MCP) server on Cloudflare Workers. This document describes what the gateway protects, who and what it defends against, where its trust boundaries are, and how each risk is controlled. Risks are mapped to the **OWASP Top 10 for LLM Applications (2026)**, with a cross-reference to the **OWASP Top 10 for Agentic Applications**.

Every control listed here was tested. Test numbers refer to [TEST_RESULTS.md](TEST_RESULTS.md).

## Design principles

1. **Never rely on the model.** Every control holds even if the agent is fully compromised by a prompt injection. Model behavior that helped during testing (declining an injected instruction, asking before writing) is recorded as a bonus, never counted as a control.
2. **Enforce at the source.** The most important limits live in Salesforce, not in gateway code. If the gateway itself were compromised, Salesforce would still refuse to expose Contact data, edit applications, or approve requests.
3. **Least privilege per trust boundary.** Separate credentials for separate jobs: one Salesforce app for data access, another for sign-in only, a dedicated integration user, and a dedicated reviewer role.
4. **Fail closed.** If Salesforce, the quota check, or the audit log is unavailable, the gateway returns no data.
5. **The audit log is metadata, never a second copy of the data.**

## System overview

```
AI agent (Claude, or any MCP client)
   │  OAuth 2.1 bearer token (issued by the gateway)
   ▼
Cloudflare Worker: Safe Agent Gateway
   ├─ Per-IP flood limit (approximate, binding)
   ├─ OAuth provider: token validation, consent, discovery metadata
   ├─ Rejection audit (refused tokens)
   ├─ Per-user tool limit (strict, Durable Object) + audit (D1)
   └─ MCP tools: get_program_summary, list_pending_reviews,
      get_application_status, add_review_note
   │  Client credentials (integration user)
   ▼
Salesforce Developer Edition org
   ├─ Application__c (sharing rule hides Drafts from the integration user)
   ├─ Contact (sensitive fields; no access for the integration user)
   └─ Review_Note_Request__c → approved by a different person → flow appends note
```

**Sign-in path:** the gateway is an OAuth 2.1 authorization server for MCP clients, and Salesforce is its upstream identity provider. A user must hold the `Gateway_Agent_Access` permission set in Salesforce and must approve the specific client on the gateway's consent page.

### Trust boundaries

| Boundary | What crosses it | What is trusted |
|----------|----------------|-----------------|
| Agent to gateway | Tool calls with model-generated arguments | Nothing. Every argument is validated against a strict schema |
| Salesforce data to agent | Record fields, including free-text review notes | Notes are labeled untrusted; output fields are allowlisted |
| Gateway to Salesforce | SOQL queries and record creation as the integration user | Salesforce permissions, sharing, and validation rules are the final authority |
| User to gateway (sign-in) | OAuth consent, Salesforce identity | Only identities from the gateway's own org, with the required permission set |

### Assets

| Asset | Sensitivity | Protection summary |
|-------|-------------|--------------------|
| Applicant personal data on Contact (birthdate, student ID) | High | Never reachable: no Contact access for the integration user |
| Application records | Moderate | Five allowlisted fields plus notes; Drafts hidden; per-call row cap; per-user rate limit |
| Review notes (free text) | Moderate, untrusted | Returned as labeled untrusted data, capped at 2,000 characters |
| Integrity of application records | High | No agent write path; changes require a second person's approval in Salesforce |
| Credentials (Salesforce client secrets, cookie key, Cloudflare token) | High | Cloudflare secrets in production; Windows Credential Manager locally; never written to disk or logs |
| Audit log | Moderate | Metadata only; free text redacted to length; fails closed for served calls |

### Threat actors

| Actor | Example |
|-------|---------|
| Compromised agent | A prompt injection in record data steers the agent toward bulk extraction or unauthorized writes |
| Malicious or careless authorized user | A staff member uses an agent to pull more data than their task needs |
| Unauthorized client | Anyone on the internet calling the public endpoint or registering an OAuth client |
| Compromised gateway | A bug or stolen deployment credential gives an attacker the gateway's Salesforce access |

## OWASP Top 10 for LLM Applications (2026)

### LLM01: Prompt Injection

**Threat:** Indirect prompt injection through record data. Review notes are free text written by staff or reachable by anyone upstream, and they enter the agent's context as tool output.

**Controls:**
- Notes are returned inside a structure marked `untrusted: true` with an instruction to treat them as data.
- Everything an injection could ask for is enforced outside the model: strict input schemas, a 25-row cap, allowlisted output fields, no Contact access, an approval gate on the only write, and a per-user rate limit.

**Evidence:** Test 4. A fixture in APP-00065 instructs the agent to request 1,000 rows plus birthdates and student IDs. The agent did not attempt it. Had it tried, the schema would have rejected `limit: 1000`, and the requested fields cannot be returned by any tool.

**Residual risk:**
- The agent silently omitted the injected text from its summaries, so a human would not learn that the record carries a payload. **Roadmap:** gateway-side flagging of instruction-like text.
- An injection can still steer the agent within allowed actions, such as partitioned listing (see LLM02).

### LLM02: Sensitive Information Disclosure

**Threat:** The agent, or anyone who controls it, extracts personal data or more records than a task requires.

**Controls:**
- **At the source:** the integration user has no Contact access (Salesforce returns `INVALID_TYPE`), and a sharing rule hides Draft applications.
- **At the gateway:** fixed output field maps (five fields plus notes), strict schemas that reject requests for extra fields, identical responses for "not found" and "not visible", and generic error messages.
- **In the audit log:** metadata only, with free-text arguments stored as their length.

**Evidence:** Tests 2 and 9; script tests for extra-field requests and hidden-record discovery.

**Residual risk:** The per-call row cap limits each call, not total disclosure. In test 3 the agent partitioned a request across 9 calls and retrieved all 98 pending applications. The exposed fields are low sensitivity and the user was authorized, but the effective ceiling is the per-user rate limit (10 calls of up to 25 rows per rolling minute). **Roadmap:** a per-user row budget enforced across calls in the same Durable Object.

### LLM03: Excessive Agency

**Threat:** The agent takes actions beyond what the user intended or approved: deleting data, writing records, or acting as someone else.

**Controls:**
- Four tools, three of them read-only. No delete, update, or arbitrary query capability.
- The only write, `add_review_note`, creates a proposal. A different person must approve it in Salesforce before anything changes. Salesforce enforces this:
  - The integration user can create requests but cannot edit them or write to applications.
  - Requesters cannot decide their own requests, administrators included.
  - Decisions are final.
  - A request's application and requester cannot change after creation.
- The requester's identity comes from the OAuth grant, never from agent input. A spoofed `requestedBy` argument is rejected.
- One pending request per application per requester, so a looping agent cannot flood the review queue.

**Evidence:** Tests 5 and 6, plus Salesforce-side verification of each rule.

**Residual risk:** A single scope (`gateway:read`) currently covers the write tool. **Roadmap:** a `gateway:write` scope granted at consent, so read-only agents do not see the write tool at all.

### LLM04: Supply Chain

**Threat:** Vulnerabilities in dependencies, especially the MCP SDK and OAuth library that sit on the request path.

**Controls:**
- `npm audit --omit=dev` separates runtime findings from dev tooling.
- During the project, four high-severity advisories in the MCP SDK packages were each assessed for actual exposure before patching. One was exploitable: a single authenticated request could exhaust memory during validation. The fix upgraded the Agents SDK and the MCP packages together at the exact versions the SDK pins, avoiding a duplicated SDK.
- A critical advisory in dev-only tooling (a code formatter) was fixed separately and confirmed not to ship.
- Library code is written against the installed version's documentation, not memory. An early implementation hand-rolled OAuth consent logic the installed library already provided, and was replaced.

**Residual risk:** Dependency monitoring is manual. **Roadmap:** automated dependency alerts.

### LLM05: Data and Model Poisoning

The gateway does not train or fine-tune models. The relevant form of this risk is **record poisoning**: an agent writing text into records that future agents will read, creating stored prompt injection.

**Controls:** The only write path requires a human to read and approve every proposed note. Notes are length-limited and reject control characters. Approved notes are still returned as untrusted data on later reads.

**Residual risk:** An approver could approve a note containing instruction-like text. The roadmap flagging item would surface this at approval time and at read time.

### LLM06: Unbounded Consumption

**Threat:** Excessive calls exhaust Salesforce API limits, Cloudflare free-tier quotas, or audit storage ("denial of wallet"), or support bulk extraction.

**Controls:**
- **Per-user tool limit:** 10 calls per rolling 60 seconds, enforced by a Durable Object (exact across all locations, fails closed).
- **Per-IP flood limit:** 60 requests per minute on every unauthenticated entry point (MCP, token, registration, authorize, callback). It runs before the audit layer, so a flood cannot exhaust audit storage.
- Per-call row cap of 25.

**Evidence:** Test 7. The first implementation used the Workers Rate Limiting binding, which enforced exactly in local development but allowed 15 of 15 agent calls and 30 of 30 parallel calls in production, because its counts are approximate and synchronized in the background. The limit was moved to a Durable Object and retested: exactly 10 allowed in production. The IP flood limit was verified with 70 parallel requests: 60 allowed, 10 refused, and only 60 audit rows written.

**Residual risk:** The per-IP limit is approximate by design, which is acceptable for flood protection. Requests from a shared egress (for example, all calls from a hosted agent platform) share one IP budget.

### LLM07: Misinformation

**Threat:** The agent tells the user something false about the system's state, such as reporting a note as added when it was only proposed, or inventing data the gateway did not return.

**Controls:**
- Tool responses state outcomes explicitly. Proposals say "The note has NOT been added to the application", and failures say "No data was returned".
- Refusals, including rate limits, are returned as tool results the model can read, with a retry time. An earlier version used HTTP 429, which the client did not pass to the model, so the agent had to guess at the cause.

**Evidence:** In tests 6, 7, and 8 the agent reported the true state: submitted for approval, rows missing due to the limit, and a Salesforce failure with no guessed numbers.

**Residual risk:** The model can still summarize incompletely, as the silent omission in test 4 shows.

### LLM08: Hidden Context Exposure

**Threat:** Exposure of secrets, credentials, or internal context through the agent.

**Controls:**
- No secrets are ever placed in tool output, tool descriptions, or error messages.
- The Salesforce sign-in token is used once to read the user's identity and is revoked immediately; it is never stored or passed to the client.
- The gateway rejects tokens it did not issue (token passthrough).
- Production secrets were uploaded through stdin, never written to disk.

**Evidence:** Test 1 (token passthrough refused).

### LLM09: Vector and Embedding Weaknesses

**Not applicable.** The gateway uses no retrieval-augmented generation, embeddings, or vector store. Data is retrieved by exact, validated queries.

### LLM10: Improper Output Handling

**Threat:** Model-generated output is passed to a downstream system unsafely. Here, the downstream system is Salesforce: tool arguments generated by the model become parts of SOQL queries and record fields.

**Controls:**
- No model-generated free text is ever spliced into SOQL. Arguments are enums mapped to fixed field names, or values matched against strict patterns (`^APP-\d{5}$`, Salesforce ID format) before use.
- The one free-text input (a proposed note) is stored as a field value through the REST API, never interpolated into a query.
- The consent page HTML-escapes client-supplied names.

**Evidence:** Script tests. SOQL injection through an enum argument and through an application ID was rejected by schema validation before reaching Salesforce.

## Threats beyond the LLM list

| Threat | Controls | Evidence |
|--------|----------|----------|
| Confused deputy through the OAuth proxy | Per-client consent page before redirecting to Salesforce; consent bound to browser cookies; single-use, encrypted flow state; remembered consent bound to client, redirect URI, resource, and scopes | Consent, deny, remembered-consent, and replay tests |
| Sign-in from another Salesforce org | The callback checks the org ID against the gateway's own org | Configured check |
| Self-registered clients impersonating known apps | Dynamically registered clients are labeled unverified on the consent page, with a warning when access goes to a local app | Consent page tests |
| Unauthenticated probing | Every refusal is logged with reason and whether a token was presented; tokens are never logged | Test 1 |
| Audit evasion | JSON-RPC batches are rejected so calls cannot hide inside them; refusals before the tool layer are logged by a separate wrapper | Script tests |
| Audit unavailability | Served calls are blocked if the audit write fails | Script test with the audit table removed |
| Gateway compromise | The blast radius is limited by Salesforce: read five fields and notes on non-Draft applications, and create pending requests. No Contact access, no application edits, no approvals | Salesforce-side tests (Test 6) |

### Containment

If an agent or user misbehaves, access can be cut off without code changes:
- Remove the user's `Gateway_Agent_Access` permission set, which blocks new sign-ins.
- Revoke their OAuth grants.
- Reject any pending review note requests.

The audit log shows exactly what each identity did.

## Cross-reference: OWASP Top 10 for Agentic Applications

| Agentic risk | Where it is addressed |
|--------------|----------------------|
| ASI01 Agent Goal Hijack | LLM01 controls; Test 4 |
| ASI02 Tool Misuse and Exploitation | Strict schemas, row cap, rate limit; Test 3 shows misuse within allowed bounds (partitioning) |
| ASI03 Identity and Privilege Abuse | Per-user OAuth identity from Salesforce; requester taken from the grant; dedicated least-privilege integration user; no self-approval |
| ASI04 Agentic Supply Chain Vulnerabilities | LLM04 dependency review |
| ASI05 Unexpected Code Execution | Not applicable: no tool executes code |
| ASI06 Memory and Context Poisoning | Record poisoning under LLM05; approval gate on writes |
| ASI07 Insecure Inter-Agent Communication | Not applicable: single agent, single gateway |
| ASI08 Cascading Failures | Fail closed on Salesforce, quota, and audit failures; Test 8 |
| ASI09 Human-Agent Trust Exploitation | Explicit outcome wording; approval by a second person; finding that the agent hid an injection from the user |
| ASI10 Rogue Agents | Rate limits, complete audit trail, containment by permission set and grant revocation |

## Accepted risks

| Risk | Reason accepted |
|------|----------------|
| An administrator can edit a proposed note before approval | Administrators can change any configuration; such changes are visible in Setup Audit Trail |
| The OAuth authorization code, which begins with the Salesforce user ID, appears in the callback URL and browser history | The code is single-use, short-lived, and bound to PKCE; Salesforce user IDs are not secrets |
| Client-side tool approval prompts can be turned off | The gateway never relies on them |
| The audit log lives in the same Cloudflare account as the gateway | Acceptable for a portfolio deployment; production use would ship logs to separate, append-only storage |

## Roadmap

| Item | Addresses |
|------|-----------|
| Per-user row budget across calls | LLM02, ASI02 (Test 3) |
| Flag instruction-like text in notes at approval and read time | LLM01, LLM05, ASI09 (Test 4) |
| Separate `gateway:write` scope | LLM03, ASI03 |
| Reviewer read access to applications, so approvers can check context | Approval quality |
| Automated dependency alerts | LLM04 |
| Audit log export to separate append-only storage | Audit integrity |
